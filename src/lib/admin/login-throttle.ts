// 内存级登录失败限流：单进程（app 容器单副本）足够覆盖管理登录这一低频面。
// 无反代时所有客户端共享 "unknown" 桶，属可接受的保守退化。
const FAILURE_WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILURES_PER_WINDOW = 5;
const MAX_TRACKED_IPS = 10_000;

const failuresByIp = new Map<string, number[]>();

export type LoginThrottleState = {
  throttled: boolean;
  retryAfterSeconds: number;
};

function activeFailures(ip: string, now: number): number[] {
  const stamps = (failuresByIp.get(ip) ?? []).filter((ts) => now - ts < FAILURE_WINDOW_MS);
  if (stamps.length === 0) {
    failuresByIp.delete(ip);
  } else {
    failuresByIp.set(ip, stamps);
  }
  return stamps;
}

function pruneBudget() {
  if (failuresByIp.size > MAX_TRACKED_IPS) {
    failuresByIp.clear();
  }
}

export function getLoginThrottleState(ip: string, now = Date.now()): LoginThrottleState {
  pruneBudget();
  const active = activeFailures(ip, now);

  if (active.length < MAX_FAILURES_PER_WINDOW) {
    return { throttled: false, retryAfterSeconds: 0 };
  }

  const oldestActive = Math.min(...active);
  return {
    throttled: true,
    retryAfterSeconds: Math.max(1, Math.ceil((oldestActive + FAILURE_WINDOW_MS - now) / 1000)),
  };
}

export function registerLoginFailure(ip: string, now = Date.now()) {
  pruneBudget();
  const stamps = failuresByIp.get(ip) ?? [];
  stamps.push(now);
  failuresByIp.set(ip, stamps);
  activeFailures(ip, now);
}

export function resetLoginFailures(ip: string) {
  failuresByIp.delete(ip);
}
