FROM oven/bun:alpine

WORKDIR /app

COPY package.json bun.lockb ./
COPY ./src/ ./src/

RUN bun i --ignore-scripts --production

EXPOSE 3000
CMD ["bun", "/app/src/index.js"]
