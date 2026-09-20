// 日报服务 facade：实现按职责拆分到同目录模块，导出面与本文件拆分前完全一致。
export { buildDailyReportTitle } from "@/lib/daily-report/report-input";
export { deduplicateDailyReportContentByCandidate } from "@/lib/daily-report/candidates";
export {
  buildDailyReportCandidateCoverage,
  buildDailyReportReviewContext,
} from "@/lib/daily-report/candidates";
export { buildDailyReportSourceRegistryFromRows, getDailyReportSourceRegistry } from "@/lib/daily-report/source-registry";
export { enqueueDailyReportGeneration } from "@/lib/daily-report/report-lifecycle";
export { publishDailyReport, unpublishDailyReport, deleteDailyReport } from "@/lib/daily-report/report-lifecycle";
export { generateDailyReport, executeDailyReportTask } from "@/lib/daily-report/generation";
