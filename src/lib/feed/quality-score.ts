import { Prisma } from "@prisma/client";

export function normalizeFeedQualityScore(qualityScore: number): number {
  return Math.max(0, Math.min(100, Math.round(qualityScore)));
}

export function buildFeedQualityScoreSql(qualityScore: Prisma.Sql) {
  const roundedScore = Prisma.sql`CAST(ROUND(${qualityScore}) AS INTEGER)`;

  return Prisma.sql`CASE WHEN ${roundedScore} > 100 THEN 100 WHEN ${roundedScore} < 0 THEN 0 ELSE ${roundedScore} END`;
}
