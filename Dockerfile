FROM oven/bun:alpine

LABEL org.opencontainers.image.source="https://github.com/dvgamerr-app/aide-collector"

WORKDIR /app

COPY package.json bun.lockb ./
COPY ./src/ ./src/

RUN bun i --ignore-scripts --production

EXPOSE 3000
CMD ["bun", "/app/src/index.js"]
