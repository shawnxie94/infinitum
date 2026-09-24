import { afterEach, describe, expect, it } from "vitest";

import { assertDeployableAdminCredentials, validateAdminPassword } from "@/lib/admin/session";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env.ADMIN_PASSWORD = ORIGINAL_ENV.ADMIN_PASSWORD;
  process.env.ADMIN_SESSION_SECRET = ORIGINAL_ENV.ADMIN_SESSION_SECRET;
});

describe("admin credential guard", () => {
  it("passes with strong credentials", () => {
    process.env.ADMIN_PASSWORD = "a-strong-password";
    process.env.ADMIN_SESSION_SECRET = "x".repeat(48);

    expect(() => assertDeployableAdminCredentials()).not.toThrow();
  });

  it("rejects missing or empty credentials", () => {
    process.env.ADMIN_PASSWORD = "";
    process.env.ADMIN_SESSION_SECRET = "x".repeat(48);
    expect(() => assertDeployableAdminCredentials()).toThrow("ADMIN_PASSWORD 未配置");

    process.env.ADMIN_PASSWORD = "a-strong-password";
    process.env.ADMIN_SESSION_SECRET = " ";
    expect(() => assertDeployableAdminCredentials()).toThrow("ADMIN_SESSION_SECRET 未配置");
  });

  it("rejects example placeholder values", () => {
    process.env.ADMIN_PASSWORD = "change-me";
    process.env.ADMIN_SESSION_SECRET = "x".repeat(48);
    expect(() => assertDeployableAdminCredentials()).toThrow("示例值");

    process.env.ADMIN_PASSWORD = "a-strong-password";
    process.env.ADMIN_SESSION_SECRET = "replace-with-a-long-random-secret";
    expect(() => assertDeployableAdminCredentials()).toThrow("示例值");
  });
});

describe("validateAdminPassword", () => {
  it("validates against the configured password", () => {
    process.env.ADMIN_PASSWORD = "correct-horse";
    process.env.ADMIN_SESSION_SECRET = "x".repeat(48);

    expect(validateAdminPassword("correct-horse")).toBe(true);
    expect(validateAdminPassword("wrong")).toBe(false);
    expect(validateAdminPassword("")).toBe(false);
  });
});
