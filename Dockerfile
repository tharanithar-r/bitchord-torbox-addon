# ── Build ───────────────────────────────────────────────────────────────────
FROM node:24-alpine AS build
WORKDIR /app

# Dependencies first, so a source edit does not re-install them.
COPY package.json package-lock.json* ./
RUN npm ci || npm install

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY types ./types
COPY vendor ./vendor

RUN npm run build \
 && node -e "const {DatabaseSync}=require('node:sqlite'); new DatabaseSync(':memory:').exec('CREATE VIRTUAL TABLE t USING fts5(a)'); console.log('node:sqlite + FTS5 ok')" \
 && npm prune --omit=dev

# ── Runtime ─────────────────────────────────────────────────────────────────
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8099 \
    BIND_HOST=0.0.0.0 \
    DB_PATH=/data/index.db

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The vendored verifier is copied verbatim from the official BitChord docs and is
# imported at runtime, so it must not be bundled or rewritten.
COPY --from=build /app/vendor ./vendor

# The index is a rebuildable cache of the TorBox account, so it lives in a volume
# the container can write to as an unprivileged user.
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]
USER node

EXPOSE 8099
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8099/ >/dev/null || exit 1

CMD ["node", "dist/src/main.js"]
