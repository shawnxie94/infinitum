FROM node:20-alpine AS base

WORKDIR /app

# 配置 Alpine 国内镜像源
RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apk/repositories \
  && apk add --no-cache sqlite openssl libc6-compat libssl3 ca-certificates

ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS builder

ENV NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
# Keep Next.js TypeScript/build workers within the default Docker Desktop
# memory budget. Runtime stages do not inherit this builder-only setting.
ENV NODE_OPTIONS=--max-old-space-size=1024

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run prisma:generate \
  && npm run schema:generate \
  && npm run build \
  && npm run build:worker \
  && cp -R node_modules/.prisma/client .next/standalone/node_modules/.prisma/client

FROM base AS worker-deps

COPY package-lock.json package.json ./

RUN node -e "const fs=require('fs'); const lock=require('./package-lock.json'); fs.writeFileSync('package.json', JSON.stringify({name:'infinitum-worker-runtime', private:true, dependencies:{jsdom:lock.packages['node_modules/jsdom'].version}}, null, 2));" \
  && rm -f package-lock.json \
  && npm install --omit=dev --no-package-lock --no-audit --silent \
  && npm cache clean --force \
  && rm -rf /root/.npm node_modules/.cache \
  && find node_modules -type f -name "*.d.ts" -delete \
  && find node_modules -type d \( -name docs -o -name examples \) -prune -exec rm -rf '{}' +

FROM alpine:3.23 AS runtime-base

WORKDIR /app

RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apk/repositories \
  && apk add --no-cache sqlite openssl libc6-compat libstdc++ libgcc libssl3 ca-certificates

COPY --from=base /usr/local/bin/node /usr/local/bin/node

FROM runtime-base AS worker-runner

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV DATABASE_URL=file:/app/data/dev.db

COPY --from=worker-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist/worker.cjs ./worker.cjs
COPY --from=builder /app/prisma/schema.sql ./prisma/schema.sql
COPY --from=builder /app/node_modules/@prisma/client ./node_modules/@prisma/client
COPY --from=builder /app/node_modules/.prisma/client ./node_modules/.prisma/client
COPY --from=builder /app/scripts/setup-sqlite.mjs ./scripts/setup-sqlite.mjs
COPY --from=builder /app/scripts/worker-entrypoint.sh ./scripts/worker-entrypoint.sh

RUN mkdir -p /app/data

CMD ["sh", "./scripts/worker-entrypoint.sh"]

FROM runtime-base AS app-runner

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV DATABASE_URL=file:/app/data/dev.db

COPY --from=builder /app/prisma/schema.sql ./prisma/schema.sql
COPY --from=builder /app/public ./public
COPY --from=builder /app/scripts/docker-entrypoint.sh ./scripts/docker-entrypoint.sh
COPY --from=builder /app/scripts/setup-sqlite.mjs ./scripts/setup-sqlite.mjs
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["sh", "./scripts/docker-entrypoint.sh"]
