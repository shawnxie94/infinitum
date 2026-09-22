import fs from "node:fs";
import path from "node:path";

type Row = Record<string, string>;

type SilverLabel = {
  score: number;
  label: "A" | "B" | "C";
  confidence: "high" | "medium" | "low";
  reasons: string[];
};

const HIGH_IMPACT_TERMS = [
  "政策", "监管", "法规", "安全", "漏洞", "攻击", "收购", "融资", "上市", "停产",
  "关闭", "裁员", "破产", "制裁", "战争", "事故", "重组", "违约", "诉讼", "许可",
  "合规", "量产", "首次", "纪录", "重大", "禁令", "封禁", "解散",
];
const PRODUCT_PROGRESS_TERMS = [
  "发布", "开源", "上线", "推出", "升级", "更新", "研究", "论文", "合作", "集成",
  "量产", "预订", "获得", "入选", "通过",
];
const LOW_SIGNAL_TERMS = [
  "周刊", "简报", "汇总", "盘点", "思考", "随笔", "教程", "如何", "一点思考", "暂无摘要",
];
const EVENT_TYPE_SCORES: Record<string, number> = {
  policy: 18,
  security: 18,
  acquisition: 16,
  funding: 15,
  partnership: 12,
  launch: 10,
  release: 8,
  research: 8,
  update: 6,
};

function printHelp() {
  console.log(`Usage:
  npx tsx scripts/label-event-briefing-silver.ts \
    [--in <csv-path>] \
    [--out <csv-path>] \
    [--review-out <csv-path>]

The command writes reproducible AI-assisted silver labels and a 60-row
human-review candidate file. The labels are not gold truth.
`);
}

function parseArgs(argv: string[]) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return null;
  }

  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith("--")) {
      throw new Error(`unexpected argument: ${key ?? ""}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`missing value for ${key}`);
    }
    values.set(key.slice(2), value);
    index += 1;
  }

  const input = values.get("in") ?? "docs/eval/event-briefing-eval-2026-09-22.csv";
  return {
    input,
    output: values.get("out") ?? input,
    reviewOutput: values.get("review-out") ?? "docs/eval/event-briefing-review-2026-09-22.csv",
  };
}

function parseCsv(text: string) {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    const next = text[index + 1];
    if (quoted) {
      if (char === "\"" && next === "\"") {
        field += "\"";
        index += 1;
      } else if (char === "\"" ) {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === "\"") {
      quoted = true;
    } else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n") {
      record.push(field);
      if (record.some((value) => value !== "")) {
        records.push(record);
      }
      record = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (field || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

function readRows(filePath: string) {
  const records = parseCsv(fs.readFileSync(filePath, "utf8"));
  const headers = records.shift();
  if (!headers?.length) {
    throw new Error(`CSV has no header: ${filePath}`);
  }
  return records.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

function escapeCsv(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}

function countTerms(text: string, terms: string[]) {
  return terms.filter((term) => text.includes(term.toLowerCase())).length;
}

function numberValue(row: Row, key: string) {
  return Number.parseInt(row[key] ?? "0", 10) || 0;
}

function scoreRow(row: Row): SilverLabel {
  const text = [
    row.title,
    row.summary,
    row.event_type,
    row.event_subject,
    row.event_action,
    row.event_object,
  ].join(" ").toLowerCase();
  const quality = numberValue(row, "quality_score");
  const sourceCount = numberValue(row, "source_count");
  const itemCount = numberValue(row, "item_count");
  const newSourceCount = numberValue(row, "new_source_count_on_date");
  const newItemCount = numberValue(row, "new_item_count_on_date");
  const highImpactCount = countTerms(text, HIGH_IMPACT_TERMS);
  const progressCount = countTerms(text, PRODUCT_PROGRESS_TERMS);
  const lowSignalCount = countTerms(text, LOW_SIGNAL_TERMS);
  const reasons: string[] = [];
  let score = 0;

  if (quality >= 90) {
    score += 20;
    reasons.push("高质量");
  } else if (quality >= 80) {
    score += 14;
    reasons.push("较高质量");
  } else if (quality >= 70) {
    score += 8;
  } else if (quality >= 60) {
    score += 3;
  }

  if (sourceCount >= 4) {
    score += 10;
    reasons.push("多来源");
  } else if (sourceCount >= 3) {
    score += 7;
    reasons.push("多来源");
  } else if (sourceCount >= 2) {
    score += 4;
  }

  if (itemCount >= 8) score += 5;
  else if (itemCount >= 4) score += 3;
  else if (itemCount >= 2) score += 1;

  if (newSourceCount >= 3) {
    score += 6;
    reasons.push("当日来源增长");
  } else if (newSourceCount >= 2) {
    score += 4;
    reasons.push("当日来源增长");
  } else if (newSourceCount >= 1) {
    score += 2;
  }

  if (newItemCount >= 3) score += 4;
  else if (newItemCount >= 2) score += 2;
  else if (newItemCount >= 1) score += 1;

  if (row.is_follow_up === "true" && (newSourceCount > 0 || newItemCount > 0)) {
    score += 2;
    reasons.push("跟进进展");
  }

  const eventTypeScore = EVENT_TYPE_SCORES[row.event_type] ?? 0;
  if (eventTypeScore > 0) {
    score += eventTypeScore;
    reasons.push(`${row.event_type}事件`);
  }

  if (highImpactCount > 0) {
    score += Math.min(18, highImpactCount * 6);
    reasons.push("高影响关键词");
  }
  if (progressCount > 0) {
    score += Math.min(8, progressCount * 2);
  }
  if (lowSignalCount > 0) {
    score -= Math.min(12, lowSignalCount * 4);
    reasons.push("低信号内容");
  }
  if (!row.summary || row.summary === "暂无摘要") {
    score -= 10;
    reasons.push("摘要缺失");
  }
  if (row.event_subject && row.event_action) {
    score += 2;
  }

  const label = score >= 45 ? "A" : score >= 28 ? "B" : "C";
  const distanceToBoundary = Math.min(Math.abs(score - 45), Math.abs(score - 28));
  const confidence = distanceToBoundary >= 12 ? "high" : distanceToBoundary >= 6 ? "medium" : "low";
  if (reasons.length === 0) {
    reasons.push("一般内容信号");
  }

  return { score, label, confidence, reasons };
}

function writeCsv(filePath: string, rows: Row[], headers: string[]) {
  const output = [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => escapeCsv(row[header] ?? "")).join(",")),
  ].join("\n") + "\n";
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  fs.writeFileSync(filePath, output);
}

function chooseReviewRows(rows: Row[]) {
  const selected = new Map<string, Row>();
  const add = (predicate: (row: Row) => boolean, reason: string, limit: number) => {
    for (const row of rows) {
      if (selected.size >= 60 || [...selected.values()].filter((entry) => entry.review_reason === reason).length >= limit) {
        break;
      }
      if (predicate(row)) {
        selected.set(row.sample_id, { ...row, review_reason: reason, human_label: "", human_note: "" });
      }
    }
  };

  add((row) => numberValue(row, "silver_score") >= 40 && numberValue(row, "silver_score") <= 50, "silver边界：A/B", 20);
  add((row) => numberValue(row, "silver_score") >= 23 && numberValue(row, "silver_score") <= 33, "silver边界：B/C", 20);
  add((row) => numberValue(row, "rank") <= 5 && row.label === "C", "当前Top5但silver为C", 10);
  add((row) => numberValue(row, "rank") === numberValue(row, "total_candidates") && row.label !== "C", "当前尾部但silver为A/B", 10);

  for (const row of rows) {
    if (selected.size >= 60) break;
    if (!selected.has(row.sample_id)) {
      selected.set(row.sample_id, { ...row, review_reason: "补足复核样本", human_label: "", human_note: "" });
    }
  }

  return [...selected.values()];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) return;

  const inputPath = path.resolve(args.input);
  const rows = readRows(inputPath);
  if (rows.length === 0) throw new Error("input CSV has no data rows");

  const labeledRows = rows.map((row) => {
    const result = scoreRow(row);
    return {
      ...row,
      label: result.label,
      label_note: `silver/AI-assisted；${result.reasons.join("、")}；仅作初标，需人工复核`,
      silver_score: String(result.score),
      silver_confidence: result.confidence,
      silver_reason: result.reasons.join("、"),
    };
  });
  const headers = [
    ...Object.keys(rows[0]!),
    "silver_score",
    "silver_confidence",
    "silver_reason",
  ].filter((header, index, all) => all.indexOf(header) === index);
  writeCsv(args.output, labeledRows, headers);

  const reviewRows = chooseReviewRows(labeledRows);
  writeCsv(args.reviewOutput, reviewRows, [
    ...headers,
    "review_reason",
    "human_label",
    "human_note",
  ]);

  const counts = labeledRows.reduce<Record<string, number>>((result, row) => {
    result[row.label] = (result[row.label] ?? 0) + 1;
    return result;
  }, {});
  console.log(JSON.stringify({ output: path.resolve(args.output), reviewOutput: path.resolve(args.reviewOutput), rows: rows.length, labels: counts, reviewRows: reviewRows.length }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
