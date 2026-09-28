FROM node:22-bookworm-slim

# ffmpeg converts Piper's 22.05 kHz output into the 16 kHz raw audio Asterisk plays natively.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY src ./src

# Runs as root inside the container: it shares the spool/audio volumes with
# Asterisk (also root), so files move between them without permission fights.
ENV NODE_ENV=production
EXPOSE 3100 4573
CMD ["node", "src/server.js"]
