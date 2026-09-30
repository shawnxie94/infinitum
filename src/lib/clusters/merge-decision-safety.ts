import type { ClusterMergeDecision } from "@/lib/ai/provider-types";

export type ClusterMergeDecisionConsistencyIssue =
  | "explicit_negative_reason"
  | "unrelated_structured_entities";

export type ClusterMergeDecisionConsistencyAudit = {
  status: "downgraded";
  issueCodes: ClusterMergeDecisionConsistencyIssue[];
  original: {
    verdict: ClusterMergeDecision["verdict"];
    confidence: number | null;
    reasonCode: ClusterMergeDecision["reasonCode"];
    reasonText: string | null;
  };
  effective: {
    verdict: "ambiguous";
    reasonCode: "insufficient_evidence";
  };
};

const EXPLICIT_NEGATIVE_REASON_PATTERNS = [
  /(?:不是|并非|并不是)(?:完全)?同一(?:个)?事件/u,
  /(?:两个|两条|两则|两件).{0,5}不同的?事件/u,
  /(?:事件|主体|对象).{0,6}(?:无关|不相关)/u,
  /(?:不应当|不应该|不应|不该|不建议|不能|不可)(?:自动)?合并/u,
  /(?:应该|应当|建议|必须)拒绝(?:合并)?/u,
  /拒绝合并/u,
  /(?:not the same event|different events?|unrelated|should not merge|do not merge|reject(?: the)? merge|decline(?: the)? merge)/i,
];

function hasExplicitNegativeReason(reasonText: string | null) {
  if (!reasonText) {
    return false;
  }

  // 避免把“无需拒绝合并/不应拒绝合并”误判为反对合并。
  const normalized = reasonText
    .replace(/(?:不(?:应当|应该|应|该|建议|需要|能|必)?|无需)\s*(?:拒绝|否决|阻止)(?:合并)?/gu, " ")
    .replace(/\bnot\s+(?:unrelated|different|separate)\b/gi, " ");
  return EXPLICIT_NEGATIVE_REASON_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function reconcileApprovedClusterMergeDecision(
  decision: ClusterMergeDecision,
  pairSafetyReason: string | null,
): { decision: ClusterMergeDecision; audit: ClusterMergeDecisionConsistencyAudit | null } {
  if (decision.verdict !== "approved") {
    return { decision, audit: null };
  }

  const issueCodes: ClusterMergeDecisionConsistencyIssue[] = [];
  if (hasExplicitNegativeReason(decision.reasonText)) {
    issueCodes.push("explicit_negative_reason");
  }
  if (pairSafetyReason === "unrelated_subjects") {
    issueCodes.push("unrelated_structured_entities");
  }

  if (issueCodes.length === 0) {
    return { decision, audit: null };
  }

  const issueText = issueCodes.map((issue) =>
    issue === "explicit_negative_reason"
      ? "理由文本明确反对合并"
      : "主体与对象均无结构化关联",
  ).join("；");
  const reasonText = decision.reasonText?.trim() || "（原始理由为空）";
  const downgraded: ClusterMergeDecision = {
    ...decision,
    verdict: "ambiguous",
    reasonCode: "insufficient_evidence",
    reasonText: `一致性保护转人工复核：${issueText}。原始 AI verdict=${decision.verdict}，reasonCode=${decision.reasonCode}；原始理由：${reasonText}`,
  };

  return {
    decision: downgraded,
    audit: {
      status: "downgraded",
      issueCodes,
      original: {
        verdict: decision.verdict,
        confidence: decision.confidence,
        reasonCode: decision.reasonCode,
        reasonText: decision.reasonText,
      },
      effective: { verdict: "ambiguous", reasonCode: "insufficient_evidence" },
    },
  };
}
