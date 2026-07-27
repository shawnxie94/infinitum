/**
 * 全局常量配置
 * 集中管理所有时间、阈值、限制等常量
 */

// =============================================================================
// 时间常量 (毫秒)
// =============================================================================

/** 1 分钟的毫秒数 */
export const MINUTE_MS = 60 * 1000;

/** 1 小时的毫秒数 */
export const HOUR_MS = 60 * MINUTE_MS;

/** 1 天的毫秒数 */
export const DAY_MS = 24 * HOUR_MS;

/** 1 周的毫秒数 */
export const WEEK_MS = 7 * DAY_MS;

// =============================================================================
// Feed 缓存 TTL
// =============================================================================

/** Feed 列表缓存时间: 1 小时 */
export const FEED_LIST_CACHE_TTL_MS = HOUR_MS;

/** Feed 筛选选项缓存时间: 5 分钟 */
export const FEED_FILTER_OPTIONS_CACHE_TTL_MS = 5 * MINUTE_MS;

/** Feed 状态缓存时间: 15 秒 */
export const FEED_STATUS_CACHE_TTL_MS = 15 * 1000;

/** 默认 Feed 缓存时间: 30 秒 */
export const DEFAULT_FEED_CACHE_TTL_MS = 30 * 1000;

// =============================================================================
// Analytics 缓存 / 降采样
// =============================================================================

/** PV/UV 统计缓存时间: 5 分钟 */
export const PAGE_VIEW_STATS_CACHE_TTL_MS = 5 * MINUTE_MS;

/** 同一访客同一路径重复 PV 写入去重窗口: 30 分钟 */
export const PAGE_VIEW_WRITE_DEDUPE_TTL_MS = 30 * MINUTE_MS;

// =============================================================================
// Admin Session
// =============================================================================

/** Admin Session 过期时间 (秒): 7 天 */
export const ADMIN_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Admin Session 过期时间 (毫秒): 7 天 */
export const ADMIN_SESSION_TTL_MS = WEEK_MS;

// =============================================================================
// Clusters
// =============================================================================

/** 聚类查询回溯时间: 7 天 */
export const CLUSTER_LOOKBACK_MS = 7 * DAY_MS;

/** 聚类 AI 候选限制 */
export const CLUSTER_AI_CANDIDATE_LIMIT = 10;

/** 聚类直接匹配最小分数 */
export const CLUSTER_DIRECT_MATCH_MIN_SCORE = 105;

/** 聚类直接匹配最小差距 */
export const CLUSTER_DIRECT_MATCH_MIN_GAP = 20;

/** 聚类 AI 最小分数 */
export const CLUSTER_AI_MIN_SCORE = 35;

/** 聚合合并进入 AI 判断的本地候选最低分 */
export const CLUSTER_MERGE_AI_PAIR_MIN_SCORE = 70;

/** 聚合合并进入 AI 判断的灰区最低分 */
export const CLUSTER_MERGE_AI_PAIR_GRAY_SCORE = 55;

/** 聚合合并高置信候选分数 */
export const CLUSTER_MERGE_AI_PAIR_STRONG_SCORE = 95;

/** 单个聚合组最多带入 AI 的相似合并候选对 */
export const CLUSTER_MERGE_RELATED_PAIR_LIMIT = 3;

/** 单次聚合合并最多扫描的候选聚合组数 */
export const CLUSTER_MERGE_SCAN_CLUSTER_LIMIT = 1000;

/** 单次聚合合并最多消费的预计算 clean-clean 候选对 */
export const CLUSTER_MERGE_PRECOMPUTED_CLEAN_PAIR_LIMIT = 20;

/** 单个 dirty 聚合组在主链路最多实时评分的邻居数 */
export const CLUSTER_MERGE_DIRTY_NEIGHBOR_SCAN_LIMIT = 400;

/** 相同 clean-clean 候选对在内容未变化时最多复判次数 */
export const CLUSTER_MERGE_CLEAN_PAIR_MAX_ATTEMPTS = 3;

/** clean-clean 预计算候选有效期 */
export const CLUSTER_MERGE_CLEAN_PAIR_TTL_MS = CLUSTER_LOOKBACK_MS;

/** clean-clean 预计算任务每批处理的左侧聚合组数 */
export const CLUSTER_MERGE_PRECOMPUTE_BATCH_SIZE = 10;

/** clean-clean 预计算任务批次间隔，降低 CPU 峰值 */
export const CLUSTER_MERGE_PRECOMPUTE_BATCH_DELAY_MS = 50;

/** clean-clean 预计算任务单个 CPU 切片最多评分的候选对数 */
export const CLUSTER_MERGE_PRECOMPUTE_PAIR_SLICE_SIZE = 250;

/** clean-clean 预计算任务 CPU 切片间隔，避免 worker 长时间独占单核 */
export const CLUSTER_MERGE_PRECOMPUTE_PAIR_SLICE_DELAY_MS = 25;

/** clean-clean 预计算任务最多保留的候选对数 */
export const CLUSTER_MERGE_PRECOMPUTE_PAIR_LIMIT = 500;

/** 单次聚合合并最多发送给 AI 的候选组数 */
export const CLUSTER_MERGE_CANDIDATE_LIMIT = 80;

// =============================================================================
// Tasks / Worker
// =============================================================================

/** 任务过期时间: 15 分钟 */
export const DEFAULT_TASK_STALE_MS = 15 * MINUTE_MS;

/** 任务轮询间隔: 2 秒 */
export const DEFAULT_POLL_INTERVAL_MS = 2 * 1000;

// =============================================================================
// Ingestion
// =============================================================================

/** 摄入进度刷新间隔: 750ms */
export const INGESTION_PROGRESS_FLUSH_INTERVAL_MS = 750;

/** RSS 抓取失败后的重试次数 */
export const RSS_FETCH_RETRY_COUNT = 1;

// =============================================================================
// AI Provider
// =============================================================================

/** 非默认模型 API 熔断统计窗口: 1 分钟 */
export const MODEL_API_CIRCUIT_BREAKER_WINDOW_MS = MINUTE_MS;

/** 非默认模型 API 熔断阈值: 窗口内 3 次调用异常 */
export const MODEL_API_CIRCUIT_BREAKER_FAILURE_THRESHOLD = 3;

/** 非默认模型 API 熔断降级时长: 3 分钟 */
export const MODEL_API_CIRCUIT_BREAKER_OPEN_MS = 3 * MINUTE_MS;

// =============================================================================
// UI / Components
// =============================================================================

/** Toast 显示时长: 3 秒 */
export const TOAST_DURATION_MS = 3000;

/** Toast 去重时间窗口: 1.2 秒 */
export const TOAST_DEDUPE_MS = 1200;

/** Feed 状态轮询间隔: 30 秒 */
export const STATUS_POLL_INTERVAL_MS = 30 * 1000;

/** 全文搜索防抖延迟: 320ms */
export const FEED_SEARCH_DEBOUNCE_MS = 320;

/** 管理端聚合搜索防抖延迟: 500ms */
export const ADMIN_CLUSTER_SEARCH_DEBOUNCE_MS = 500;


// =============================================================================
// Item processing recovery
// =============================================================================

/** 抓取失败补偿每批处理上限 */
export const ITEM_PROCESSING_RECOVERY_BATCH_SIZE = 30;

/** 单次补偿任务最多自动续跑轮数（含首轮） */
export const ITEM_PROCESSING_RECOVERY_MAX_ROUNDS = 3;

/** 失败条目最大自动重试次数；达到后停止自动补救并走降级策略 */
export const ITEM_PROCESSING_RECOVERY_MAX_ATTEMPTS = 3;

/** 自动补救基础退避时间 */
export const ITEM_PROCESSING_RECOVERY_BASE_DELAY_MS = 15 * MINUTE_MS;

/** 自动补救最大退避时间 */
export const ITEM_PROCESSING_RECOVERY_MAX_DELAY_MS = 6 * HOUR_MS;

/** 自动补救默认扫描窗口：优先处理近 N 天内更新的残缺条目 */
export const ITEM_PROCESSING_RECOVERY_LOOKBACK_MS = 14 * DAY_MS;
