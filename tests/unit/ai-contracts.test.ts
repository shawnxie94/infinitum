import { describe, expect, it } from "vitest";

import {
  AI_TASK_CONTRACTS,
  buildAiUserContent,
  getAiTaskContract,
  normalizeAiUserInstruction,
} from "@/lib/ai/contracts";

describe("AI task contracts", () => {
  it("defines a fixed protocol for every configured AI task", () => {
    expect(Object.keys(AI_TASK_CONTRACTS)).toEqual([
      "item_understanding",
      "cluster_summary",
      "cluster_match",
      "cluster_merge",
      "daily_report",
      "daily_report_review",
    ]);

    for (const contract of Object.values(AI_TASK_CONTRACTS)) {
      expect(contract.systemPrompt.length).toBeGreaterThan(0);
      expect(contract.contractVersion).toBe("v1");
      expect(contract.contractHash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("removes legacy input placeholders from user instructions", () => {
    expect(normalizeAiUserInstruction("重点关注 {{title}}，正文 {{inputText}}。"))
      .toBe("重点关注 ，正文 。");
  });

  it("keeps user instructions and system-generated input separate", () => {
    const content = buildAiUserContent("优先关注安全影响。{{candidatesJson}}", {
      title: "测试标题",
      candidateIds: [1, 2],
    });

    expect(content).toContain("用户补充指令");
    expect(content).toContain("优先关注安全影响。");
    expect(content).toContain("系统生成的输入 JSON");
    expect(content).toContain('"candidateIds":[1,2]');
    expect(content).not.toContain("{{candidatesJson}}");
  });

  it("returns the fixed contract by task key", () => {
    expect(getAiTaskContract("daily_report_review").systemPrompt).toContain("输出合同");
  });
});
