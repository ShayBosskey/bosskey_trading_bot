#!/bin/sh
set -eu

: "${TAILSCALE_IP:?TAILSCALE_IP is not set in escalation/.env}"
: "${SIP_USERNAME:?SIP_USERNAME is not set in escalation/.env}"
: "${SIP_PASSWORD:?SIP_PASSWORD is not set in escalation/.env}"

if [ "$SIP_PASSWORD" = "CHANGE_ME" ] || [ "${#SIP_PASSWORD}" -lt 16 ]; then
    echo "Refusing to start: set a real SIP_PASSWORD (16+ chars) in escalation/.env" >&2
    exit 1
fi

# After a reboot Docker can start before tailscaled has its IP; binding SIP to an
# address that doesn't exist yet would leave Asterisk up but unreachable.
i=0
until ip -4 addr show | grep -q "inet ${TAILSCALE_IP}/"; do
    i=$((i + 1))
    [ "$i" -ge 60 ] && { echo "Tailscale IP ${TAILSCALE_IP} never appeared - is tailscale up?" >&2; exit 1; }
    echo "Waiting for Tailscale IP ${TAILSCALE_IP}..."
    sleep 2
done

# Only substitute our own variables - the dialplan's ${ESC_ID} etc. must survive.
envsubst '${TAILSCALE_IP} ${SIP_USERNAME} ${SIP_PASSWORD}' \
    < /templates/pjsip.conf.template > /etc/asterisk/pjsip.conf

mkdir -p /var/spool/asterisk/outgoing /var/spool/asterisk/tmp \
         /var/lib/asterisk/sounds/escalation /var/log/asterisk /var/run/asterisk

# -f foreground (Docker needs a foreground process), -vvv readable console log.
exec asterisk -f -vvv
