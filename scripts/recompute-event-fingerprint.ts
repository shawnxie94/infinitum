#!/usr/bin/env node
/**
 * 重算存量 content_clusters.eventFingerprint，采用空格不敏感的指纹算法。
 * 直接复用 src/lib/clusters/identity.ts 的 buildEventFingerprint，保证与
 * 运行时代码完全一致。
 *
 * 背景：AI 抽取品牌/产品名时对内嵌空格不一致（"GPT-6 Astra 模型" vs
 * "GPT-6 Astra模型"），同一事件被拆成多个指纹（生产实测 1 组 7 cluster）。
 * 指纹 hash 输入改为去空格后，需重算存量列，否则新 item 用新指纹匹配不到
 * 存量 cluster。
 *
 * 用法（先 dry-run 看影响再实跑）：
 *   DATABASE_URL=file:./prisma/dev.db npx tsx scripts/recompute-event-fingerprint.ts --dry-run
 *   DATABASE_URL=file:./prisma/dev.db npx tsx scripts/recompute-event-fingerprint.ts
 */
// node:sqlite ships in Node 22+/25+; @types/node@20 has no declarations for it.
// @ts-expect-error node:sqlite has no type declarations in @types/node@20
import { DatabaseSync } from "node:sqlite";

import { buildEventFingerprint } from "@/lib/clusters/identity";
import type { AiEventSignature } from "@/lib/ai/provider";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dbPath = process.env.DATABASE_URL?.replace(/^file:/, "").replace(/\.db.*$/, ".db");

if (!dbPath) {
  console.error("DATABASE_URL 无效：" + process.env.DATABASE_URL);
  process.exit(1);
}

const db = new DatabaseSync(dbPath, dryRun ? { readOnly: true } : {});

const rows = db.prepare(
  `SELECT id, eventType, eventSubject, eventAction, eventObject, eventDate
   FROM content_clusters WHERE eventFingerprint IS NOT NULL`,
).all() as Array<Record<string, unknown>>;

let changed = 0;
let same = 0;
let toNull = 0;
const update = db.prepare(`UPDATE content_clusters SET eventFingerprint = ? WHERE id = ?`);
db.exec("BEGIN");

for (const row of rows) {
  const next = buildEventFingerprint({
    eventType: (row.eventType as AiEventSignature["eventType"]) ?? null,
    eventSubject: (row.eventSubject as string | null) ?? null,
    eventAction: (row.eventAction as string | null) ?? null,
    eventObject: (row.eventObject as string | null) ?? null,
    eventDate: (row.eventDate as string | null) ?? null,
  });
  if (next === (row.eventFingerprint as string | null)) {
    same += 1;
    continue;
  }
  if (dryRun) {
    changed += 1;
    continue;
  }
  update.run(next, row.id);
  if (next) changed += 1;
  else toNull += 1;
}
if (!dryRun) db.exec("COMMIT");
db.close();

console.log(`clusters scanned: ${rows.length}`);
console.log(`fingerprint changed: ${changed}${dryRun ? " (dry-run)" : ""}${toNull ? ` (-> null ${toNull})` : ""}`);
console.log(`fingerprint stable: ${same}`);