const fs = require('fs/promises');
const path = require('path');
const { HangupError } = require('./AgiChannel');
const { ACTIONS } = require('./CommandParser');

// The conversation, after the dialplan has already played the alert:
//   menu -> record your reply -> transcribe -> classify -> confirm with keypad -> act.
// Nothing that changes the bot's state happens without you pressing 1.
const LINES = {
    menu: 'How would you like me to proceed, sir? After the tone, you may say: halt trading, switch to paper, status report, or acknowledge.',
    retry: 'I beg your pardon, sir, I did not quite catch that. Please say: halt trading, switch to paper, status report, or acknowledge.',
    moment: 'One moment, sir.',
    anythingElse: 'Is there anything else, sir? Please speak after the tone.',
    giveUp: 'I am afraid I could not understand your instructions. I shall leave everything as it is and send the details to your phone. Goodbye, sir.',
    acknowledged: 'Very good, sir. I shall leave everything exactly as it is. Goodbye.',
    cancelled: 'Very well, sir. Nothing has been changed. Goodbye.',
    confirm: {
        [ACTIONS.HALT_TRADING]: 'You wish me to halt all trading. The bot will be placed in construction mode. Existing positions and their stop orders will remain in place. Press 1 to confirm, or any other key to cancel.',
        [ACTIONS.SWITCH_TO_PAPER]: 'You wish me to move the bot to paper trading. Press 1 to confirm, or any other key to cancel.'
    },
    done: {
        [ACTIONS.HALT_TRADING]: 'Done, sir. Trading has been halted. The bot is now in construction mode. Goodbye.',
        [ACTIONS.SWITCH_TO_PAPER]: 'Done, sir. The bot is now in paper trading mode. Goodbye.'
    },
    actionFailed: 'I am terribly sorry, sir, but the bot refused the command. Please check the dashboard as soon as you are able. Goodbye.'
};

const TARGET_MODE = {
    [ACTIONS.HALT_TRADING]: 'CONSTRUCTION',
    [ACTIONS.SWITCH_TO_PAPER]: 'PAPER'
};

const MAX_TURNS = 3;
// Built into asterisk-sounds-en (Asterisk's own misspelling), used if Piper is down.
const FALLBACK_SOUND = 'an-error-has-occured';

class EscalationCall {
    constructor({ channel, escalationId, synth, whisper, parser, actions, audioDir, asteriskAudioDir }) {
        this.channel = channel;
        this.id = escalationId;
        this.synth = synth;
        this.whisper = whisper;
        this.parser = parser;
        this.actions = actions;
        this.audioDir = audioDir;
        this.asteriskAudioDir = asteriskAudioDir;
        this.recordingCount = 0;
    }

    log(msg) {
        console.log(`[Call ${this.id}] ${msg}`);
    }

    async run() {
        try {
            await this.#converse();
        } catch (err) {
            if (err instanceof HangupError) {
                this.log('Caller hung up.');
            } else {
                console.error(`[Call ${this.id}] Conversation failed: ${err.message}`);
                try {
                    await this.channel.streamFile(FALLBACK_SOUND);
                } catch {
                    // Nothing left to tell them.
                }
            }
        } finally {
            await this.channel.hangup();
            this.channel.close();
        }
    }

    async #converse() {
        let prompt = LINES.menu;

        for (let turn = 1; turn <= MAX_TURNS; turn++) {
            const transcript = await this.#listen(prompt);
            const { action, via } = transcript ? await this.parser.parse(transcript) : { action: ACTIONS.UNKNOWN, via: 'none' };
            this.log(`Heard "${transcript}" -> ${action} (via ${via})`);

            if (action === ACTIONS.UNKNOWN) {
                prompt = LINES.retry;
                continue;
            }
            if (action === ACTIONS.ACKNOWLEDGE) return this.#say(LINES.acknowledged);
            if (action === ACTIONS.STATUS_REPORT) {
                await this.#say(await this.#describeStatus());
                prompt = LINES.anythingElse;
                continue;
            }
            return this.#confirmAndExecute(action);
        }

        return this.#say(LINES.giveUp);
    }

    async #listen(prompt) {
        await this.#say(prompt);

        const baseName = `rec-${this.id}-${++this.recordingCount}`;
        await this.channel.recordFile(path.posix.join(this.asteriskAudioDir, baseName));
        const localPath = path.join(this.audioDir, `${baseName}.wav`);

        try {
            const { size } = await fs.stat(localPath);
            // < ~0.3 s of 8 kHz audio: nothing was said.
            if (size < 5000) return '';
            await this.#say(LINES.moment);
            return await this.whisper.transcribe(localPath);
        } catch (err) {
            if (err instanceof HangupError) throw err;
            console.error(`[Call ${this.id}] Transcription failed: ${err.message}`);
            return '';
        } finally {
            // Voice recordings are only needed until they're transcribed.
            await fs.rm(localPath, { force: true });
        }
    }

    async #confirmAndExecute(action) {
        const digit = await this.channel.getData(await this.synth.render(LINES.confirm[action]), 8000, 1);
        if (digit !== '1') {
            this.log(`${action} not confirmed (pressed "${digit}").`);
            return this.#say(LINES.cancelled);
        }

        try {
            await this.actions.setMode(TARGET_MODE[action]);
            this.log(`${action} executed: SYSTEM_MODE -> ${TARGET_MODE[action]}.`);
            return this.#say(LINES.done[action]);
        } catch (err) {
            console.error(`[Call ${this.id}] ${action} failed: ${err.message}`);
            return this.#say(LINES.actionFailed);
        }
    }

    async #describeStatus() {
        try {
            const { mode, isTradingAllowed } = await this.actions.status();
            return `The bot is in ${String(mode).toLowerCase()} mode, and trading is currently ${isTradingAllowed ? 'enabled' : 'disabled'}.`;
        } catch (err) {
            console.error(`[Call ${this.id}] Status lookup failed: ${err.message}`);
            return 'I am afraid I cannot reach the bot to check its status. It may be down entirely.';
        }
    }

    async #say(text) {
        await this.channel.streamFile(await this.synth.render(text));
    }
}

module.exports = { EscalationCall, LINES };
