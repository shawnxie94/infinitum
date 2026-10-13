#!/usr/bin/env node
/**
 * Offline AI judgment quality evaluation for the cluster merge relation
 * protocol (stage: composite_dev_ai_judgment_offline).
 *
 * Feeds the composite dev suite (human relation labels) through the REAL
 * cluster-merge AI path (production prompt + provider + relation schema),
 * then compares model relations against human labels. No DB writes, no
 * repo writes outside --out; the model config file is supplied by the
 * caller and must stay outside version control.
 *
 * Label mapping: same_event→same, follow_up/synthesis/unrelated→diff
 * (same as eval-cluster-quality-baseline). AI output keeps raw relations.
 *
 * Exit codes: 0 ok, 1 invalid input.
 */
import fs from "node:fs";
import path from "node:path";
import { createAiProvider } from "../src/lib/ai/provider-next";
import type { PromptOverrides } from "../src/lib/ai/provider-types";
import type { RuntimeConfig } from "../src/config/runtime";

type SuiteRow = Record<string, string>;
interface ModelConfigFile {
  model: { apiKey: string; baseURL: string; model: string };
  clusterMerge: { systemPrompt: string; userInstruction: string };
}

function parseCsv(text: string): SuiteRow[] {
  // RFC 4180 状态机：支持引号内逗号/换行/转义引号（复合集 summary 含内嵌换行）。
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQ = false;
  let started = false;
  const pushField = () => { row.push(cur); cur = ""; started = false; };
  const pushRow = () => { if (row.length > 0 || started) { pushField(); rows.push(row); row = []; } };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"') { inQ = true; started = true; }
    else if (ch === ",") pushField();
    else if (ch === "\n") { if (text[i - 1] === "\r") cur = cur.slice(0, -1); pushRow(); }
    else if (ch === "\r") { /* handled at \n */ }
    else { cur += ch; started = true; }
  }
  pushRow();
  if (rows.length === 0) return [];
  const header = rows[0]!;
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

function humanMergedLabel(label: string): "same" | "diff" {
  return label === "same" || label === "same_event" ? "same" : "diff";
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
    args[key.slice(2)] = argv[i + 1] ?? "";
  }
  return args;
}

const STRATUM_SCORE: Record<string, number> = {
  high_bm25_near_neighbor: 85,
  safety_rejected_related: 40,
  low_similarity_coverage: 20,
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const suitePath = args.suite;
  const configPath = args.config;
  const outPath = args.out;
  if (!suitePath || !configPath || !outPath) {
    console.error("required args: --suite --config --out [--limit N]");
    process.exitCode = 1;
    return;
  }

  const configFile = JSON.parse(fs.readFileSync(path.resolve(configPath), "utf8")) as ModelConfigFile;
  const rows = parseCsv(fs.readFileSync(suitePath, "utf8"));
  const limit = args.limit ? Number(args.limit) : undefined;
  const suite = limit ? rows.slice(0, limit) : rows;

  const modelApi: RuntimeConfig["modelApi"] = {
    apiKey: configFile.model.apiKey,
    baseURL: configFile.model.baseURL,
    model: configFile.model.model,
  };
  const promptOverrides: PromptOverrides = {
    clusterMerge: {
      systemPrompt: configFile.clusterMerge.systemPrompt,
      userInstruction: configFile.clusterMerge.userInstruction,
    },
  };

  const usageEvents: Array<{ promptTokens: number; completionTokens: number; totalTokens: number }> = [];
  const provider = createAiProvider(modelApi, promptOverrides, null, {
    onUsage: (usage) => {
      usageEvents.push({ promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, totalTokens: usage.totalTokens });
    },
  });

  // 构造与生产 buildClusterMergeInput 同构的输入（id 用 pair 序号占位；
  // provider 内部压缩为 pair_id 批内短 ref）。
  const clusters = suite.flatMap((row, i) => {
    const base = {
      title: row.leftTitle,
      summary: row.leftSummary,
      eventType: row.leftEventType || null,
      eventSubject: row.leftEventSubject || null,
      eventAction: row.leftEventAction || null,
      eventObject: row.leftEventObject || null,
      eventDate: row.leftEventDate || null,
      itemCount: Number(row.leftItemCount) || 1,
    };
    return [
      { id: `case-${i}-L`, ...base },
      { id: `case-${i}-R`, title: row.rightTitle, summary: row.rightSummary, eventType: row.rightEventType || null,
        eventSubject: row.rightEventSubject || null, eventAction: row.rightEventAction || null,
        eventObject: row.rightEventObject || null, eventDate: row.rightEventDate || null,
        itemCount: Number(row.rightItemCount) || 1 },
    ];
  });
  const clustersById = new Map(clusters.map((c) => [c.id, c]));
  const clustersJson = JSON.stringify({
    pairs: suite.map((row, i) => ({
      left: clustersById.get(`case-${i}-L`),
      right: clustersById.get(`case-${i}-R`),
      score: STRATUM_SCORE[row.sourceStratum] ?? 60,
    })),
  });

  console.log(`[relation-quality] judging ${suite.length} pairs with model=${configFile.model.model}`);
  const startedAt = Date.now();
  const decisions = await provider.assessClusterMergePairs(clustersJson);
  const elapsedMs = Date.now() - startedAt;

  if (decisions.length !== suite.length) {
    console.warn(`[relation-quality] WARN decisions ${decisions.length} != pairs ${suite.length} (protocol drops occurred)`);
  }

  const decisionByKey = new Map(decisions.map((d) => [`${d.leftClusterId}|${d.rightClusterId}`, d]));
  let matched = 0;
  const confusion: Array<Record<string, string>> = [];
  let sameTruePositive = 0; let sameFalseNegative = 0; let sameFalsePositive = 0; let diffCorrectReject = 0;
  const relationCounts = new Map<string, number>();
  const perCase: Array<Record<string, string>> = [];

  suite.forEach((row, i) => {
    const d = decisionByKey.get(`case-${i}-L|case-${i}-R`);
    const human = humanMergedLabel(row.humanLabel);
    const humanRelation = row.humanLabel;
    if (!d) {
      perCase.push({ caseId: row.caseId, humanRelation, aiRelation: "missing", correct: "n/a" });
      return;
    }
    matched += 1;
    relationCounts.set(d.relation, (relationCounts.get(d.relation) ?? 0) + 1);
    const aiMerged = d.relation === "same_event";
    if (human === "same" && aiMerged) sameTruePositive += 1;
    if (human === "same" && !aiMerged) sameFalseNegative += 1;
    if (human === "diff" && aiMerged) sameFalsePositive += 1;
    if (human === "diff" && !aiMerged) diffCorrectReject += 1;
    confusion.push({ human: humanRelation, ai: d.relation });
    perCase.push({
      caseId: row.caseId, humanRelation, aiRelation: d.relation, reasonCode: d.reasonCode ?? "",
      agree: String((human === "same") === aiMerged),
      confidence: String(d.confidence ?? ""),
    });
  });

  const sameTotal = sameTruePositive + sameFalseNegative;
  const report = {
    schemaVersion: 1,
    stage: "composite_dev_ai_judgment_offline",
    createdAt: new Date().toISOString(),
    suite: { path: suitePath, cases: suite.length, decisionsReturned: decisions.length },
    model: configFile.model.model,
    metrics: {
      sameRecall: sameTotal > 0 ? sameTruePositive / sameTotal : null,
      samePrecision: (sameTruePositive + sameFalsePositive) > 0 ? sameTruePositive / (sameTruePositive + sameFalsePositive) : null,
      diffCorrectReject,
      confusionHumanByAi: confusion,
      aiRelationCounts: Object.fromEntries(relationCounts),
    },
    cost: {
      aiCalls: usageEvents.length,
      promptTokens: usageEvents.reduce((s, u) => s + u.promptTokens, 0),
      completionTokens: usageEvents.reduce((s, u) => s + u.completionTokens, 0),
      totalTokens: usageEvents.reduce((s, u) => s + u.totalTokens, 0),
      elapsedMs,
    },
    perCase,
  };
  fs.writeFileSync(outPath, JSON.stringify(report, null, 1));
  console.log(`[relation-quality] status=complete matched=${matched}/${suite.length} ` +
    `sameRecall=${report.metrics.sameRecall} sameFP=${sameFalsePositive} diffCorrectReject=${diffCorrectReject} ` +
    `tokens=${report.cost.totalTokens} (${usageEvents.length} calls) out=${outPath}`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
