import fs from "node:fs";
import path from "node:path";

type Args = {
  db: string;
  start: string;
  end: string;
  out: string;
};

function printHelp() {
  console.log(`Usage:
  DATABASE_URL is set automatically from --db.

  npx tsx scripts/eval-event-briefing.ts \
    --db <sqlite-snapshot> \
    --start <YYYY-MM-DD> \
    --end <YYYY-MM-DD> \
    --out <csv-path>

The output is a deterministic, pending-label event briefing evaluation set.
`);
}

function parseArgs(argv: string[]): Args | null {
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

  const db = values.get("db");
  const start = values.get("start");
  const end = values.get("end");
  const out = values.get("out");
  if (!db || !start || !end || !out) {
    printHelp();
    throw new Error("--db, --start, --end and --out are required");
  }

  return { db, start, end, out };
}

function assertDate(value: string, field: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${field} must be YYYY-MM-DD: ${value}`);
  }
}

function addDays(date: string, days: number) {
  const [year, month, day] = date.split("-").map((part) => Number.parseInt(part, 10));
  const value = new Date(Date.UTC(year!, month! - 1, day!));
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function escapeCsv(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}

function chooseRanks(total: number) {
  const ranks = new Set<number>();
  for (const rank of [1, 2, 3, 4, 5, 8, 10, 15, 20, total]) {
    if (rank >= 1 && rank <= total) {
      ranks.add(rank);
    }
  }
  return ranks;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    return;
  }
  assertDate(args.start, "--start");
  assertDate(args.end, "--end");
  if (args.start > args.end) {
    throw new Error("--start must not be after --end");
  }

  const databasePath = path.resolve(args.db);
  if (!fs.existsSync(databasePath)) {
    throw new Error(`database snapshot not found: ${databasePath}`);
  }
  process.env.DATABASE_URL = `file:${databasePath}`;

  const { getEventBriefing } = await import("../src/lib/events/service");
  const { EVENT_BRIEFING_MAX_PAGE_SIZE } = await import("../src/lib/events/pagination");
  const { prisma } = await import("../src/lib/db");

  type Briefing = Awaited<ReturnType<typeof getEventBriefing>>;
  type Entry = Briefing["entries"][number];
  type SampleRow = {
    sampleId: string;
    selectionReason: string;
    date: string;
    channelId: string;
    channelName: string;
    rank: number;
    totalCandidates: number;
    entryType: Entry["type"];
    entryId: string;
    rankScore: number;
    baseRankScore: number;
    qualityScore: number;
    sourceCount: number;
    itemCount: number;
    newSourceCountOnDate: number;
    newItemCountOnDate: number;
    isFollowUp: boolean;
    latestCreatedAt: string;
    latestPublishedAt: string;
    eventType: string | null;
    eventSubject: string | null;
    eventAction: string | null;
    eventObject: string | null;
    title: string;
    summary: string;
    label: "";
    labelNote: "";
  };

  const rows: SampleRow[] = [];
  try {
    for (let date = args.start; date <= args.end; date = addDays(date, 1)) {
      const overview = await getEventBriefing({
        date,
        page: 1,
        pageSize: EVENT_BRIEFING_MAX_PAGE_SIZE,
      });

      for (const channel of overview.channels) {
        const firstPage = await getEventBriefing({
          date,
          channelId: channel.id,
          page: 1,
          pageSize: EVENT_BRIEFING_MAX_PAGE_SIZE,
        });
        const pages: Briefing["entries"] = [...firstPage.entries];
        for (let page = 2; page <= firstPage.pagination.totalPages; page += 1) {
          const nextPage = await getEventBriefing({
            date,
            channelId: channel.id,
            page,
            pageSize: EVENT_BRIEFING_MAX_PAGE_SIZE,
          });
          pages.push(...nextPage.entries);
        }

        const selectedRanks = chooseRanks(firstPage.pagination.total);
        for (const [index, entry] of pages.entries()) {
          const rank = index + 1;
          if (!selectedRanks.has(rank)) {
            continue;
          }

          const selectionReason = rank <= 5
            ? "top5"
            : rank === firstPage.pagination.total
              ? "tail"
              : "rank-band";
          rows.push({
            sampleId: `${date}:${channel.id}:${entry.type}:${entry.id}`,
            selectionReason,
            date,
            channelId: channel.id,
            channelName: channel.name,
            rank,
            totalCandidates: firstPage.pagination.total,
            entryType: entry.type,
            entryId: entry.id,
            rankScore: entry.rankScore,
            baseRankScore: entry.baseRankScore,
            qualityScore: entry.qualityScore,
            sourceCount: entry.sourceCount,
            itemCount: entry.itemCount,
            newSourceCountOnDate: entry.newSourceCountOnDate,
            newItemCountOnDate: entry.newItemCountOnDate,
            isFollowUp: entry.isFollowUp,
            latestCreatedAt: entry.latestCreatedAt,
            latestPublishedAt: entry.latestPublishedAt,
            eventType: entry.eventType,
            eventSubject: entry.eventSubject,
            eventAction: entry.eventAction,
            eventObject: entry.eventObject,
            title: entry.title,
            summary: entry.summary,
            label: "",
            labelNote: "",
          });
        }
      }
    }
  } finally {
    await prisma.$disconnect();
  }

  const headers = [
    "sample_id",
    "selection_reason",
    "date",
    "channel_id",
    "channel_name",
    "rank",
    "total_candidates",
    "entry_type",
    "entry_id",
    "rank_score",
    "base_rank_score",
    "quality_score",
    "source_count",
    "item_count",
    "new_source_count_on_date",
    "new_item_count_on_date",
    "is_follow_up",
    "latest_created_at",
    "latest_published_at",
    "event_type",
    "event_subject",
    "event_action",
    "event_object",
    "title",
    "summary",
    "label",
    "label_note",
  ] as const;
  const fields = headers.map((header) => {
    const key = header.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()) as keyof SampleRow;
    return key;
  });
  const csv = [
    headers.join(","),
    ...rows.map((row) => fields.map((field) => escapeCsv(row[field])).join(",")),
  ].join("\n") + "\n";

  const outputPath = path.resolve(args.out);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, csv);
  console.log(JSON.stringify({ output: outputPath, rows: rows.length, start: args.start, end: args.end }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
