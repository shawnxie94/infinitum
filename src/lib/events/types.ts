import type { AdminBriefingPreferenceConfig, AdminEventBriefingConfig } from "@/lib/settings/types";

export type EventBriefingEntryType = "cluster" | "single";
export const EVENT_BRIEFING_VIEW_VALUES = ["important", "updates", "multi-source"] as const;
export type EventBriefingView = (typeof EVENT_BRIEFING_VIEW_VALUES)[number];

export type EventBriefingOptions = {
  date?: string | null;
  page?: number;
  pageSize?: number;
  view?: EventBriefingView | null;
  now?: Date;
};

export type EventBriefingPaginationDTO = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export type EventBriefingSummaryDTO = {
  eventCount: number;
  multiSourceCount: number;
  updatedEventCount: number;
};

export type EventBriefingEntryDTO = {
  id: string;
  type: EventBriefingEntryType;
  title: string;
  summary: string;
  rankScore: number;
  baseRankScore: number;
  curatorBoost: number;
  curatorPenalty: number;
  isFollowUp: boolean;
  sourceCount: number;
  itemCount: number;
  newItemCountOnDate: number;
  newSourceCountOnDate: number;
  latestCreatedAt: string;
  latestPublishedAt: string;
  detailHref: string;
  items: EventBriefingItemDTO[];
};

export type EventBriefingItemDTO = {
  id: string;
  title: string;
  summary: string;
  sourceName: string;
  originalUrl: string;
  publishedAt: string;
  createdAt: string;
  qualityScore: number;
};

export type EventBriefingDTO = {
  date: string;
  view: EventBriefingView;
  timezone: "Asia/Shanghai";
  generatedAt: string;
  summary: EventBriefingSummaryDTO;
  pagination: EventBriefingPaginationDTO;
  entries: EventBriefingEntryDTO[];
};

export type EventBriefingConfigForRuntime = AdminEventBriefingConfig;
export type BriefingPreferenceForRuntime = AdminBriefingPreferenceConfig;

export type EventCandidateTag = {
  name: string;
  normalized: string;
};

export type EventCandidateSource = {
  id: string;
  name: string;
  groupId: string | null;
};

export type EventCandidateItem = {
  id: string;
  title: string;
  summary: string;
  sourceName: string;
  originalUrl: string;
  publishedAt: Date;
  createdAt: Date;
  qualityScore: number;
};

export type EventBriefingCandidate = {
  id: string;
  type: EventBriefingEntryType;
  title: string;
  summary: string;
  qualityScore: number;
  sourceCount: number;
  itemCount: number;
  newItemCountOnDate: number;
  newSourceCountOnDate: number;
  latestCreatedAt: Date;
  latestPublishedAt: Date;
  earliestCreatedAt: Date;
  representativeUrl: string;
  eventType: string | null;
  eventSubject: string | null;
  eventAction: string | null;
  eventObject: string | null;
  eventDate: string | null;
  isFollowUp: boolean;
  tags: EventCandidateTag[];
  sources: EventCandidateSource[];
  items: EventCandidateItem[];
  searchText: string;
};

export type EventBriefingDateRange = {
  date: string;
  start: Date;
  end: Date;
  timezone: "Asia/Shanghai";
};
