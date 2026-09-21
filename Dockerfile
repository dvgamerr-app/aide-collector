FROM oven/bun:alpine

LABEL org.opencontainers.image.source="https://github.com/dvgamerr-app/aide-collector"

WORKDIR /app

RUN apk add --no-cache chromium
ENV CHROME_PATH=/usr/bin/chromium

COPY package.json bun.lock ./
COPY ./src/ ./src/

RUN bun install --frozen-lockfile --ignore-scripts --production

EXPOSE 3000
CMD ["bun", "/app/src/index.js"]
