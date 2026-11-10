#!/usr/bin/env bash
# shefa_migrate.sh - move SHEFA from this host (Raspberry Pi, arm64) to a new
# Linux host (e.g. the Mac Mini, x86_64 or arm64) over Tailscale.
#
#   scripts/shefa_migrate.sh preflight <user@new-host>              # read-only checks
#   scripts/shefa_migrate.sh sync      <user@new-host> [--execute]  # copy + build; Pi keeps trading
#   scripts/shefa_migrate.sh cutover   <user@new-host> [--execute]  # stop Pi, move DB, start new host
#
# Options:  --dest-dir PATH   install path on the new host (default: same as here)
#           --execute         actually do it. Without it, sync/cutover only PRINT the plan.
#           --force-db        allow cutover to overwrite a destination DB that already holds trades
#
# What moves: the repo (code, .env, ecosystem.config.js, migrations, escalation/ stack
# sources and its .env), the Postgres database (pg_dump -Fc -> pg_restore), the
# escalation audio volume, the bot's crontab lines, and the PM2 apps.
# What does NOT move: node_modules and build output (rebuilt with npm ci on the new
# host - native modules are CPU-specific), Docker images (rebuilt there), and the
# downloadable model caches (Piper/Whisper fetch on first start; Ollama is pulled).
#
# Safety: two hosts trading one Alpaca account would double every order, so cutover
# stops and unschedules everything on this host BEFORE the final DB dump, and nothing
# on this host is deleted - the rollback steps are printed at the end.
set -euo pipefail

# ---------- arguments ----------
PHASE="${1:-}"; DEST="${2:-}"
shift $(( $# >= 2 ? 2 : $# )) || true
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST_DIR="$SRC_DIR"
EXECUTE=0
FORCE_DB=0
while (( $# )); do
    case "$1" in
        --dest-dir) DEST_DIR="${2:?--dest-dir needs a path}"; shift 2 ;;
        --execute)  EXECUTE=1; shift ;;
        --force-db) FORCE_DB=1; shift ;;
        *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
done
usage() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
[[ "$PHASE" =~ ^(preflight|sync|cutover)$ && -n "$DEST" ]] || usage

COMPOSE_PROJECT="bosskey-escalation"          # name: in escalation/docker-compose.yml
PI_APPS=(crypto-trading-bot crypto-exit-engine crypto-exit-watchdog bosskey-api bosskey-dashboard)
CRON_MARK="#SHEFA-MIGRATED#"
STAMP="$(date +%Y-%m-%d_%H%M)"
BACKUP_DIR="$HOME/bosskey_backups"

# ---------- output + execution helpers ----------
V=$'\e[38;2;179;157;219m'; R=$'\e[0m'; Y=$'\e[33m'; RED=$'\e[31m'; G=$'\e[32m'
step() { printf '\n%s==> %s%s\n' "$V" "$*" "$R"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$R" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$R" "$*"; }
die()  { printf '%sERROR:%s %s\n' "$RED" "$R" "$*" >&2; exit 1; }

# Local command: printed always, run only with --execute.
run() {
    printf '  + %s\n' "$*"
    (( EXECUTE )) && "$@"
    return 0
}
# Remote script on the new host (login shell so nvm/PATH are loaded).
remote() {
    printf '  + [%s] %s\n' "$DEST" "$1"
    (( EXECUTE )) && ssh -o BatchMode=yes "$DEST" "bash -lc $(printf '%q' "$1")"
    return 0
}
# Read-only remote probe: always runs (used by preflight/guards).
probe() { ssh -o BatchMode=yes -o ConnectTimeout=10 "$DEST" "bash -lc $(printf '%q' "$1")"; }

envval() { grep -E "^$1=" "$2" | tail -1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//'; }

# ---------- shared facts ----------
[[ -f "$SRC_DIR/.env" ]] || die "No .env in $SRC_DIR"
SRC_TS_IP="$(tailscale ip -4 2>/dev/null | head -1 || true)"
[[ -n "$SRC_TS_IP" ]] || SRC_TS_IP="$(envval TAILSCALE_IP "$SRC_DIR/escalation/.env" 2>/dev/null || true)"
DB_NAME="$(envval DB_NAME "$SRC_DIR/.env")"
DB_USER="$(envval DB_USER "$SRC_DIR/.env")"
DB_HOST="$(envval DB_HOST "$SRC_DIR/.env")"
DB_PORT="$(envval DB_PORT "$SRC_DIR/.env")"; DB_PORT="${DB_PORT:-5432}"
OLLAMA_MODEL="$(envval OLLAMA_MODEL "$SRC_DIR/escalation/.env" 2>/dev/null || true)"

# On the new host, load the copied .env so DB credentials never cross the wire as arguments.
DEST_ENV="cd $(printf '%q' "$DEST_DIR") && set -a && . ./.env && set +a && export PGPASSWORD=\"\$DB_PASSWORD\""

# rsync: everything except CPU-specific or regenerable output. .env files are
# included on purpose (-a keeps their 600 permissions); transport is SSH over Tailscale.
RSYNC_OPTS=(-az --human-readable --info=stats1
    --exclude 'node_modules/'
    --exclude 'dashboard/dist/'
    --exclude 'run/'
    --exclude '.cache/'
    --exclude '*.heartbeat.json')

# =====================================================================
preflight() {
    step "Preflight: $(hostname) -> $DEST:$DEST_DIR  (read-only)"
    for t in rsync ssh pg_dump node npm pm2 docker; do
        command -v "$t" >/dev/null && ok "local $t" || die "local $t missing"
    done
    probe 'true' && ok "ssh to $DEST (key auth)" || die "Cannot ssh to $DEST without a password. Run: ssh-copy-id $DEST"

    local src_arch dest_arch src_node dest_node
    src_arch="$(uname -m)"; dest_arch="$(probe 'uname -m')"
    ok "architecture: $src_arch here -> $dest_arch there$([[ $src_arch != "$dest_arch" ]] && echo ' (cross-arch: npm ci + docker build on the new host handle it)')"

    local missing=0
    for t in rsync node npm pm2 psql pg_restore createdb docker crontab; do
        if probe "command -v $t >/dev/null"; then ok "remote $t"; else warn "remote $t MISSING"; missing=1; fi
    done
    probe 'docker compose version >/dev/null 2>&1' && ok "remote docker compose" || { warn "remote 'docker compose' plugin MISSING"; missing=1; }

    src_node="$(node -v)"; dest_node="$(probe 'node -v' 2>/dev/null || echo none)"
    if [[ "${src_node%%.*}" == "${dest_node%%.*}" ]]; then ok "node $src_node here, $dest_node there"
    else warn "node major differs ($src_node here, $dest_node there) - install ${src_node%%.*} on the new host"; fi

    local dest_ts; dest_ts="$(probe 'tailscale ip -4 2>/dev/null | head -1' || true)"
    [[ -n "$dest_ts" ]] && ok "Tailscale: $SRC_TS_IP here -> $dest_ts there" || { warn "Tailscale not up on $DEST"; missing=1; }

    probe "df -Pk $(dirname "$DEST_DIR") 2>/dev/null | awk 'NR==2{printf \"%.1f GB free\", \$4/1048576}'" | sed 's/^/  disk on new host: /'; echo
    probe "pg_lsclusters 2>/dev/null | tail -n +2 || systemctl is-active postgresql 2>/dev/null" | sed 's/^/  postgres: /' || warn "could not query Postgres status"

    (( missing )) && die "Install the missing tools on $DEST, then re-run preflight."
    ok "Preflight passed. Next: $0 sync $DEST --execute"
}

# =====================================================================
sync_phase() {
    step "Sync code + config to $DEST:$DEST_DIR (this host keeps trading)"
    remote "mkdir -p $(printf '%q' "$DEST_DIR")"
    run rsync "${RSYNC_OPTS[@]}" "$SRC_DIR/" "$DEST:$DEST_DIR/"

    step "Rebuild dependencies for the new CPU (npm ci, never copied node_modules)"
    remote "cd $(printf '%q' "$DEST_DIR") && npm ci --no-audit --no-fund"
    remote "cd $(printf '%q' "$DEST_DIR")/dashboard && npm ci --no-audit --no-fund"

    step "Build the escalation stack images for the new CPU (not started yet)"
    remote "cd $(printf '%q' "$DEST_DIR")/escalation && docker compose build"
    remote "cd $(printf '%q' "$DEST_DIR")/escalation && docker compose pull piper ollama"

    step "Check the destination database login with the copied .env"
    remote "$DEST_ENV && psql -h \"\$DB_HOST\" -p \"\${DB_PORT:-5432}\" -U \"\$DB_USER\" -d postgres -Atc 'select version()'"

    (( EXECUTE )) && ok "Sync done. Safe to repeat. Next: $0 cutover $DEST --execute"
}

# =====================================================================
cutover() {
    local dest_ts; dest_ts="$(probe 'tailscale ip -4 2>/dev/null | head -1')"
    [[ -n "$dest_ts" ]] || die "Could not read the new host's Tailscale IP."
    probe "test -f $(printf '%q' "$DEST_DIR")/.env && test -d $(printf '%q' "$DEST_DIR")/node_modules" \
        || die "Run '$0 sync $DEST --execute' first (no synced .env/node_modules on $DEST)."

    # Refuse to clobber a destination DB that already has trades, unless told to.
    local dest_rows
    dest_rows="$(probe "$DEST_ENV && psql -h \"\$DB_HOST\" -p \"\${DB_PORT:-5432}\" -U \"\$DB_USER\" -d \"\$DB_NAME\" -Atc 'select count(*) from trade_analytics' 2>/dev/null" || echo 0)"
    if [[ "${dest_rows:-0}" =~ ^[0-9]+$ ]] && (( dest_rows > 0 && ! FORCE_DB )); then
        die "$DEST already has $dest_rows trade rows in $DB_NAME. Re-run with --force-db to overwrite it."
    fi

    if (( EXECUTE )); then
        printf '\n%sCUTOVER stops all trading on %s and moves SHEFA to %s (%s).%s\n' "$Y" "$(hostname)" "$DEST" "$dest_ts" "$R"
        read -r -p "Type MIGRATE to continue: " answer
        [[ "$answer" == "MIGRATE" ]] || die "Aborted."
    else
        warn "DRY RUN - printing the plan. Nothing is stopped or copied. Add --execute to run it."
    fi

    step "1/8 Stop and unschedule everything on this host (no double trading)"
    # delete, not stop: PM2 cron_restart can revive a merely stopped app. The apps
    # are recreated from ecosystem.config.js on rollback.
    # Tolerate apps already gone, so a retried cutover doesn't abort here.
    for app in "${PI_APPS[@]}"; do run bash -c "pm2 delete '$app' 2>/dev/null || true"; done
    run pm2 save --force
    run mkdir -p "$BACKUP_DIR"
    run bash -c "crontab -l > '$BACKUP_DIR/crontab_pre_migration_$STAMP' 2>/dev/null || true"
    # Comment out (never delete) this bot's cron lines.
    run bash -c "crontab -l | sed -E '/^[^#].*$(printf '%s' "$SRC_DIR" | sed 's/[\/&.]/\\&/g')/ s/^/$CRON_MARK /' | crontab -"
    run docker compose --project-directory "$SRC_DIR/escalation" -f "$SRC_DIR/escalation/docker-compose.yml" stop

    step "2/8 Final delta sync of code and config"
    run rsync "${RSYNC_OPTS[@]}" "$SRC_DIR/" "$DEST:$DEST_DIR/"

    step "3/8 Dump the database (custom format, arch-independent)"
    local dump="$BACKUP_DIR/migration_${STAMP}.dump"
    # Exported, not passed inline, so the password never appears in the printed plan.
    PGPASSWORD="$(envval DB_PASSWORD "$SRC_DIR/.env")"; export PGPASSWORD
    run pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -Fc -f "$dump" "$DB_NAME"
    run rsync -az "$dump" "$DEST:$DEST_DIR/.migration.dump"

    step "4/8 Restore it on $DEST"
    remote "$DEST_ENV && (psql -h \"\$DB_HOST\" -p \"\${DB_PORT:-5432}\" -U \"\$DB_USER\" -d postgres -Atc \"select 1 from pg_database where datname='\$DB_NAME'\" | grep -q 1 || createdb -h \"\$DB_HOST\" -p \"\${DB_PORT:-5432}\" -U \"\$DB_USER\" \"\$DB_NAME\")"
    remote "$DEST_ENV && pg_restore -h \"\$DB_HOST\" -p \"\${DB_PORT:-5432}\" -U \"\$DB_USER\" -d \"\$DB_NAME\" --clean --if-exists --no-owner --no-acl --exit-on-error .migration.dump && rm -f .migration.dump"
    remote "$DEST_ENV && psql -h \"\$DB_HOST\" -p \"\${DB_PORT:-5432}\" -U \"\$DB_USER\" -d \"\$DB_NAME\" -Atc \"select 'trades=' || count(*) from trade_analytics; select 'shefa_fund=' || shefa_fund from capital_pots where id=1\""

    step "5/8 Point host-bound config at the new Tailscale IP ($SRC_TS_IP -> $dest_ts)"
    remote "cd $(printf '%q' "$DEST_DIR") && sed -i 's/^TAILSCALE_IP=.*/TAILSCALE_IP=$dest_ts/' escalation/.env"

    step "6/8 Escalation stack: carry recorded audio, start, pull the LLM"
    local vol="${COMPOSE_PROJECT}_escalation_audio"
    remote "docker volume create $vol >/dev/null"
    if (( EXECUTE )); then
        printf '  + docker volume %s -> %s (tar over ssh)\n' "$vol" "$DEST"
        docker run --rm -v "$vol":/v:ro alpine tar -C /v -cf - . \
            | ssh -o BatchMode=yes "$DEST" "docker run --rm -i -v $vol:/v alpine tar -C /v -xf -"
    else
        printf '  + docker volume %s -> %s (tar over ssh)\n' "$vol" "$DEST"
    fi
    remote "cd $(printf '%q' "$DEST_DIR")/escalation && docker compose up -d"
    [[ -n "$OLLAMA_MODEL" ]] && remote "docker exec esc-ollama ollama pull $OLLAMA_MODEL"

    step "7/8 Start SHEFA under PM2 on $DEST (exit engine first, then the rest)"
    remote "cd $(printf '%q' "$DEST_DIR") && pm2 start ecosystem.config.js --only crypto-exit-engine && sleep 5 && pm2 start ecosystem.config.js --only crypto-exit-watchdog,crypto-trading-bot"
    remote "cd $(printf '%q' "$DEST_DIR") && pm2 start src/DashboardAPI.js --name bosskey-api --time"
    remote "cd $(printf '%q' "$DEST_DIR")/dashboard && pm2 start npm --name bosskey-dashboard --time -- run dev -- --host $dest_ts --strictPort"
    remote "pm2 save"

    step "8/8 Install the bot's cron jobs on $DEST (paths rewritten, existing entries kept)"
    local cron_lines
    cron_lines="$(crontab -l 2>/dev/null | sed -n "s/^$CRON_MARK //p")"
    (( EXECUTE )) || cron_lines="$(crontab -l 2>/dev/null | grep -F "$SRC_DIR" | grep -v '^#')"
    cron_lines="${cron_lines//$SRC_DIR/$DEST_DIR}"
    printf '%s\n' "$cron_lines" | sed 's/^/    /'
    if (( EXECUTE )); then
        # Swap in the new host's node path; keep its existing cron entries, drop exact duplicates.
        local merge='node_bin=$(command -v node); new=$(sed "s#/usr/bin/node#$node_bin#g"); { crontab -l 2>/dev/null | grep -vxF -f <(printf "%s\n" "$new") || true; printf "%s\n" "$new"; } | crontab -'
        printf '%s\n' "$cron_lines" | ssh -o BatchMode=yes "$DEST" "bash -lc $(printf '%q' "$merge")"
    fi

    step "Verify"
    remote "sleep 10; pm2 ls; cat $(printf '%q' "$DEST_DIR")/run/crypto-exit-engine.heartbeat.json 2>/dev/null | head -c 300; echo; curl -s localhost:3000/api/v1/system/health | head -c 200; echo"

    cat <<EOF

${V}Manual follow-ups${R}
  1. Phone SIP: change the server/domain from $SRC_TS_IP to $dest_ts, then check
     'docker exec esc-asterisk asterisk -rx "pjsip show contacts"' on $DEST shows Avail.
  2. Boot persistence on $DEST: run 'pm2 startup' there and execute the sudo line it prints.
  3. Dashboard is now at http://$dest_ts:5173
  4. Keep the Pi powered but idle for a few days. Its DB dump is at $dump

${Y}Rollback (Pi takes over again)${R} - first stop SHEFA on $DEST ('pm2 delete all' there), then on the Pi:
  crontab -l | sed 's/^$CRON_MARK //' | crontab -
  cd $SRC_DIR && pm2 start ecosystem.config.js --only crypto-exit-engine && pm2 start ecosystem.config.js
  pm2 start src/DashboardAPI.js --name bosskey-api --time
  (cd dashboard && pm2 start npm --name bosskey-dashboard --time -- run dev -- --host $SRC_TS_IP --strictPort)
  pm2 save && docker compose --project-directory escalation -f escalation/docker-compose.yml start
EOF
}

case "$PHASE" in
    preflight) preflight ;;
    sync)      (( EXECUTE )) || warn "DRY RUN - printing the plan. Add --execute to run it."; sync_phase ;;
    cutover)   cutover ;;
esac
