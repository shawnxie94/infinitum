import { normalizeModelResponseText } from "@/lib/ai/response-format";
import { getJsonParseErrorMessage } from "@/lib/ai/provider-client";
import { InvalidJsonModelResponseError } from "@/lib/ai/provider-types";
import type { EntityAliasCheckConfidence, EntityAliasCheckDecision } from "@/lib/ai/provider-types";


export function parseEntityAliasDecisions(
  rawContent: string,
  pairs: Array<{ aName: string; bName: string; evidence: string[] }>,
): EntityAliasCheckDecision[] {
  const normalized = normalizeModelResponseText(rawContent);
  let parsed: { decisions?: unknown };

  try {
    parsed = JSON.parse(normalized) as { decisions?: unknown };
  } catch (error) {
    throw new InvalidJsonModelResponseError(
      `Invalid entity alias decision JSON: ${getJsonParseErrorMessage(error)}`,
    );
  }

  // decisions 缺失或不是数组属于整体协议失败，交由上层 JSON 重试；数量不齐只保留
  // 可对齐的前缀（调用方按下标 zip 且以 decisions.length 为界），缺失对保守跳过本轮。
  const decisions = parsed.decisions;
  if (!Array.isArray(decisions)) {
    throw new InvalidJsonModelResponseError("实体别名判定 decisions 必须是数组。");
  }

  const alignedPairs = pairs.slice(0, decisions.length);
  return alignedPairs.map((pair, index) => {
    const raw = decisions[index] as Record<string, unknown> | undefined;
    const isSameEntity = raw?.isSameEntity === true;
    const rawConfidence = raw?.confidence;
    const confidence: EntityAliasCheckConfidence =
      rawConfidence === "high" || rawConfidence === "medium" ? rawConfidence : "low";
    const canonicalName =
      isSameEntity && typeof raw?.canonicalName === "string" && raw.canonicalName.trim()
        ? raw.canonicalName.trim()
        : null;

    return {
      isSameEntity,
      confidence,
      canonicalName,
    };
  });
}
