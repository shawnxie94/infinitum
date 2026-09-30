// 隔离验证 runner：把仓库源码镜像到临时目录后执行完整 npm test 与
// schema snapshot 校验，避免直接触碰仓库内任何现有数据库文件。
// 用法：node scripts/verify-universal-briefing.mjs [--keep]
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const keep = process.argv.includes("--keep");
const logPath = path.join(os.tmpdir(), `verify-universal-briefing-${Date.now()}.log`);

const MIRROR_TOP_LEVEL = [
  "src",
  "tests",
  "scripts",
  "config",
  "packages",
  "prisma",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "next.config.ts",
  "postcss.config.mjs",
  "eslint.config.mjs",
  "vitest.config.ts",
  "vitest.setup.ts",
  "next-env.d.ts",
];

const EXCLUDED_BASENAMES = new Set([
  "node_modules",
  ".git",
  ".agent",
  ".codegraph",
  ".next",
  "coverage",
  "dist",
  "build",
  ".playwright-cli",
  ".playwright-mcp",
  ".pytest_cache",
  ".zcode",
  ".release-evidence",
  ".DS_Store",
]);

// 拷贝边界按文件类型划定：.env 变体、所有 .db*（含 .db-wal/.db-shm/.db.bak 等）、
// 任何含 .db 的名字、sqlite 变体、key/pem。测试源码文件名含 secret 字样不排除，
// 否则会把安全相关测试本身漏掉。
const SECRET_FILE_PATTERNS = [
  /^\.env($|\.)/i,
  /\.db/i, // 覆盖 .db、.db-wal、.db-shm、.db.bak 等所有 .db* 数据库文件
  /-shm$/i,
  /-wal$/i,
  /\.pem$/i,
  /\.key$/i,
];

function isExcluded(name) {
  if (EXCLUDED_BASENAMES.has(name)) return true;
  return SECRET_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

// 递归拷贝，只接受普通目录与普通文件：
// - 不跟随、不复现任何 symlink（除顶层 node_modules 显式共享），
//   避免 repo 内 absolute symlink 被带进镜像或越界读源。
// - 命中排除规则的条目整枝跳过。
function copyTree(source, target) {
  const name = path.basename(source);
  if (isExcluded(name)) return;

  let stats;
  try {
    if (lstatSync(source).isSymbolicLink()) return; // 不跟随、不复现任何 symlink
    stats = statSync(source);
  } catch {
    return; // 悬空 symlink 等条目直接跳过
  }

  if (stats.isDirectory()) {
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(source)) {
      copyTree(path.join(source, entry), path.join(target, entry));
    }
    return;
  }

  if (stats.isFile()) {
    copyFileSync(source, target);
  }
}

// 镜像目录由 mkdtemp 先创建并拥有；populate 抛错也走 main 的 finally 清理。
function populateMirror(mirrorRoot) {
  for (const entry of MIRROR_TOP_LEVEL) {
    const source = path.join(repoRoot, entry);
    if (!existsSync(source)) {
      continue;
    }
    copyTree(source, path.join(mirrorRoot, entry));
  }

  // node_modules 是唯一必要的共享 symlink：Prisma client 只是生成代码、不含 DB，
  // 不复制能省大量时间；prisma/ 内的 .db 文件已按拷贝边界排除，schema 文件保留。
  symlinkSync(path.join(repoRoot, "node_modules"), path.join(mirrorRoot, "node_modules"), "dir");
}

// 防 root 环境的 DATABASE_URL/DIRECT_URL 泄进 child 污染真实 DB：
// 一律显式指向镜像内的 test.db；所有 schema/测试命令都 cwd 镜像。
function buildChildEnv(mirrorRoot) {
  const dbUrl = `file:${path.join(mirrorRoot, "test.db")}`;
  return {
    ...process.env,
    DATABASE_URL: dbUrl,
    DIRECT_URL: dbUrl,
  };
}

// 配置 JSON 模板不得包含真实秘密；发现可疑键只报告键路径，绝不输出值。
function auditConfigTemplate(mirrorRoot) {
  const templatePath = path.join(mirrorRoot, "config", "infinitum.config.json");
  if (!existsSync(templatePath)) {
    return null;
  }

  const SECRET_KEY_RE = /(api[-_]?key|password|secret|token)/i;
  const findings = [];

  const visit = (node, trail) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, [...trail, String(index)]));
      return;
    }
    if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if (
          SECRET_KEY_RE.test(key)
          && typeof value === "string"
          && value.trim() !== ""
          && !/^(env:|\$\{|your|xxx|placeholder|changeme|<)/i.test(value.trim())
        ) {
          findings.push(trail.concat(key).join("."));
        }
        visit(value, trail.concat(key));
      }
    }
  };
  visit(JSON.parse(readFileSync(templatePath, "utf8")), []);

  return findings;
}

function run(command, args, options = {}) {
  const line = `[run] ${command} ${args.join(" ")} (cwd=${options.cwd ?? repoRoot})`;
  console.log(line);
  const result = execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  return result;
}

function main() {
  const mirrorRoot = mkdtempSync(path.join(os.tmpdir(), "infinitum-verify-"));
  const childEnv = buildChildEnv(mirrorRoot);
  const failures = [];
  let testOutput = "";

  try {
    console.log(`mirror: ${mirrorRoot}`);
    console.log(`log: ${logPath}`);

    populateMirror(mirrorRoot);

    // 1. 完整测试套件（镜像内重置的是镜像自己的 test.db）。
    try {
      testOutput = run("npm", ["test"], { cwd: mirrorRoot, env: childEnv });
    } catch (error) {
      testOutput = error.stdout ?? "";
      failures.push({
        command: "npm test",
        detail: `${error.stdout?.split("\n").slice(-40).join("\n")}\n${error.stderr?.split("\n").slice(-40).join("\n")}`,
      });
    }

    // 2. schema snapshot 幂等校验：在镜像内重新生成并与仓库当前 snapshot 对比。
    let schemaDiff = "";
    try {
      run("npm", ["run", "schema:generate"], { cwd: mirrorRoot, env: childEnv });
      const mirrored = readFileSync(path.join(mirrorRoot, "prisma", "schema.sql"), "utf8");
      const committed = readFileSync(path.join(repoRoot, "prisma", "schema.sql"), "utf8");
      if (mirrored !== committed) {
        failures.push({ command: "schema:generate snapshot diff", detail: "mirrored schema.sql differs from repository snapshot" });
        schemaDiff = "MISMATCH";
      } else {
        schemaDiff = "identical";
      }
    } catch (error) {
      failures.push({ command: "schema:generate", detail: String(error.stderr ?? error) });
    }

    // 3. 配置 JSON 模板秘密审计（只报键路径，不输出值）。
    try {
      const secretKeys = auditConfigTemplate(mirrorRoot);
      if (secretKeys && secretKeys.length > 0) {
        failures.push({ command: "config template secret audit", detail: `suspicious non-empty secret-like keys: ${secretKeys.join(", ")}` });
      }
    } catch (error) {
      failures.push({ command: "config template secret audit", detail: String(error) });
    }

    const summary = {
      mirrorRoot,
      schemaDiff,
      failures,
      testOutputTail: testOutput.split("\n").slice(-80).join("\n"),
    };
    writeFileSync(path.join(os.tmpdir(), "verify-universal-briefing-summary.json"), JSON.stringify(summary, null, 2));
    writeFileSync(logPath, testOutput);

    if (failures.length > 0) {
      console.error("\n=== VERIFY FAILED ===");
      for (const failure of failures) {
        console.error(`\n--- ${failure.command} ---\n${failure.detail}`);
      }
      process.exitCode = 1;
      return;
    }

    const testLines = testOutput.split("\n");
    const summaryLine = testLines.find((line) => /Tests\s+\d+\s+passed|Test Files\s+\d+\s+passed/.test(line));
    console.log("\n=== VERIFY PASSED ===");
    console.log(summaryLine ?? "vitest summary line not found; see log");
    console.log(`schema snapshot: ${schemaDiff}`);
  } finally {
    if (!keep) {
      rmSync(mirrorRoot, { recursive: true, force: true });
    } else {
      console.log(`kept mirror: ${mirrorRoot}`);
    }
  }
}

main();
