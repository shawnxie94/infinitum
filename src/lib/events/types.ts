import type { AdminBriefingPreferenceConfig, AdminEventBriefingConfig } from "@/lib/settings/types";

export type EventBriefingEntryType = "cluster" | "single";

export type EventBriefingChannelDTO = {
  id: string;
  name: string;
  sourceGroupIds: string[];
  enabled: boolean;
  sortOrder: number;
  count: number;
};

export type EventBriefingOptions = {
  date?: string | null;
  page?: number;
  pageSize?: number;
  channelId?: string | null;
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
};

export type EventBriefingEntryDTO = {
  id: string;
  type: EventBriefingEntryType;
  title: string;
  summary: string;
  qualityScore: number;
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
  eventType: string | null;
  eventSubject: string | null;
  eventAction: string | null;
  eventObject: string | null;
  eventDate: string | null;
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
  publishedAtKnown?: boolean;
  createdAt: string;
  qualityScore: number;
};

export type EventBriefingDTO = {
  date: string;
  channel: EventBriefingChannelDTO;
  channels: EventBriefingChannelDTO[];
  timezone: "Asia/Shanghai";
  generatedAt: string;
  summary: EventBriefingSummaryDTO;
  pagination: EventBriefingPaginationDTO;
  entries: EventBriefingEntryDTO[];
};

export type EventBriefingConfigForRuntime = AdminEventBriefingConfig;
export type BriefingPreferenceForRuntime = AdminBriefingPreferenceConfig;

export type EventCandidateEntity = {
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
  publishedAtKnown: boolean;
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
  entities: EventCandidateEntity[];
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
