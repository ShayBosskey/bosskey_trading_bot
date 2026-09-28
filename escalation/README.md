# Voice Escalation Stack

When the trading bot crashes, this stack **phones you** over Tailscale. A British
butler voice reads you the error, you say what to do, and after you confirm on the
keypad it carries out the command. Everything runs locally on the Pi; nothing here
costs money or calls a paid API.

```
bot crashes ─► ErrorHandler ─► VoiceEscalator ──POST /escalate──► bridge (Node)
                                                                    │ 1. Piper renders the alert audio
                                                                    │ 2. writes a .call file into Asterisk's spool
                                                                    ▼
                           your phone ◄──── SIP over Tailscale ──── asterisk
                                                                    │ on answer: plays the alert, then FastAGI ─► bridge
                                                                    ▼
          bridge: "How would you like me to proceed, sir?" ─► records you ─► whisper.cpp (speech → text)
                  ─► keyword match / Ollama (text → one allowed action) ─► "Press 1 to confirm"
                  ─► bot Dashboard API (POST /api/v1/system/mode)
```

| Service    | Image                                   | Job                                      | Reachable at                         |
|------------|-----------------------------------------|------------------------------------------|--------------------------------------|
| `asterisk` | built from `asterisk/` (Alpine, Ast. 20)| SIP server, dials your phone             | Tailscale IP, UDP 5060 + 10000–10100 |
| `piper`    | `lscr.io/linuxserver/piper`             | Text → speech (`en_GB-alan-medium`)      | internal only (Wyoming, 10200)       |
| `whisper`  | built from `whisper/` (whisper.cpp v1.9.4)| Speech → text                          | internal only (HTTP, 8080)           |
| `ollama`   | `ollama/ollama`                         | Maps free-form speech to one action      | internal only (HTTP, 11434)          |
| `bridge`   | built from `bridge/` (Node 22)          | Glue: HTTP API, .call files, the call    | `127.0.0.1:3100` (API), `127.0.0.1:4573` (AGI) |

## What a phone call can and can't do

The model never runs commands. It only picks one entry from a fixed list, and anything
that changes the bot still needs you to **press 1**:

| You say (for example)            | Action            | Effect                                                     |
|----------------------------------|-------------------|------------------------------------------------------------|
| "Halt trading", "stop everything"| `HALT_TRADING`    | `SYSTEM_MODE=CONSTRUCTION` after you press 1               |
| "Switch to paper"                | `SWITCH_TO_PAPER` | `SYSTEM_MODE=PAPER` after you press 1                      |
| "Status report"                  | `STATUS_REPORT`   | Reads the current mode back to you (read-only)             |
| "Acknowledged", "leave it"       | `ACKNOWLEDGE`     | Nothing changes                                            |

- **PRODUCTION can't be reached from a call.** `BotActions.js` refuses it no matter what was transcribed.
- **Halting doesn't close positions.** Open positions and their GTC stop/take-profit orders stay at Alpaca. Only new trades stop.
- Clear phrases are matched by keywords (instant). Anything else, or anything with a negation ("*don't* stop trading"), goes to the LLM.
- Your recordings are deleted as soon as they're transcribed.
- A **cooldown** (15 min by default) stops a crash-looping bot from ringing you non-stop.

---

## Deployment guide

### Step 0 — Your phone

1. Install **Tailscale** on the phone, sign in to the same tailnet as the Pi, and leave it connected.
   On Android, turn on *Always-on VPN* for Tailscale in system settings.
2. Install a SIP app. **Recommended: Linphone** (free, Android and iOS).
3. **Important for incoming calls:** phones suspend background apps.
   - **Android:** in the SIP app's settings turn on "keep alive" / "run in background", and in Android settings set its battery usage to *Unrestricted*. Do the same for Tailscale.
   - **iOS:** iOS kills background SIP apps, and free apps then can't receive calls from your own server. That's an Apple restriction. Reliable ringing on iPhone needs a push-capable client, and those are paid and route the wake-up through the vendor's servers. With a free setup, Android is the dependable option.

### Step 1 — Install Docker on the Pi

This targets 64-bit Raspberry Pi OS / Debian (this Pi runs Debian 13 "trixie", arm64).

```bash
# Official Docker install script (sets up Docker Engine + the Compose plugin)
curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
sudo sh /tmp/get-docker.sh

# Let your user run docker without sudo, then log out and back in (or reboot)
sudo usermod -aG docker $USER

# After logging back in, check it works:
docker run --rm hello-world
docker compose version

# Start Docker automatically at boot (the installer usually does this already)
sudo systemctl enable --now docker
```

> **New to Docker?** An *image* is a packaged app. A *container* is a running copy of one.
> A *volume* is a folder Docker manages that survives restarts and rebuilds.
> `docker-compose.yml` lists all five containers, so one command starts or stops the whole stack.

### Step 2 — Configure the stack

The files are already in `~/bosskey_trading_bot/escalation/`. Nothing needs to move.

```bash
cd ~/bosskey_trading_bot/escalation
cp env.example .env
tailscale ip -4                 # confirm the Pi's Tailscale IP -> TAILSCALE_IP
openssl rand -hex 16            # -> SIP_PASSWORD
openssl rand -hex 32            # -> ESCALATION_TOKEN
grep ADMIN_API_TOKEN ../.env    # copy its value -> BOT_ADMIN_TOKEN
nano .env                       # paste the values above in place of CHANGE_ME
chmod 600 .env
```

Then tell the **bot** how to reach the bridge. Add these two lines to `~/bosskey_trading_bot/.env`
(use the same `ESCALATION_TOKEN` value):

```bash
ESCALATION_BRIDGE_URL=http://127.0.0.1:3100
ESCALATION_TOKEN=<same value as in escalation/.env>
```

`ADMIN_API_TOKEN` in the bot's `.env` must be set (32+ chars), otherwise the Dashboard API
refuses the halt command and the butler will tell you so on the call.

### Step 3 — Launch

```bash
cd ~/bosskey_trading_bot/escalation
docker compose build            # builds the asterisk, whisper and bridge images (~15 min on a Pi 4)
docker compose up -d            # starts all five containers in the background
docker compose ps               # every service should show "running" / "Up"
docker compose logs -f bridge   # watch warm-up; Ctrl+C stops watching (the stack keeps running)
```

The first start downloads roughly 2–3 GB: images, the Ollama model (~1 GB), the Whisper
model (~140 MB) and the Piper voice (~60 MB). Wait for this line in the bridge log:

```
[Bridge] Warm-up complete: model ready, prompts rendered.
```

It retries every 20 s while Piper or Ollama are still downloading, so a few "not ready yet"
lines at the start are normal.

### Step 4 — Connect the phone

In the SIP app, add an account:

| Field     | Value                                   |
|-----------|-----------------------------------------|
| Username  | `mobile` (your `SIP_USERNAME`)          |
| Password  | your `SIP_PASSWORD`                     |
| Domain / server | `100.82.40.78` (your `TAILSCALE_IP`) |
| Transport | **UDP**                                 |

The app should show *Registered* / *Online*. Check from the Pi:

```bash
docker compose exec asterisk asterisk -rx "pjsip show contacts"   # your phone should be listed as Avail
```

**Test audio:** dial **600** from the phone. You should hear a prompt and then your own voice
echoed back. If you can, SIP and audio both work.

### Step 5 — Fire a test escalation

```bash
TOKEN=$(grep ^ESCALATION_TOKEN= ~/bosskey_trading_bot/escalation/.env | cut -d= -f2)
curl -X POST http://127.0.0.1:3100/escalate \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"Test alert","message":"This is a drill. No action is required."}'
```

The phone rings within a few seconds. Answer it, listen, and say **"status report"**,
then **"acknowledged"**. Watch it happen with `docker compose logs -f bridge asterisk`.
Dial **601** at any time to hear the most recent alert again.

To try a halt safely, set the bot to `PAPER` first, say "halt trading", press 1, and
check that the dashboard shows `CONSTRUCTION`.

---

## Everyday Docker commands

Run these from `~/bosskey_trading_bot/escalation`:

| Task                                   | Command                                          |
|----------------------------------------|--------------------------------------------------|
| Status of all services                 | `docker compose ps`                              |
| Follow logs (all / one service)        | `docker compose logs -f` / `docker compose logs -f bridge` |
| Restart one service                    | `docker compose restart bridge`                  |
| Apply edits to `.env` or `asterisk/config/*` | `docker compose up -d --build`             |
| Stop everything (keeps models/volumes) | `docker compose down`                            |
| Update to newer images                 | `docker compose pull && docker compose up -d --build` |
| Asterisk console                       | `docker compose exec asterisk asterisk -rvvv`    |
| Resource usage                         | `docker stats`                                   |

`restart: unless-stopped` brings the stack back after a reboot. The Asterisk container
waits for the Tailscale IP to come up before it binds SIP.

## Troubleshooting

| Symptom | Check |
|---------|-------|
| Phone never rings | `pjsip show contacts` (above) must list the phone. If it doesn't: is Tailscale connected on the phone, is the SIP password correct, is the app allowed to run in the background? |
| Rings, but silence / one-way audio | The phone must reach UDP 10000–10100 on the Tailscale IP. Dial 600 to test. Make sure the SIP app isn't forcing TCP/TLS or SRTP. |
| Butler says "an error has occurred" | Piper or whisper isn't ready: `docker compose logs piper whisper`. |
| `whisper` keeps restarting with exit code 132 | SIGILL: the binary uses CPU instructions the Pi lacks. That's why `whisper/Dockerfile` compiles whisper.cpp on the Pi (`GGML_NATIVE=ON`) instead of using the upstream `main-arm64` image, which needs ARMv8.2+ (a Pi 4 is ARMv8.0). If you move the stack to another machine, rebuild it there with `docker compose build whisper`. |
| Long pause after you speak | Normal on a Pi 4 (roughly 5–15 s for whisper plus, when needed, the LLM). For speed, use `WHISPER_MODEL=tiny.en` and/or `OLLAMA_MODEL=qwen2.5:0.5b`, then `docker compose up -d`. |
| "The bot refused the command" | `BOT_ADMIN_TOKEN` must equal the bot's `ADMIN_API_TOKEN`, and `bosskey-api` must be running under PM2 (`pm2 ls`). |
| Test curl returns 429 | The cooldown is working. Wait, or run `docker compose restart bridge` to reset it. |
| Test curl returns 503 | `ESCALATION_TOKEN` in `escalation/.env` is missing or shorter than 32 chars. |

## Security model

- SIP listens **only on the Tailscale IP**. Nothing on your LAN or the internet can reach it, and the phone still has to authenticate with a password.
- The bridge API and the AGI port listen on `127.0.0.1` only. `/escalate` requires `ESCALATION_TOKEN`, and it fails closed if the token isn't set.
- Voice actions only move the bot toward safety (CONSTRUCTION/PAPER), and each needs a keypad confirmation.
- Asterisk and the bridge run as root inside their containers so they can share the spool/audio volumes. Neither is reachable from outside the Pi.

## Resource use (Pi 4, 8 GB)

At idle expect about 1.5–2 GB RAM, mostly the Ollama model, which stays loaded
(`OLLAMA_KEEP_ALIVE=24h`) so calls don't stall. CPU sits near zero until a call is in progress.

## Files

```
escalation/
├── docker-compose.yml          # the five services, volumes, networks
├── env.example                 # copy to .env
├── asterisk/
│   ├── Dockerfile, entrypoint.sh
│   └── config/                 # pjsip.conf.template, extensions.conf, rtp.conf, modules.conf, ...
├── whisper/
│   └── Dockerfile              # compiles whisper.cpp for the Pi's own CPU
└── bridge/
    ├── Dockerfile, package.json
    ├── src/
    │   ├── server.js           # HTTP API + FastAGI server + warm-up
    │   ├── CallFileWriter.js   # builds and atomically spools the .call file
    │   ├── EscalationService.js# cooldown, alert text, orchestration
    │   ├── EscalationCall.js   # the conversation on a live call
    │   ├── AgiChannel.js       # FastAGI protocol
    │   ├── PiperClient.js      # Wyoming TTS client
    │   ├── SpeechSynthesizer.js# Piper → 16 kHz .sln16 via ffmpeg (cached)
    │   ├── WhisperClient.js    # whisper.cpp /inference client
    │   ├── CommandParser.js    # keywords + Ollama structured output → allowlisted action
    │   └── BotActions.js       # calls the bot's Dashboard API (never PRODUCTION)
    └── test/                   # run from repo root with `npm test`
```
