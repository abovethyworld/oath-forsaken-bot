# OathBreakers bot image. State (data/) is mounted at runtime, secrets come from --env-file.

# Install deps on the build machine's native arch. Every dependency is pure JS (no native
# addons), so the same node_modules works on amd64 and arm64, and nothing runs under QEMU
# (Node segfaults under emulation in CI).
FROM --platform=$BUILDPLATFORM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && mkdir data

# Runtime image for the target arch. No RUN steps here, so cross-arch builds need no emulation.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps --chown=node:node /app/data ./data
COPY package.json config.json ./
COPY src ./src

USER node

CMD ["node", "src/index.js"]
