import { afterEach, describe, expect, it, vi } from "vitest";

import { invalidateEventBriefingCache, withEventBriefingCache } from "@/lib/events/cache";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  invalidateEventBriefingCache();
});

describe("event briefing cache", () => {
  it("bounds stale cache data from writes in another process by TTL", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.useFakeTimers();
    invalidateEventBriefingCache();
    const firstLoader = vi.fn().mockResolvedValue("before external write");
    const secondLoader = vi.fn().mockResolvedValue("after external write");

    expect(await withEventBriefingCache("cross-process", firstLoader)).toBe("before external write");
    expect(await withEventBriefingCache("cross-process", secondLoader)).toBe("before external write");
    expect(secondLoader).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_001);
    expect(await withEventBriefingCache("cross-process", secondLoader)).toBe("after external write");
    expect(secondLoader).toHaveBeenCalledOnce();
  });
});
