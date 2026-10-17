FROM oven/bun:alpine

LABEL org.opencontainers.image.source="https://github.com/dvgamerr-app/aide-collector"

WORKDIR /app

# tini is PID 1 so orphaned Chromium child processes are reaped instead of piling up as zombies.
# hadolint ignore=DL3018
RUN apk add --no-cache chromium tini
ENV CHROME_PATH=/usr/bin/chromium

COPY package.json bun.lock ./
COPY ./src/ ./src/

RUN bun install --frozen-lockfile --ignore-scripts --production

EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["bun", "/app/src/index.js"]
