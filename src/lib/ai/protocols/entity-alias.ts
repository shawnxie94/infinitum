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

  const decisions = parsed.decisions as unknown[];
  if (!Array.isArray(decisions) || decisions.length !== pairs.length) {
    throw new InvalidJsonModelResponseError("实体别名判定 decisions 数量与输入候选对不一致。");
  }

  return pairs.map((pair, index) => {
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
