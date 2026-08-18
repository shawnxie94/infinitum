export const DAILY_REPORT_TIMEZONE = "Asia/Shanghai";

export const DEFAULT_OPENING_LABEL = "摘要";
export const DEFAULT_CLOSING_LABEL = "趋势观察";

export const DAILY_REPORT_OPENING_LABEL_MAX_LENGTH = 20;
export const DAILY_REPORT_CLOSING_LABEL_MAX_LENGTH = 20;
export const DAILY_REPORT_TITLE_MAX_LENGTH = 64;
export const DAILY_REPORT_HEADLINE_MAX_LENGTH = 64;

export type DailyReportStatus = "draft" | "published" | "failed";

export type DailyReportCandidate = {
  id: number;
  sourceKey: string;
  itemId: string;
  clusterId: string | null;
  title: string;
  itemTitle: string;
  sourceName: string;
  url: string;
  summary: string;
  qualityScore: number;
  candidateScore: number;
  sourceCount: number;
  itemCount: number;
  createdAt: string;
  publishedAt: string;
  publishedAtKnown?: boolean;
  eventType: string | null;
  eventSubject: string | null;
  eventAction: string | null;
  eventObject: string | null;
  eventDate: string | null;
  isFollowUp?: boolean;
  newItemCountOnDate?: number;
  newSourceCountOnDate?: number;
  evidenceItems?: DailyReportCandidateEvidenceItem[];
};

export const DAILY_REPORT_HISTORY_DECISIONS = ["new", "duplicate", "follow_up", "uncertain"] as const;
export type DailyReportHistoryDecision = typeof DAILY_REPORT_HISTORY_DECISIONS[number];

export type DailyReportPlanningCandidate = DailyReportCandidate & {
  sourceNumber: number;
  evidence: DailyReportCandidateEvidenceItem[];
};

export type DailyReportCandidateAssessment = {
  candidateId: number;
  relevanceScore: number;
  isWorthReading: boolean;
  suggestedBlockKey: string | null;
  historyDecision: DailyReportHistoryDecision;
  matchedRecentTopicTitle: string | null;
};

export type DailyReportAssessmentLedger = {
  schemaVersion: 1;
  candidateCount: number;
  assessedCount: number;
  unassessedCandidateIds: number[];
  excludedCandidateIds: number[];
  historyFilteredCandidateIds: number[];
  historyFilteredCount: number;
  assessments: DailyReportCandidateAssessment[];
  batchCount: number;
  recentTopics?: RecentDailyReportTopic[];
};

export type DailyReportPlanningCandidateBrief = {
  candidateId: number;
  title: string;
  clusterId?: string | null;
  sourceName?: string;
  summaryExcerpt?: string | null;
  evidenceItems?: Array<{
    title: string;
    sourceName: string;
    summaryExcerpt?: string | null;
    publishedAt: string;
  }>;
  qualityScore?: number;
  candidateScore: number;
  relevanceScore: number;
  suggestedBlockKey?: string | null;
  sourceCount: number;
  itemCount: number;
  publishedAt: string;
  publishedAtKnown?: boolean;
  eventType?: string | null;
  eventSubject?: string | null;
  eventAction?: string | null;
  eventObject?: string | null;
  eventDate?: string | null;
  isFollowUp?: boolean;
  newItemCountOnDate?: number;
  newSourceCountOnDate?: number;
  historyDecision?: DailyReportHistoryDecision;
};

export type DailyReportPlanTopicSelection = {
  candidateIds: number[];
};

export type DailyReportPlanSectionSelection = {
  blockKey: string;
  topics: DailyReportPlanTopicSelection[];
};

export type DailyReportPlanSelection = {
  schemaVersion: 2;
  sections: DailyReportPlanSectionSelection[];
};

export type DailyReportPlanTopic = {
  topicId: string;
  candidateIds: number[];
};

export type DailyReportPlanSection = {
  blockKey: string;
  topics: DailyReportPlanTopic[];
};

export type DailyReportPlan = {
  schemaVersion: 2;
  sections: DailyReportPlanSection[];
};

export type DailyReportTopicPriorityComponents = {
  candidateScore: number;
  relevanceScore: number;
  qualityScore: number;
  evidenceBonus: number;
  freshnessBonus: number;
  followUpBonus: number;
};

export type DailyReportPlanningAuditTopic = {
  topicId: string | null;
  candidateIds: number[];
  topicPriority: number;
  priorityComponents: DailyReportTopicPriorityComponents;
  retained: boolean;
};

export type DailyReportPlanningAuditSection = {
  blockKey: string;
  maxItems: number | null;
  inputTopicCount: number;
  outputTopicCount: number;
  truncatedTopicCount: number;
  topics: DailyReportPlanningAuditTopic[];
};

export type DailyReportPlanningAudit = {
  schemaVersion: 1;
  topicPriorityVersion: "v1";
  inputTopicCount: number;
  outputTopicCount: number;
  truncatedTopicCount: number;
  sections: DailyReportPlanningAuditSection[];
};

export type DailyReportSelectedTopic = {
  topicId: string;
  blockKey: string;
  candidateIds: number[];
  representativeCandidateId: number;
  candidates: DailyReportPlanningCandidate[];
};

export type DailyReportModelItem = {
  /** Internal mapping between one model item and one selected PLAN topic. */
  topicId?: string;
  title: string;
  body: string;
  notes?: DailyReportItemNote[];
};

export type DailyReportModelSectionBlock = Omit<DailyReportSectionBlock, "items"> & {
  items: DailyReportModelItem[];
};

export type DailyReportModelBlock = DailyReportTextBlock | DailyReportModelSectionBlock;

export type DailyReportModelDraft = Omit<DailyReportContent, "blocks" | "sections"> & {
  blocks: DailyReportModelBlock[];
  sections?: Record<string, DailyReportModelItem[]>;
};

export type DailyReportRepairPatch = {
  topicId: string;
  notes: DailyReportItemNote[];
};

export type DailyReportRepairPatchResult = {
  patches: DailyReportRepairPatch[];
};

export type DailyReportViolation = {
  code: string;
  stage: "plan" | "draft";
  message: string;
  blockKey?: string;
  topicId?: string;
  candidateIds?: number[];
  itemIndex?: number;
  itemTitle?: string;
  noteLabel?: string;
  noteInstruction?: string;
};

/** REPAIR notes patch can only fill required notes; structure stays code-owned. */
export function isDailyReportNotesRepairableViolation(
  violation: Pick<DailyReportViolation, "code">,
) {
  return violation.code === "draft_required_note_missing";
}

export type DailyReportDraft = DailyReportContent & {
  metadata?: {
    planSchemaVersion: 2;
    selectedCandidateIds: number[];
    selectedSourceNumbers: number[];
    writerModel: string | null;
  };
};

export type DailyReportCandidateEvidenceItem = {
  title: string;
  sourceName: string;
  summary: string;
  url: string;
  publishedAt: string;
  createdAt: string;
  qualityScore: number;
  publishedAtKnown?: boolean;
};

export type RecentDailyReportTopic = {
  date: string;
  sourceNumber: number | null;
  sectionName: string | null;
  topic: string | null;
  title: string;
  eventType: string | null;
  eventSubject: string | null;
  eventAction: string | null;
  eventObject: string | null;
  eventDate: string | null;
};

export type DailyReportTextBlock = {
  type: "text";
  title: string;
  body: string;
};

export type DailyReportItemNote = {
  label: string;
  text: string;
};

export type DailyReportItem = {
  /** Internal mapping between one final item and one selected PLAN topic. */
  topicId?: string;
  title: string;
  body: string;
  notes?: DailyReportItemNote[];
  sourceIds: number[];
};

export type DailyReportSectionBlock = {
  type: "section";
  /** Stable template identity when produced by the new writing pipeline. */
  blockKey?: string;
  title: string;
  items: DailyReportItem[];
};

export type DailyReportBlock = DailyReportTextBlock | DailyReportSectionBlock;

export type DailyReportContent = {
  headline?: string;
  blocks: DailyReportBlock[];
  openingLabel?: string;
  openingSummary?: string;
  sections?: Record<string, DailyReportItem[]>;
  closingLabel?: string;
  closingThought?: string;
};

export type DailyReportSourceDTO = {
  id: string;
  sourceNumber: number | null;
  sourceSummary: string | null;
  sourceQualityScore: number | null;
  itemId: string | null;
  clusterId: string | null;
  sourceName: string;
  title: string;
  url: string;
  sectionName: string | null;
  topic: string | null;
};

export type DailyReportSourceRegistryEntry = {
  sourceNumber: number;
  sourceKey: string;
  itemId: string | null;
  clusterId: string | null;
  sourceName: string;
  title: string;
  url: string;
  summary: string | null;
  publishedAt: string | null;
  qualityScore: number | null;
  eventType: string | null;
  eventSubject: string | null;
  eventAction: string | null;
  eventObject: string | null;
  eventDate: string | null;
};

export type DailyReportCandidateSnapshotEntry = Pick<
  DailyReportCandidate,
  | "id"
  | "sourceKey"
  | "itemId"
  | "clusterId"
  | "title"
  | "itemTitle"
  | "sourceName"
  | "url"
  | "candidateScore"
  | "sourceCount"
  | "itemCount"
  | "eventType"
  | "eventSubject"
  | "eventAction"
  | "eventObject"
  | "eventDate"
  | "isFollowUp"
  | "newItemCountOnDate"
  | "newSourceCountOnDate"
  | "publishedAtKnown"
>;

export type DailyReportExcludedCandidateSnapshotEntry = DailyReportCandidateSnapshotEntry & {
  excludedReason: string;
  matchedRecentDate: string | null;
  matchedRecentTitle: string | null;
};

export type DailyReportAssessDuplicateSnapshotEntry = DailyReportCandidateSnapshotEntry & {
  relevanceScore: number;
  suggestedBlockKey: string | null;
  historyDecision: "duplicate";
  matchedRecentTopicTitle: string | null;
  excludedReason: string;
};

export type DailyReportCandidateCoverageDTO = {
  candidateCount: number;
  selectedCount: number;
  topRankPoolCount: number;
  selectedTopRankCount: number;
  sameDayCandidateCount: number;
  selectedSameDayCount: number;
  lowRankSelectedCount: number;
  warnings: string[];
};

export type DailyReportCandidateReviewDTO = {
  candidateCount: number;
  selectedCount: number;
  candidates: DailyReportCandidateSnapshotEntry[];
  excludedRecentDuplicates: DailyReportExcludedCandidateSnapshotEntry[];
  excludedAssessDuplicates: DailyReportAssessDuplicateSnapshotEntry[];
  excludedCurrentDuplicates: DailyReportExcludedCandidateSnapshotEntry[];
  candidateCoverage?: DailyReportCandidateCoverageDTO | null;
};

export type DailyReportListItemDTO = {
  id: string;
  date: string;
  timezone: string;
  status: DailyReportStatus;
  title: string;
  openingSummary: string;
  sourceCount: number;
  generatedAt: string;
  publishedAt: string | null;
  errorMessage: string | null;
};

export type DailyReportDetailDTO = DailyReportListItemDTO & {
  closingThought: string;
  content: DailyReportContent;
  renderedMarkdown: string;
  sources: DailyReportSourceDTO[];
  previous: { date: string; title: string } | null;
  next: { date: string; title: string } | null;
  candidateReview?: DailyReportCandidateReviewDTO | null;
};

export type DailyReportRevisionListItemDTO = {
  id: string;
  revisionNo: number;
  action: "baseline" | "generated" | "restored";
  status: DailyReportStatus;
  title: string;
  createdAt: string;
  isCurrent: boolean;
  canRestore: boolean;
};

export type DailyReportRevisionDetailDTO = DailyReportRevisionListItemDTO & {
  openingSummary: string;
  closingThought: string;
  content: DailyReportContent;
  renderedMarkdown: string;
  inputHash: string;
  modelName: string | null;
  templateSignature: string | null;
  pipelineVersion: string | null;
  sources: DailyReportSourceDTO[];
  restoredFromRevisionId: string | null;
  actorType: string;
  actorLabel: string | null;
};

export type DailyReportArchiveWeekDTO = {
  key: string;
  label: string;
  count: number;
};
