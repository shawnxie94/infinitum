import { describe, expect, it } from "vitest";

import {
  createClusterSummaryRetryGuard,
  getClusterSummaryRetryGuardStats,
} from "@/lib/clusters/summary-retry-guard";

function createFakeClock(start = 1_000_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe("cluster summary retry guard", () => {
  it("allows the first attempt and records it as one generation attempt", () => {
    const guard = createClusterSummaryRetryGuard();
    const verdict = guard.tryBegin("cluster", "hash");

    expect(verdict).toEqual({ allowed: true, retryAfterMs: null, attemptsInWindow: 1 });
  });

  it("blocks concurrent attempts for the same cluster+hash until finished", () => {
    const guard = createClusterSummaryRetryGuard();
    expect(guard.tryBegin("cluster", "hash").allowed).toBe(true);

    const concurrent = guard.tryBegin("cluster", "hash");
    expect(concurrent.allowed).toBe(false);

    guard.finish("cluster", "hash", "failure");
    // 失败后进入 cooldown，不再是并发拦截而是冷却拦截。
    const afterFinish = guard.tryBegin("cluster", "hash");
    expect(afterFinish.allowed).toBe(false);
    expect(afterFinish.retryAfterMs).toBeGreaterThan(0);
  });

  it("applies cooldown after a failure and reports retryAfterMs", () => {
    const clock = createFakeClock();
    const guard = createClusterSummaryRetryGuard({ now: clock.now });

    guard.tryBegin("cluster", "hash");
    guard.finish("cluster", "hash", "failure");

    clock.advance(5 * 60 * 1000);
    const duringCooldown = guard.tryBegin("cluster", "hash");
    expect(duringCooldown.allowed).toBe(false);
    expect(duringCooldown.retryAfterMs).toBe(5 * 60 * 1000);

    clock.advance(5 * 60 * 1000 + 1);
    expect(guard.tryBegin("cluster", "hash").allowed).toBe(true);
  });

  it("caps generation attempts within the rolling window", () => {
    const clock = createFakeClock();
    const guard = createClusterSummaryRetryGuard({ now: clock.now });

    guard.tryBegin("cluster", "hash");
    guard.finish("cluster", "hash", "failure");
    clock.advance(10 * 60 * 1000 + 1);
    guard.tryBegin("cluster", "hash");
    guard.finish("cluster", "hash", "failure");

    clock.advance(10 * 60 * 1000 + 1);
    const third = guard.tryBegin("cluster", "hash");
    expect(third.allowed).toBe(false);
    expect(third.attemptsInWindow).toBe(2);
    expect(third.retryAfterMs).toBeGreaterThan(0);
  });

  it("lets the same input retry again once the window expires", () => {
    const clock = createFakeClock();
    const guard = createClusterSummaryRetryGuard({ now: clock.now });

    guard.tryBegin("cluster", "hash");
    guard.finish("cluster", "hash", "failure");
    clock.advance(10 * 60 * 1000 + 1);
    guard.tryBegin("cluster", "hash");
    guard.finish("cluster", "hash", "failure");

    clock.advance(60 * 60 * 1000 + 1);
    const verdict = guard.tryBegin("cluster", "hash");
    expect(verdict.allowed).toBe(true);
    expect(verdict.attemptsInWindow).toBe(1);
  });

  it("does not let an old failure block a new input hash", () => {
    const guard = createClusterSummaryRetryGuard();
    guard.tryBegin("cluster", "hash-a");
    guard.finish("cluster", "hash-a", "failure");

    const verdict = guard.tryBegin("cluster", "hash-b");
    expect(verdict.allowed).toBe(true);
  });

  it("removes state on success so the next run starts fresh", () => {
    const guard = createClusterSummaryRetryGuard();
    guard.tryBegin("cluster", "hash");
    guard.finish("cluster", "hash", "success");

    const verdict = guard.tryBegin("cluster", "hash");
    expect(verdict.allowed).toBe(true);
    expect(verdict.attemptsInWindow).toBe(1);
  });

  it("does not charge the failed budget for outcomes that never began", () => {
    const guard = createClusterSummaryRetryGuard();
    // 未 begin 直接 finish（success/no-provider/singleton 不应产生状态）。
    guard.finish("cluster", "hash", "success");
    guard.finish("cluster", "hash", "failure");

    expect(guard.tryBegin("cluster", "hash").allowed).toBe(true);
  });

  it("keeps capacity bounded and evicts stale entries lazily", () => {
    const clock = createFakeClock();
    const guard = createClusterSummaryRetryGuard({
      now: clock.now,
      capacity: 3,
      cooldownMs: 0,
    });

    for (let index = 0; index < 10; index += 1) {
      clock.advance(61 * 60 * 1000);
      expect(guard.tryBegin(`cluster-${index}`, "hash").allowed).toBe(true);
      guard.finish(`cluster-${index}`, "hash", "failure");
    }
  });

  it("evicts the least recently active entries when capacity is exhausted", () => {
    const clock = createFakeClock();
    const guard = createClusterSummaryRetryGuard({
      now: clock.now,
      capacity: 2,
      windowMs: 10 * 60 * 1000,
      cooldownMs: 0,
    });

    expect(guard.tryBegin("old", "hash").allowed).toBe(true);
    guard.finish("old", "hash", "failure");
    clock.advance(60 * 1000);
    expect(guard.tryBegin("new", "hash").allowed).toBe(true);
    guard.finish("new", "hash", "failure");

    // 容量满且都未过期：旧条目被驱逐后可重新尝试。
    clock.advance(60 * 1000);
    expect(guard.tryBegin("third", "hash").allowed).toBe(true);
    guard.finish("third", "hash", "failure");
    expect(guard.tryBegin("old", "hash").allowed).toBe(true);
  });

  it("defers a new key instead of growing unbounded when all entries are inflight", () => {
    const guard = createClusterSummaryRetryGuard({ capacity: 2 });

    expect(guard.tryBegin("a", "hash").allowed).toBe(true);
    expect(guard.tryBegin("b", "hash").allowed).toBe(true);

    // 两个槽位都在 inflight：第三个 key 只能延后，不允许扩容。
    const third = guard.tryBegin("c", "hash");
    expect(third.allowed).toBe(false);
    expect(third.retryAfterMs).toBeNull();
    expect(getClusterSummaryRetryGuardStats(guard).size).toBe(2);

    guard.finish("a", "hash", "failure");
    expect(guard.tryBegin("c", "hash").allowed).toBe(true);
  });

  it("allows retry exactly at the window boundary with a positive wait before it", () => {
    const clock = createFakeClock();
    const guard = createClusterSummaryRetryGuard({ now: clock.now });

    guard.tryBegin("cluster", "hash");
    guard.finish("cluster", "hash", "failure");
    clock.advance(10 * 60 * 1000 + 1);
    guard.tryBegin("cluster", "hash");
    guard.finish("cluster", "hash", "failure");

    // 窗口边界前一刻仍在窗口内：必须给出正的 retryAfterMs。
    clock.advance(49 * 60 * 1000);
    const beforeBoundary = guard.tryBegin("cluster", "hash");
    expect(beforeBoundary.allowed).toBe(false);
    expect(beforeBoundary.retryAfterMs).toBeGreaterThan(0);

    // 恰好到达最老尝试 + windowMs：半开边界立即放行。
    clock.advance(60 * 1000);
    const atBoundary = guard.tryBegin("cluster", "hash");
    expect(atBoundary.allowed).toBe(true);
  });

  it("keeps per-key attempts bounded across many windows on the same key", () => {
    const clock = createFakeClock();
    const guard = createClusterSummaryRetryGuard({ now: clock.now });

    for (let index = 0; index < 40; index += 1) {
      expect(guard.tryBegin("cluster", "hash").allowed).toBe(true);
      guard.finish("cluster", "hash", "failure");
      clock.advance(31 * 60 * 1000);
    }

    const stats = getClusterSummaryRetryGuardStats(guard);
    expect(stats.size).toBe(1);
    // 窗口外的时间戳已被裁剪：40 轮复用后至多保留窗口内（<2 小时跨度的相邻两次）的尝试。
    expect(stats.maxAttemptsLength).toBeLessThanOrEqual(2);
  });
});
