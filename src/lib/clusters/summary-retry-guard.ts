// 聚类摘要重试 guard：进程内有界重试控制，不持久化、重启即重置。
// 维度是「generation 尝试」，不是 AI 调用次数（helper 内部中文重试最多
// 额外 1 次 AI call，仍算同一次 generation 尝试）。

export const CLUSTER_SUMMARY_RETRY_WINDOW_MS = 60 * 60 * 1000;
export const CLUSTER_SUMMARY_RETRY_COOLDOWN_MS = 10 * 60 * 1000;
export const CLUSTER_SUMMARY_RETRY_MAX_WINDOW_ATTEMPTS = 2;
export const CLUSTER_SUMMARY_RETRY_CAPACITY = 1000;

export type ClusterSummaryRetryGuardOptions = {
  now?: () => number;
  windowMs?: number;
  cooldownMs?: number;
  maxWindowAttempts?: number;
  capacity?: number;
};

type ClusterSummaryRetryEntry = {
  attempts: number[];
  lastFailureAt: number | null;
  inflight: boolean;
};

export type ClusterSummaryRetryVerdict = {
  allowed: boolean;
  retryAfterMs: number | null;
  attemptsInWindow: number;
};

export type ClusterSummaryRetryOutcome = "success" | "failure";

export type ClusterSummaryRetryGuard = {
  tryBegin: (clusterId: string, inputHash: string) => ClusterSummaryRetryVerdict;
  finish: (clusterId: string, inputHash: string, outcome: ClusterSummaryRetryOutcome) => void;
  reset: () => void;
};

// 只读诊断快照（测试/巡检用），不属于生产 API 行为。
export type ClusterSummaryRetryGuardStats = {
  size: number;
  maxAttemptsLength: number;
};

const guardEntries = new WeakMap<ClusterSummaryRetryGuard, Map<string, ClusterSummaryRetryEntry>>();

export function getClusterSummaryRetryGuardStats(guard: ClusterSummaryRetryGuard): ClusterSummaryRetryGuardStats {
  const map = guardEntries.get(guard);
  if (!map) {
    return { size: 0, maxAttemptsLength: 0 };
  }
  return {
    size: map.size,
    maxAttemptsLength: map.size === 0 ? 0 : Math.max(...[...map.values()].map((entry) => entry.attempts.length)),
  };
}

export function buildClusterSummaryRetryKey(clusterId: string, inputHash: string) {
  return `${clusterId}:${inputHash}`;
}

export function createClusterSummaryRetryGuard(options: ClusterSummaryRetryGuardOptions = {}): ClusterSummaryRetryGuard {
  const now = options.now ?? (() => Date.now());
  const windowMs = options.windowMs ?? CLUSTER_SUMMARY_RETRY_WINDOW_MS;
  const cooldownMs = options.cooldownMs ?? CLUSTER_SUMMARY_RETRY_COOLDOWN_MS;
  const maxWindowAttempts = options.maxWindowAttempts ?? CLUSTER_SUMMARY_RETRY_MAX_WINDOW_ATTEMPTS;
  const capacity = options.capacity ?? CLUSTER_SUMMARY_RETRY_CAPACITY;
  const entries = new Map<string, ClusterSummaryRetryEntry>();

  // 窗口采用半开区间：时间差恰好等于 windowMs 的尝试已过期，
  // 保证边界时刻 retryAfterMs 归零后立即放行，不会出现 0 等待仍被拦。
  function pruneAttempts(attempts: number[], currentTime: number) {
    return attempts.filter((attemptAt) => currentTime - attemptAt < windowMs);
  }

  function entryActivityAt(entry: ClusterSummaryRetryEntry) {
    return Math.max(entry.attempts.at(-1) ?? 0, entry.lastFailureAt ?? 0);
  }

  // 惰性清理：过期且空闲的条目直接移除，控制容量；仍超限时按最久未活跃驱逐。
  function evictExpired(currentTime: number, reserveKey?: string) {
    for (const [key, entry] of entries) {
      if (key === reserveKey || entry.inflight) continue;
      if (currentTime - entryActivityAt(entry) > windowMs) {
        entries.delete(key);
      }
    }

    while (entries.size >= capacity) {
      let oldestKey: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [key, entry] of entries) {
        if (key === reserveKey || entry.inflight) continue;
        const activity = entryActivityAt(entry);
        if (activity < oldestAt) {
          oldestAt = activity;
          oldestKey = key;
        }
      }
      if (!oldestKey) break;
      entries.delete(oldestKey);
    }
  }

  function attemptsInWindow(entry: ClusterSummaryRetryEntry, currentTime: number) {
    return pruneAttempts(entry.attempts, currentTime).length;
  }

  const guard: ClusterSummaryRetryGuard = {
    tryBegin(clusterId, inputHash) {
      const currentTime = now();
      const key = buildClusterSummaryRetryKey(clusterId, inputHash);
      evictExpired(currentTime, key);
      const entry = entries.get(key);

      if (!entry) {
        // 容量满且无可驱逐条目（其余 key 全部 inflight）：延后处理，不扩容。
        if (entries.size >= capacity) {
          return { allowed: false, retryAfterMs: null, attemptsInWindow: 0 };
        }
        entries.set(key, { attempts: [currentTime], lastFailureAt: null, inflight: true });
        return { allowed: true, retryAfterMs: null, attemptsInWindow: 1 };
      }

      if (entry.inflight) {
        return { allowed: false, retryAfterMs: null, attemptsInWindow: attemptsInWindow(entry, currentTime) };
      }

      entry.attempts = pruneAttempts(entry.attempts, currentTime);
      const attempts = entry.attempts.length;
      const waitings: number[] = [];
      if (entry.lastFailureAt !== null && currentTime - entry.lastFailureAt < cooldownMs) {
        waitings.push(cooldownMs - (currentTime - entry.lastFailureAt));
      }
      if (attempts >= maxWindowAttempts) {
        const oldestInWindow = entry.attempts[0] ?? currentTime;
        waitings.push(windowMs - (currentTime - oldestInWindow));
      }

      if (waitings.length > 0) {
        return {
          allowed: false,
          retryAfterMs: Math.max(...waitings),
          attemptsInWindow: attempts,
        };
      }

      entry.attempts.push(currentTime);
      entry.inflight = true;
      return {
        allowed: true,
        retryAfterMs: null,
        attemptsInWindow: attemptsInWindow(entry, currentTime),
      };
    },

    finish(clusterId, inputHash, outcome) {
      const key = buildClusterSummaryRetryKey(clusterId, inputHash);
      const entry = entries.get(key);
      if (!entry) return;
      entry.inflight = false;
      if (outcome === "success") {
        entries.delete(key);
        return;
      }
      const currentTime = now();
      entry.attempts = pruneAttempts(entry.attempts, currentTime);
      entry.lastFailureAt = currentTime;
    },

    reset() {
      entries.clear();
    },
  };

  guardEntries.set(guard, entries);
  return guard;
}

// 服务默认共享实例：单 worker 内全局有界；重启即清空，不做跨进程协调。
const defaultClusterSummaryRetryGuard = createClusterSummaryRetryGuard();

export function getDefaultClusterSummaryRetryGuard() {
  return defaultClusterSummaryRetryGuard;
}
