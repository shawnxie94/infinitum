const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 时效过时阈值：AI 抽出的事件时间早于基准时间超过这个天数，视为“旧内容重新推送”。
 * 硬编码为常量，不做成设置项：判定口径需要跨源一致，误判由过滤内容复核里的人工恢复兜底。
 */
export const STALE_EVENT_MAX_AGE_DAYS = 7;

export const STALE_CONTENT_FILTER_REASON = "stale_event_content";
export const STALE_CONTENT_MODERATION_REASON = "stale_content" as const;

/** 放行原因码，用于把「为什么没拦」也记进证据，避免只看到结果看不到判断。 */
export type StaleContentSkipReason =
  | "no_event_date"
  | "restored_by_admin"
  | "no_baseline"
  | "within_threshold"
  | "year_unverified"
  | "dateline_only";

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
  /** 标题与正文全文，用于电头识别和年份佐证。 */
  contentText?: string | null;
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
  /** 未过滤时的具体原因，便于观测误杀与漏杀。 */
  skipReason: StaleContentSkipReason | null;
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

function skip(
  skipReason: StaleContentSkipReason,
  ageDays: number | null = null,
  baseline: string | null = null,
): StaleContentResult {
  return { stale: false, reason: null, detail: null, ageDays, baseline, skipReason };
}

/**
 * 中文新闻电头。`10月3日消息`、`北京时间 10 月 3 日`、`当地时间 10 月 1 日`
 * 表示的是**报道当天**，不是事件发生日，必须排除在事件时间之外。
 */
const DATELINE_PATTERN =
  /(?:\d{1,2}\s*月\s*\d{1,2}\s*日\s*[^\d]{0,4}(?:消息|电|讯)|(?:北京时间|当地时间|今日|昨天)\s*[^\d]{0,6}\d{1,2}\s*月\s*\d{1,2}\s*日)/;

/** 正文里带年份的日期：2025年、2025-10-03、2025/10/03。 */
const YEAR_QUALIFIED_DATE_PATTERN = /(20\d{2})\s*年|(20\d{2})\s*[-/]\s*\d{1,2}\s*[-/]\s*\d{1,2}/g;

/**
 * 判断 eventDate 的年份在正文里是否被佐证。
 *
 * 线上数据表明模型会在正文完全没有年份线索时凭空补一个年份（实测稳定落在模型
 * 知识边界上），因此要求年份必须在正文里以带年份的日期形式出现过，否则视为臆测。
 */
function isEventYearCorroborated(contentText: string, eventDate: Date): boolean {
  const year = eventDate.getUTCFullYear().toString();
  YEAR_QUALIFIED_DATE_PATTERN.lastIndex = 0;
  let match = YEAR_QUALIFIED_DATE_PATTERN.exec(contentText);
  while (match) {
    if (match[1] === year || match[2] === year) {
      return true;
    }
    match = YEAR_QUALIFIED_DATE_PATTERN.exec(contentText);
  }
  return false;
}

/**
 * 判断一条已完成 AI 分析的内容是否「时效过时」。
 *
 * 目标场景：信息源把旧内容重新推送，feed 时间是新的，但正文讲的是早已发生的事。
 *
 * 判定链条（任一环不成立即放行，并记下 skipReason）：
 *  1. AI 必须给出格式合法的 eventDate；
 *  2. 管理员未人工恢复过；
 *  3. 事件时间距基准超过阈值；
 *  4. 正文里存在该年份的带年份日期（排除模型凭空补年份）；
 *  5. 正文中的日期线索不是纯电头（电头是报道日，不是事件日）。
 */
export function evaluateStaleContent(input: StaleContentInput): StaleContentResult {
  const eventDate = parseEventDate(input.eventDate);

  // 护栏 1：没有明确事件时间就不推断时效，直接放行。
  if (!eventDate) {
    return skip("no_event_date");
  }

  // 护栏 2：管理员已经人工恢复过，不在重分析时再次打回。
  if (input.restoredByAdminAt) {
    return skip("restored_by_admin");
  }

  // publishedAt 已知时用它做基准：正常的历史补抓不会因为入库晚而被误判。
  const usePublishedAt = input.publishedAtKnown !== false;
  const baseline = usePublishedAt ? input.publishedAt ?? null : input.referenceAt ?? null;
  if (!baseline) {
    return skip("no_baseline");
  }

  const ageDays = Math.floor((baseline.getTime() - eventDate.getTime()) / DAY_MS);
  const baselineLabel = usePublishedAt ? "发布时间" : "入库时间";
  const baselineIso = baseline.toISOString().slice(0, 10);

  if (ageDays <= STALE_EVENT_MAX_AGE_DAYS) {
    return skip("within_threshold", ageDays, baselineLabel);
  }

  // 护栏 3：年份必须在正文里被佐证，否则模型的年份是臆测出来的。
  const contentText = (input.contentText ?? "").replace(/\s+/g, " ");
  if (!isEventYearCorroborated(contentText, eventDate)) {
    return skip("year_unverified", ageDays, baselineLabel);
  }

  // 护栏 4：正文只有电头日期时，说明 eventDate 取自报道日而非事件日。
  const hasBareDate = /\d{1,2}\s*月\s*\d{1,2}\s*日/.test(contentText);
  if (hasBareDate && DATELINE_PATTERN.test(contentText)) {
    return skip("dateline_only", ageDays, baselineLabel);
  }

  return {
    stale: true,
    reason: STALE_CONTENT_FILTER_REASON,
    detail:
      `事件时间 ${input.eventDate?.trim()} 距${baselineLabel} ${baselineIso} 已有 ${ageDays} 天，` +
      `超过时效阈值 ${STALE_EVENT_MAX_AGE_DAYS} 天，且该年份在正文中得到佐证，按旧内容重新推送过滤。`,
    ageDays,
    baseline: baselineLabel,
    skipReason: null,
  };
}
