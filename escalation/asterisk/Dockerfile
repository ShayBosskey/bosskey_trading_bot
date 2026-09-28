# Minimal Asterisk 20 (LTS) on Alpine - small, native arm64, includes PJSIP.
FROM alpine:3.22

RUN apk add --no-cache asterisk asterisk-sounds-en gettext tzdata \
 && rm -rf /etc/asterisk/* \
 && mkdir -p /etc/asterisk /templates

COPY config/*.conf /etc/asterisk/
COPY config/pjsip.conf.template /templates/
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
