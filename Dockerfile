FROM node:22-alpine AS base

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

# lockfile 由本地 npm 11 生成（含 workspace 图谱），使用 Node 22 以满足 Mastra/AI SDK runtime engine 要求
RUN npm i -g npm@11.19.0

COPY package.json package-lock.json ./
# npm workspaces（spec P0）：workspace 清单须先于 npm ci 落位
COPY packages/ai/package.json ./packages/ai/
RUN npm ci

COPY . .
RUN npm run prisma:generate \
  && npm run schema:generate \
  && npm run build \
  && npm run build:worker \
  && cp -R node_modules/.prisma/client .next/standalone/node_modules/.prisma/client \
  && find node_modules/@mastra node_modules/@libsql node_modules/ai node_modules/@ai-sdk -type f -name "*.map" -delete \
  && rm -rf node_modules/@libsql/linux-*-gnu

FROM base AS worker-deps

COPY package-lock.json package.json ./
RUN npm i -g npm@11.19.0

RUN node -e "const fs=require('fs'); const lock=require('./package-lock.json'); const v=(k)=>lock.packages['node_modules/'+k].version; fs.writeFileSync('package.json', JSON.stringify({name:'infinitum-worker-runtime', private:true, dependencies:{jsdom:v('jsdom'),'@mastra/core':v('@mastra/core'),'@mastra/libsql':v('@mastra/libsql'),'@libsql/client':v('@libsql/client'),'ai':v('ai'),'@ai-sdk/openai-compatible':v('@ai-sdk/openai-compatible'),'zod':v('zod')}}, null, 2));" \
  && rm -f package-lock.json \
  && npm install --omit=dev --no-package-lock --no-audit --silent \
  && npm cache clean --force \
  && rm -rf /root/.npm node_modules/.cache \
  && find node_modules -type f -name "*.d.ts" -delete \
  && find node_modules -type d \( -name docs -o -name examples \) -prune -exec rm -rf '{}' + \
  && find node_modules -type f -name "*.map" -delete \
  && rm -rf node_modules/@libsql/linux-*-gnu

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
# Mastra/LibSQL 栈（含原生模块）：app 进程内嵌 runtime（D11），防 tracing 漏拷
COPY --from=builder /app/node_modules/@mastra ./node_modules/@mastra
COPY --from=builder /app/node_modules/@libsql ./node_modules/@libsql
COPY --from=builder /app/node_modules/@neon-rs ./node_modules/@neon-rs
COPY --from=builder /app/node_modules/detect-libc ./node_modules/detect-libc
COPY --from=builder /app/node_modules/js-base64 ./node_modules/js-base64
COPY --from=builder /app/node_modules/libsql ./node_modules/libsql
COPY --from=builder /app/node_modules/promise-limit ./node_modules/promise-limit
COPY --from=builder /app/node_modules/ws ./node_modules/ws
COPY --from=builder /app/node_modules/ai ./node_modules/ai
COPY --from=builder /app/node_modules/@ai-sdk ./node_modules/@ai-sdk

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["sh", "./scripts/docker-entrypoint.sh"]
