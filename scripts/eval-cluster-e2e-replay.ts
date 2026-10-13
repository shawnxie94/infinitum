#!/usr/bin/env node
/**
 * End-to-end composed replay for the cluster merge pipeline on a frozen
 * snapshot (stage: composite_e2e_composed_replay).
 *
 * Composes the three stages over one cohort suite and reports the funnel:
 *   L1 candidate admission  — production buildClusterMergeCandidateSelection
 *                             (counterfactual live endpoints, vector disabled)
 *   L2 AI judgment          — real cluster-merge relation-protocol calls on
 *                             admitted pairs only
 *   L3 final graph merge    — buildClusterMergeGroupsFromDecisions over the
 *                             same_event edges
 *
 * Read-only: no DB writes, no writes outside --out. Model config must stay
 * outside version control.
 */
import fs from "node:fs";
import path from "node:path";
// node:sqlite ships in Node 22+/25+; @types/node@20 has no declarations for it.
// @ts-expect-error node:sqlite has no type declarations in @types/node@20
import { DatabaseSync } from "node:sqlite";
import {
  buildClusterMergeCandidateSelection,
  getCandidateEventSignature,
  type ClusterMergeCandidate,
} from "../src/lib/clusters/helpers";
import { buildClusterMergeGroupsFromDecisions } from "../src/lib/ai/protocols/cluster";
import { createAiProvider } from "../src/lib/ai/provider-next";
import type { ClusterMergeDecision, PromptOverrides } from "../src/lib/ai/provider-types";
import type { RuntimeConfig } from "../src/config/runtime";
import { selectProductionCorpus, toClusterMergeCandidate } from "./eval-cluster-quality-baseline";

interface ModelConfigFile {
  model: { apiKey: string; baseURL: string; model: string };
  clusterMerge: { systemPrompt: string; userInstruction: string };
}

type SuiteRow = Record<string, string>;

function parseCsv(text: string): SuiteRow[] {
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

const merged = (label: string) => (label === "same" || label === "same_event" ? "same" : "diff");

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
    args[key.slice(2)] = argv[i + 1] ?? "";
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const suitePath = args.suite;
  const snapshotPath = args.snapshot;
  const asOf = args["as-of"];
  const configPath = args.config;
  const outPath = args.out;
  const cohort = args.cohort;
  if (!suitePath || !snapshotPath || !asOf || !configPath || !outPath) {
    console.error("required args: --suite --snapshot --as-of --config --out [--cohort id]");
    process.exitCode = 1;
    return;
  }

  const configFile = JSON.parse(fs.readFileSync(path.resolve(configPath), "utf8")) as ModelConfigFile;
  let rows = parseCsv(fs.readFileSync(suitePath, "utf8"));
  if (cohort) rows = rows.filter((r) => r.sourceCohort === cohort);
  if (rows.length === 0) {
    console.error(`no suite rows for cohort=${cohort ?? "(all)"}`);
    process.exitCode = 1;
    return;
  }

  const db = new DatabaseSync(path.resolve(snapshotPath), { readOnly: true });
  const asOfMs = Date.parse(asOf);
  const lookbackSinceMs = asOfMs - 7 * 24 * 60 * 60 * 1000;

  // L1 语料 + 反事实准入（复用基线脚本的语料选择语义：7 天窗口 + 生产过滤）。
  const { corpus } = selectProductionCorpus(db, lookbackSinceMs);
  const corpusCandidates: ClusterMergeCandidate[] = corpus.map((r) => toClusterMergeCandidate(r));

  const pairEndpoints = rows.map((r) => {
    const pairKey = r.pairKey ?? "";
    const [leftId, rightId] = pairKey.split("|");
    return { caseId: r.caseId, leftId: leftId ?? "", rightId: rightId ?? "", human: merged(r.humanLabel) };
  }).filter((p) => p.leftId && p.rightId);

  const corpusIds = new Set(corpusCandidates.map((c) => c.id));
  const liveClusterIds = new Set(
    pairEndpoints.flatMap((p) => [p.leftId, p.rightId]).filter((id) => corpusIds.has(id)),
  );
  const selection = buildClusterMergeCandidateSelection(corpusCandidates, { liveClusterIds });
  const edgeConnects = (edge: { leftId: string; rightId: string }, a: string, b: string) =>
    (edge.leftId === a && edge.rightId === b) || (edge.leftId === b && edge.rightId === a);
  const admitted = (p: { leftId: string; rightId: string }) =>
    selection.allowedPairs.some((edge) => edgeConnects(edge, p.leftId, p.rightId));

  // L1 漏斗
  const l1 = {
    sameTotal: 0, sameAdmitted: 0,
    diffTotal: 0, diffAdmitted: 0,
  };
  const admittedPairs: typeof pairEndpoints = [];
  for (const p of pairEndpoints) {
    const ok = admitted(p);
    if (p.human === "same") { l1.sameTotal += 1; l1.sameAdmitted += ok ? 1 : 0; }
    else { l1.diffTotal += 1; l1.diffAdmitted += ok ? 1 : 0; }
    if (ok) admittedPairs.push(p);
  }

  // L2 真实 AI 判定（准入子集）
  const clustersById = new Map(corpusCandidates.map((c) => [c.id, c]));
  const sig = (c: ClusterMergeCandidate | undefined) => {
    if (!c) return null;
    const s = getCandidateEventSignature(c);
    return {
      id: c.id, title: c.title, summary: c.summary,
      eventType: s.eventType, eventSubject: s.eventSubject, eventAction: s.eventAction,
      eventObject: s.eventObject, eventDate: s.eventDate, itemCount: c.itemCount,
    };
  };
  const usage: Array<{ totalTokens: number }> = [];
  let decisions: ClusterMergeDecision[] = [];
  if (admittedPairs.length > 0) {
    const modelApi: RuntimeConfig["modelApi"] = {
      apiKey: configFile.model.apiKey, baseURL: configFile.model.baseURL, model: configFile.model.model,
    };
    const promptOverrides: PromptOverrides = {
      clusterMerge: {
        systemPrompt: configFile.clusterMerge.systemPrompt,
        userInstruction: configFile.clusterMerge.userInstruction,
      },
    };
    const provider = createAiProvider(modelApi, promptOverrides, null, {
      onUsage: (u) => usage.push({ totalTokens: u.totalTokens }),
    });
    const pairsJson = JSON.stringify({
      pairs: admittedPairs.map((p) => ({
        left: sig(clustersById.get(p.leftId)),
        right: sig(clustersById.get(p.rightId)),
        score: 80,
      })),
    });
    decisions = await provider.assessClusterMergePairs(pairsJson);
  }

  const decisionByPair = new Map<string, ClusterMergeDecision>();
  for (const d of decisions) {
    decisionByPair.set(`${d.leftClusterId}|${d.rightClusterId}`, d);
    decisionByPair.set(`${d.rightClusterId}|${d.leftClusterId}`, d);
  }

  const l2 = {
    judged: decisions.length,
    admittedPairs: admittedPairs.length,
    sameJudgedMerge: 0, sameJudgedTotal: 0,
    diffJudgedReject: 0, diffJudgedTotal: 0,
    sameMergeFalsePositive: 0,
  };
  const judgedByPair = new Map<string, ClusterMergeDecision>();
  admittedPairs.forEach((p, i) => {
    const d = decisions[i];
    if (!d) return;
    judgedByPair.set(`${p.leftId}|${p.rightId}`, d);
    if (p.human === "same") {
      l2.sameJudgedTotal += 1;
      if (d.relation === "same_event") l2.sameJudgedMerge += 1;
    } else {
      l2.diffJudgedTotal += 1;
      if (d.relation === "same_event") l2.sameMergeFalsePositive += 1;
      else l2.diffJudgedReject += 1;
    }
  });

  // L3 合并图：same_event 边进组，同组内的 pair 记为最终合并
  const edges = decisions
    .filter((d) => d.relation === "same_event")
    .map((d) => [d.leftClusterId, d.rightClusterId] as [string, string]);
  const itemCounts = new Map(corpusCandidates.map((c) => [c.id, c.itemCount]));
  const groups = buildClusterMergeGroupsFromDecisions(
    edges.map(([leftClusterId, rightClusterId]) => ({ leftClusterId, rightClusterId, relation: "same_event" as const })),
    itemCounts,
  );
  const mergedPairs = new Set<string>();
  for (const group of groups) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        mergedPairs.add(`${group[i]!}|${group[j]!}`);
        mergedPairs.add(`${group[j]!}|${group[i]!}`);
      }
    }
  }
  const l3 = {
    sameMerged: 0, sameTotal: pairEndpoints.filter((p) => p.human === "same").length,
    diffMerged: 0, diffTotal: pairEndpoints.filter((p) => p.human === "diff").length,
  };
  for (const p of pairEndpoints) {
    const d = judgedByPair.get(`${p.leftId}|${p.rightId}`);
    const edgeMerged = d?.relation === "same_event" && mergedPairs.has(`${p.leftId}|${p.rightId}`);
    if (p.human === "same") { if (edgeMerged) l3.sameMerged += 1; }
    else if (edgeMerged) l3.diffMerged += 1;
  }

  const report = {
    schemaVersion: 1,
    stage: "composite_e2e_composed_replay",
    createdAt: new Date().toISOString(),
    cohort: cohort ?? "(all)",
    asOf: args.asOf,
    snapshot: path.resolve(snapshotPath),
    corpusSize: corpusCandidates.length,
    pairEndpoints: pairEndpoints.length,
    funnel: {
      l1CandidateAdmission: {
        ...l1,
        sameRecall: l1.sameTotal ? l1.sameAdmitted / l1.sameTotal : null,
        diffAdmissionRate: l1.diffTotal ? l1.diffAdmitted / l1.diffTotal : null,
      },
      l2AiJudgment: {
        ...l2,
        sameMergeRateWithinAdmitted: l2.sameJudgedTotal ? l2.sameJudgedMerge / l2.sameJudgedTotal : null,
      },
      l3FinalMerge: {
        ...l3,
        sameEndToEndRecall: l3.sameTotal ? l3.sameMerged / l3.sameTotal : null,
        endToEndFalseMerges: l3.diffMerged,
      },
    },
    cost: { aiCalls: usage.length, totalTokens: usage.reduce((s, u) => s + u.totalTokens, 0) },
  };
  fs.writeFileSync(outPath, JSON.stringify(report, null, 1));
  console.log(`[e2e-replay] status=complete cohort=${report.cohort} corpus=${report.corpusSize} ` +
    `L1 same=${l1.sameAdmitted}/${l1.sameTotal} diff=${l1.diffAdmitted}/${l1.diffTotal} | ` +
    `L2 judged=${l2.judged} sameMerge=${l2.sameJudgedMerge}/${l2.sameJudgedTotal} FP=${l2.sameMergeFalsePositive} | ` +
    `L3 sameMerged=${l3.sameMerged}/${l3.sameTotal} e2eFP=${l3.diffMerged} tokens=${report.cost.totalTokens} out=${outPath}`);
  db.close();
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
