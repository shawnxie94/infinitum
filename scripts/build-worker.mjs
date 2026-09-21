import { mkdirSync } from "node:fs";
import path from "node:path";

import { build } from "esbuild";

const root = process.cwd();
const outdir = path.resolve(root, "dist");

mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: [path.resolve(root, "scripts", "run-worker.ts")],
  outfile: path.resolve(outdir, "worker.cjs"),
  bundle: true,
  minify: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  packages: "bundle",
  // @prisma/client：生成客户端运行时外置；jsdom：rss 解析动态依赖外置；
  // Mastra/LibSQL 栈含原生模块（.node）与运行时 peer（zod），必须外置由
  // 镜像 worker-deps 层安装，避免 esbuild 打包破坏原生二进制与双实例分叉。
  external: [
    "@prisma/client",
    "jsdom",
    "@mastra/*",
    "@libsql/*",
    "ai",
    "ai/*",
    "@ai-sdk/*",
    "zod",
    "zod/*",
  ],
  logLevel: "info",
});
