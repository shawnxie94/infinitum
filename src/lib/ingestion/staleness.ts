const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 时效过时阈值：AI 抽出的事件时间早于基准时间超过这个天数，视为“旧内容重新推送”。
 * 硬编码为常量，不做成设置项：判定口径需要跨源一致，且误判由过滤内容复核里的人工恢复兜底。
 */
export const STALE_EVENT_MAX_AGE_DAYS = 7;

export const STALE_CONTENT_FILTER_REASON = "stale_event_content";
export const STALE_CONTENT_MODERATION_REASON = "stale_content" as const;

export type StaleContentInput = {
  /** AI 抽出的事件时间，YYYY-MM-DD。空/缺失时不过滤。 */
  eventDate: string | null | undefined;
  /** 源站发布时间，作为事件时间的基准。 */
  publishedAt: Date | null | undefined;
  publishedAtKnown: boolean | null | undefined;
  /** 管理员恢复时间；已恢复的条目不再被重分析打回。 */
  restoredByAdminAt: Date | null | undefined;
  /** 入库时刻，用于 publishedAt 未知时兜底。 */
  referenceAt?: Date | null;
};

export type StaleContentResult = {
  stale: boolean;
  /** 命中的过滤原因码，落 Item.filterReason。 */
  reason: string | null;
  /** 人类可读说明，落 Item.moderationDetail。 */
  detail: string | null;
  /** 事件时间距基准的天数；无法判定时为 null。 */
  ageDays: number | null;
  /** 实际使用的基准时间说明，便于排查。 */
  baseline: string | null;
};

function parseEventDate(value: string | null | undefined): Date | null {
  const trimmed = value?.trim() ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return null;
  }

  // 事件时间只有日期没有时刻，按 UTC 零点解析，避免本地时区把它推到前一天。
  const parsed = new Date(`${trimmed}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * 判断一条已完成 AI 分析的内容是否「时效过时」。
 *
 * 覆盖的场景：信息源把旧内容重新推送，feed 时间是新的，但正文讲的是早已发生的事。
 * 判定完全基于 AI 抽出的 eventDate，不做正文日期解析，事件时间为空一律放行。
 */
export function evaluateStaleContent(input: StaleContentInput): StaleContentResult {
  const eventDate = parseEventDate(input.eventDate);

  // 没有明确事件时间就不推断时效，直接放行。
  if (!eventDate) {
    return { stale: false, reason: null, detail: null, ageDays: null, baseline: null };
  }

  // 管理员已经人工恢复过，不在重分析时再次打回。
  if (input.restoredByAdminAt) {
    return {
      stale: false,
      reason: null,
      detail: null,
      ageDays: null,
      baseline: null,
    };
  }

  // publishedAt 已知时用它做基准：正常的历史补抓不会因为入库晚而被误判。
  const usePublishedAt = input.publishedAtKnown !== false;
  const baseline = usePublishedAt ? input.publishedAt ?? null : input.referenceAt ?? null;
  if (!baseline) {
    return { stale: false, reason: null, detail: null, ageDays: null, baseline: null };
  }

  const ageDays = Math.floor((baseline.getTime() - eventDate.getTime()) / DAY_MS);
  const baselineLabel = usePublishedAt ? "发布时间" : "入库时间";
  const baselineIso = baseline.toISOString().slice(0, 10);

  if (ageDays <= STALE_EVENT_MAX_AGE_DAYS) {
    return { stale: false, reason: null, detail: null, ageDays, baseline: baselineLabel };
  }

  return {
    stale: true,
    reason: STALE_CONTENT_FILTER_REASON,
    detail:
      `事件时间 ${input.eventDate?.trim()} 距${baselineLabel} ${baselineIso} 已有 ${ageDays} 天，` +
      `超过时效阈值 ${STALE_EVENT_MAX_AGE_DAYS} 天，按旧内容重新推送过滤。`,
    ageDays,
    baseline: baselineLabel,
  };
}
