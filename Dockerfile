# syntax=docker/dockerfile:1

# ── build the web app ────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY shared ./shared
COPY src ./src
RUN npm run build

# ── runtime ──────────────────────────────────────────────────────────────────
# Node 24 runs the server's TypeScript directly (type stripping is built in),
# so production needs no tsx, no bundler for the API, and nothing to compile.
FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    DEVOTION_HOST=0.0.0.0 \
    DEVOTION_PORT=8790 \
    DEVOTION_WORKSPACE=/data

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY shared ./shared
COPY scripts ./scripts
COPY --from=build /app/dist ./dist

# The workspace is one SQLite file plus a media folder, both under /data.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

VOLUME /data
EXPOSE 8790

# /api/bootstrap is the one route that needs no session token, which makes it
# the only thing a healthcheck can call from outside the app.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8790/api/bootstrap').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.ts"]
