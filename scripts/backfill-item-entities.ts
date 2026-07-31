import { backfillItemEntities } from "../src/lib/entities/service";
import { prisma } from "../src/lib/db";

function readPositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const batchSizeIndex = process.argv.findIndex((value) => value === "--batch-size");
  const batchSize = readPositiveInteger(
    batchSizeIndex >= 0 ? process.argv[batchSizeIndex + 1] : undefined,
    200,
  );
  const dryRun = args.has("--dry-run");

  const result = await backfillItemEntities({ batchSize, dryRun });
  console.log(JSON.stringify({ ...result, batchSize }, null, 2));
}

main()
  .catch((error) => {
    console.error("Entity backfill failed", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
