-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_event_briefing_configs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "minRankScore" INTEGER NOT NULL DEFAULT 0,
    "briefingChannelsJson" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_event_briefing_configs" ("createdAt", "id", "minRankScore", "updatedAt") SELECT "createdAt", "id", "minRankScore", "updatedAt" FROM "event_briefing_configs";
DROP TABLE "event_briefing_configs";
ALTER TABLE "new_event_briefing_configs" RENAME TO "event_briefing_configs";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

ALTER TABLE "task_schedules" ADD COLUMN "dailyReportChannelIdsJson" TEXT NOT NULL DEFAULT '["important"]';

ALTER TABLE "task_schedules" DROP COLUMN "dailyReportGroupIdsJson";
