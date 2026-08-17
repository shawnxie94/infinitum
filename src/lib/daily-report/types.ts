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

export type DailyReportPlanningCandidate = DailyReportCandidate & {
  sourceNumber: number;
  evidence: DailyReportCandidateEvidenceItem[];
};

export type DailyReportCandidateAssessment = {
  candidateId: number;
  relevanceScore: number;
  isWorthReading: boolean;
  suggestedBlockKey: string | null;
  exclusionReason: string | null;
  eventHint: {
    eventType: string | null;
    eventSubject: string | null;
    eventAction: string | null;
    eventObject: string | null;
    eventDate: string | null;
  };
  evidenceSummary: string;
  confidence: number;
};

export type DailyReportAssessmentLedger = {
  schemaVersion: 1;
  candidateCount: number;
  assessedCount: number;
  unassessedCandidateIds: number[];
  assessments: DailyReportCandidateAssessment[];
  batchCount: number;
  recentTopics?: RecentDailyReportTopic[];
};

export type DailyReportMergedTopic = {
  topicId: string;
  candidateIds: number[];
  sourceBatchIndexes?: number[];
  identitySource: "cluster" | "event-identity" | "source-key" | "standalone";
  titleHint: string;
  evidenceCount: number;
  sourceKeys: string[];
  relevanceScore: number;
  ambiguity: { candidateIds: number[]; reason: string } | null;
};

export type DailyReportPlanSection = {
  blockKey: string;
  blockTitle: string;
  topicIds: string[];
  candidateIds: number[];
};

export type DailyReportPlan = {
  schemaVersion: 1;
  headlineHint: string | null;
  sections: DailyReportPlanSection[];
  excludedCandidateIds: number[];
  selectionRationale: string;
};

export type DailyReportViolation = {
  code: string;
  stage: "plan" | "draft";
  message: string;
  blockKey?: string;
  candidateIds?: number[];
};

export type DailyReportDraft = DailyReportContent & {
  metadata?: {
    planSchemaVersion: 1;
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
