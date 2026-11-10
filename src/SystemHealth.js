// Host telemetry for the dashboard: CPU, RAM, root-disk usage and SoC temperature.
//
// Zero dependencies on purpose. `os` covers CPU and RAM, `fs.statfs` (Node 18.15+)
// returns the same numbers `df` prints without spawning a shell or parsing text,
// and the thermal zone is a single sysfs read. Works unchanged on the Pi 4 and on
// any other Linux host (e.g. the future Mac Mini); fields a host cannot report come
// back as null rather than failing the whole snapshot.
const os = require('os');
const fs = require('fs/promises');

const THERMAL_ZONE = '/sys/class/thermal/thermal_zone0/temp';

function cpuTimes() {
    let idle = 0;
    let total = 0;
    for (const cpu of os.cpus()) {
        const t = cpu.times;
        idle += t.idle;
        total += t.user + t.nice + t.sys + t.idle + t.irq;
    }
    return { idle, total };
}

let lastSample = null;

// Busy % across all cores since the previous call, so a dashboard polling every
// 10s sees the average over those 10s, not one instant. The first call (or one
// after a long gap) takes a short 250ms sample instead.
async function cpuUsagePct() {
    let prev = lastSample;
    if (!prev || Date.now() - prev.at > 60_000) {
        prev = { ...cpuTimes(), at: Date.now() };
        await new Promise(r => setTimeout(r, 250));
    }
    const now = { ...cpuTimes(), at: Date.now() };
    lastSample = now;
    const totalDelta = now.total - prev.total;
    if (totalDelta <= 0) return null;
    return round1((1 - (now.idle - prev.idle) / totalDelta) * 100);
}

async function diskUsage(mount = '/') {
    try {
        const s = await fs.statfs(mount);
        const total = s.blocks * s.bsize;
        const used = (s.blocks - s.bfree) * s.bsize;
        const available = s.bavail * s.bsize;
        // Same formula as df's Use%: blocks reserved for root count as neither.
        return { mount, totalBytes: total, usedBytes: used, availableBytes: available, usedPct: round1(used / (used + available) * 100) };
    } catch {
        return null;
    }
}

async function cpuTempC() {
    try {
        const milli = parseInt(await fs.readFile(THERMAL_ZONE, 'utf8'), 10);
        return Number.isFinite(milli) ? round1(milli / 1000) : null;
    } catch {
        return null;
    }
}

function round1(n) {
    return Math.round(n * 10) / 10;
}

async function snapshot() {
    const [cpuPct, disk, tempC] = await Promise.all([cpuUsagePct(), diskUsage('/'), cpuTempC()]);
    const totalMem = os.totalmem();
    // On Linux, os.freemem() reports MemAvailable (page cache counts as free), the
    // figure that matters for "will the next process fit".
    const usedMem = totalMem - os.freemem();
    const [load1, load5, load15] = os.loadavg();
    return {
        timestamp: new Date().toISOString(),
        host: { platform: os.platform(), arch: os.arch(), cores: os.cpus().length, uptimeSec: Math.round(os.uptime()) },
        cpu: { usagePct: cpuPct, load: { '1m': round1(load1 * 100) / 100, '5m': round1(load5 * 100) / 100, '15m': round1(load15 * 100) / 100 }, tempC },
        memory: { totalBytes: totalMem, usedBytes: usedMem, usedPct: round1(usedMem / totalMem * 100) },
        disk,
    };
}

module.exports = { snapshot, diskUsage, cpuTempC };
