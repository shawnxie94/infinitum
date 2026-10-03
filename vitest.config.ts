import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    fileParallelism: false,
    setupFiles: ["./vitest.setup.ts"],
    // node:sqlite 是 Node 内建模块（Node 22.5+），jsdom 环境下不会被 vite 内联打包。
    // 聚类质量评测测试直接用它读写快照库，必须显式 external。
    server: {
      deps: {
        external: ["node:sqlite"],
      },
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.{ts,tsx}"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
