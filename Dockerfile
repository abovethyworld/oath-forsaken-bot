# OathBreakers bot image. State (data/) is mounted at runtime, secrets come from --env-file.
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY config.json ./
COPY src ./src

RUN mkdir -p data && chown node:node data
USER node

CMD ["node", "src/index.js"]
