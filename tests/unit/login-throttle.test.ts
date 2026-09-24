import { afterAll, describe, expect, it, vi } from "vitest";

import {
  getLoginThrottleState,
  registerLoginFailure,
  resetLoginFailures,
} from "@/lib/admin/login-throttle";

describe("login throttle", () => {
  afterAll(() => {
    vi.restoreAllMocks();
  });

  it("allows attempts below the failure threshold", () => {
    resetLoginFailures("1.2.3.4");
    const base = Date.now();

    for (let i = 0; i < 4; i += 1) {
      registerLoginFailure("1.2.3.4", base + i * 1000);
      expect(getLoginThrottleState("1.2.3.4", base + i * 1000).throttled).toBe(false);
    }
  });

  it("throttles after the failure threshold within the window", () => {
    resetLoginFailures("2.3.4.5");
    const base = Date.now();

    for (let i = 0; i < 5; i += 1) {
      registerLoginFailure("2.3.4.5", base + i * 1000);
    }

    const state = getLoginThrottleState("2.3.4.5", base + 6 * 1000);
    expect(state.throttled).toBe(true);
    expect(state.retryAfterSeconds).toBeGreaterThan(0);
    expect(state.retryAfterSeconds).toBeLessThanOrEqual(600);
  });

  it("releases the throttle once failures age out of the window", () => {
    resetLoginFailures("3.4.5.6");
    const base = Date.now();

    for (let i = 0; i < 5; i += 1) {
      registerLoginFailure("3.4.5.6", base + i * 1000);
    }

    expect(getLoginThrottleState("3.4.5.6", base + 5 * 60 * 1000).throttled).toBe(true);
    expect(getLoginThrottleState("3.4.5.6", base + 10 * 60 * 1000 + 1000).throttled).toBe(false);
  });

  it("clears state on successful-login reset", () => {
    resetLoginFailures("4.5.6.7");
    const base = Date.now();

    for (let i = 0; i < 5; i += 1) {
      registerLoginFailure("4.5.6.7", base);
    }
    resetLoginFailures("4.5.6.7");

    expect(getLoginThrottleState("4.5.6.7", base + 1000).throttled).toBe(false);
  });

  it("tracks ips independently", () => {
    resetLoginFailures("5.6.7.8");
    resetLoginFailures("6.7.8.9");
    const base = Date.now();

    for (let i = 0; i < 5; i += 1) {
      registerLoginFailure("5.6.7.8", base);
    }

    expect(getLoginThrottleState("5.6.7.8", base + 1000).throttled).toBe(true);
    expect(getLoginThrottleState("6.7.8.9", base + 1000).throttled).toBe(false);
  });
});
