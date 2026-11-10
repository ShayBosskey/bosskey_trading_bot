import { useEffect, useState } from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Cpu, MemoryStick, HardDrive, Thermometer } from 'lucide-react';

import { HEALTH_COLOR, GRID_COLOR, AXIS_TEXT_COLOR } from './chartPalette';

const POLL_MS = 10_000;
const HISTORY_POINTS = 60; // 10 minutes at one sample per 10s

const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

// Plain-language thresholds. Pi 4 firmware throttles at 80°C, so 70°C is the
// early warning; storage and memory warn at 80% and go critical at 90%.
function level(value, warn, crit) {
  if (value == null) return 'unknown';
  if (value >= crit) return 'crit';
  if (value >= warn) return 'warn';
  return 'ok';
}

const LEVEL_STYLE = {
  ok: { bar: 'bg-shefa-violet', text: 'text-white' },
  warn: { bar: 'bg-amber-500', text: 'text-amber-400' },
  crit: { bar: 'bg-red-500', text: 'text-red-400' },
  unknown: { bar: 'bg-gray-700', text: 'text-gray-500' },
};

function Meter({ icon: Icon, label, value, detail, warn = 80, crit = 90, unit = '%', max = 100 }) {
  const lv = level(value, warn, crit);
  const style = LEVEL_STYLE[lv];
  const width = value == null ? 0 : Math.min(100, (value / max) * 100);
  return (
    <div className="bg-shefa-bg rounded-xl p-3 md:p-4 border border-gray-800/60">
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="flex items-center gap-2 text-gray-400 text-xs font-semibold uppercase tracking-wider">
          <Icon size={14} className="text-shefa-accent shrink-0" />
          {label}
        </span>
        <span className={`font-bold tabular-nums ${style.text}`}>
          {value == null ? 'n/a' : `${value}${unit}`}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-gray-800 overflow-hidden" role="meter" aria-label={label} aria-valuenow={value ?? undefined} aria-valuemin={0} aria-valuemax={max}>
        <div className={`h-full rounded-full transition-all duration-500 ${style.bar}`} style={{ width: `${width}%` }} />
      </div>
      {detail && <p className="text-gray-500 text-xs mt-2 tabular-nums">{detail}</p>}
    </div>
  );
}

function CpuTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="bg-shefa-bg border border-gray-800 rounded-lg px-3 py-2 text-xs shadow-lg">
      <p className="text-gray-400">{p.time}</p>
      <p className="text-white font-semibold">CPU {p.cpu}%</p>
    </div>
  );
}

export default function SystemHealthPanel() {
  const [health, setHealth] = useState(null);
  const [history, setHistory] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch('/api/v1/system/health');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        setHealth(data);
        setError(null);
        if (data.cpu?.usagePct != null) {
          const time = new Date(data.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
          setHistory((h) => [...h, { time, cpu: data.cpu.usagePct }].slice(-HISTORY_POINTS));
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    };
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const uptimeDays = health ? (health.host.uptimeSec / 86400).toFixed(1) : null;

  return (
    <section className="bg-shefa-panel rounded-2xl p-4 md:p-6 shadow-lg border border-gray-800 mt-6 md:mt-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-5">
        <h2 className="text-lg md:text-xl font-bold">Infrastructure Telemetry</h2>
        <span className="text-gray-500 text-xs">
          {error
            ? <span className="text-red-400">Telemetry unavailable ({error})</span>
            : health
              ? `${health.host.arch} · ${health.host.cores} cores · up ${uptimeDays}d · load ${health.cpu.load['1m']} / ${health.cpu.load['5m']} / ${health.cpu.load['15m']}`
              : 'Reading sensors…'}
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4 mb-5">
        <Meter icon={Cpu} label="CPU" value={health?.cpu.usagePct ?? null} detail="Average since last poll" />
        <Meter
          icon={MemoryStick}
          label="RAM"
          value={health?.memory.usedPct ?? null}
          detail={health ? `${gb(health.memory.usedBytes)} of ${gb(health.memory.totalBytes)}` : null}
        />
        <Meter
          icon={HardDrive}
          label="Disk /"
          value={health?.disk?.usedPct ?? null}
          detail={health?.disk ? `${gb(health.disk.availableBytes)} free of ${gb(health.disk.totalBytes)}` : null}
        />
        <Meter
          icon={Thermometer}
          label="SoC temp"
          value={health?.cpu.tempC ?? null}
          unit="°C"
          warn={70}
          crit={80}
          detail="Pi 4 throttles at 80°C"
        />
      </div>

      <div className="h-32">
        {history.length < 2 ? (
          <p className="text-gray-500 text-sm">Collecting CPU history…</p>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={history} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="cpuFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={HEALTH_COLOR} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={HEALTH_COLOR} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={GRID_COLOR} vertical={false} />
              <XAxis dataKey="time" tick={{ fill: AXIS_TEXT_COLOR, fontSize: 10 }} axisLine={false} tickLine={false} minTickGap={40} />
              <YAxis domain={[0, 100]} ticks={[0, 50, 100]} tickFormatter={(v) => `${v}%`} tick={{ fill: AXIS_TEXT_COLOR, fontSize: 10 }} axisLine={false} tickLine={false} width={36} />
              <Tooltip content={<CpuTooltip />} cursor={{ stroke: GRID_COLOR }} />
              <Area type="monotone" dataKey="cpu" stroke={HEALTH_COLOR} strokeWidth={2} fill="url(#cpuFill)" isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
      <p className="text-gray-500 text-xs mt-2">CPU load, last 10 minutes (kept in this browser tab only)</p>
    </section>
  );
}
