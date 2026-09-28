const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// Turns text into a sound file Asterisk can play, and returns the name to pass
// to Playback()/STREAM FILE. Output is 16 kHz raw signed-linear (.sln16), which
// Asterisk plays natively without any codec module.
class SpeechSynthesizer {
    constructor({ piper, audioDir, voiceTag = '', ffmpegPath = 'ffmpeg' }) {
        this.piper = piper;
        this.audioDir = audioDir;
        this.voiceTag = voiceTag;
        this.ffmpegPath = ffmpegPath;
    }

    // `name` is optional; without it the file is cached by a hash of the text,
    // so fixed prompts ("One moment, sir.") are only synthesized once.
    async render(text, name = null) {
        const baseName = name || `tts-${crypto.createHash('sha1').update(`${this.voiceTag}|${text}`).digest('hex').slice(0, 16)}`;
        const finalPath = path.join(this.audioDir, `${baseName}.sln16`);

        if (!name && await this.#exists(finalPath)) return `escalation/${baseName}`;

        const audio = await this.piper.synthesize(text);
        if (audio.width !== 2) throw new Error(`Unsupported Piper sample width: ${audio.width} bytes.`);

        await fs.mkdir(this.audioDir, { recursive: true });
        const tmpPath = `${finalPath}.tmp`;
        await this.#resample(audio, tmpPath);
        await fs.rename(tmpPath, finalPath);

        return `escalation/${baseName}`;
    }

    #resample({ rate, channels, pcm }, outPath) {
        return new Promise((resolve, reject) => {
            const ff = spawn(this.ffmpegPath, [
                '-hide_banner', '-loglevel', 'error',
                '-f', 's16le', '-ar', String(rate), '-ac', String(channels), '-i', 'pipe:0',
                '-ar', '16000', '-ac', '1', '-f', 's16le', '-y', outPath
            ]);
            let stderr = '';
            ff.stderr.on('data', (d) => { stderr += d; });
            ff.on('error', reject);
            ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`))));
            ff.stdin.end(pcm);
        });
    }

    async #exists(p) {
        try {
            await fs.access(p);
            return true;
        } catch {
            return false;
        }
    }
}

module.exports = SpeechSynthesizer;
