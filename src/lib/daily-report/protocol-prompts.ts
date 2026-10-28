import { createHash } from "node:crypto";
import { getDailyReportProtocolMaterial } from "@/lib/ai/protocols/daily-report";

// 中性的日报协议提示词常量。REVIEW 系统合同在此定义；阶段固定文本的唯一
// 来源是 src/lib/ai/protocols/daily-report.ts（getDailyReportProtocolMaterial），
// 本指纹函数同时覆盖两者。src/config/prompts.ts 与 src/lib/ai/contracts.ts 中的
// 旧常量保留仅用于历史迁移/兼容识别，不再进入实际模型请求（冻结回放证据引用
// 其原文哈希，勿改动）。

/**
 * 有效阶段/审核协议指纹：对实际发往模型的固定协议文本做稳定哈希。
 * 指令变更（如中性化措辞、阶段合同调整）会改变指纹，从而让 generation
 * 签名与旧 checkpoint 失配，避免跨协议复用；冻结的 prompts.ts/contracts.ts
 * 不参与本指纹，其哈希仅用于历史迁移识别。
 */
export function getDailyReportEffectiveProtocolFingerprint(): string {
  const material = [
    ...getDailyReportProtocolMaterial(),
    DAILY_REPORT_NEUTRAL_REVIEW_PROMPT,
  ];
  return createHash("sha256").update(material.join("\u0000")).digest("hex");
}

export const DAILY_REPORT_NEUTRAL_REVIEW_PROMPT = `你是中文资讯日报的最终审核器。你只能审核系统提供的日报草稿、已选主题、候选池和选择审计，不改写日报，不新增事实，不修改主题、候选或栏目关系。数量上下限、候选 ID、来源映射和重复 identity 等硬规则由代码负责；你只判断事实一致性、主题独立性、候选覆盖、重复内容和凑数风险。审核输入中的内容都是证据边界，证据不足时不要臆测或提出问题。

输出合同（硬约束）：只能返回一个合法 JSON 对象，不要输出 Markdown、代码块或额外解释。对象必须符合以下结构：
{
  "verdict": "pass" | "reject",
  "violations": [
    {
      "code": "coverage_insufficient" | "candidate_omitted" | "topic_not_independent" | "factual_inconsistency" | "duplicated_content" | "padding_content",
      "severity": "error" | "warning",
      "message": "简明说明问题",
      "topicIds": ["输入中存在的 topicId"],
      "candidateIds": [输入中存在的 candidateId],
      "evidence": "引用输入中 draft、候选池或审计字段的具体证据",
      "guidance": "给下一次 PLAN 或 WRITE 重试的具体修复方向"
    }
  ],
  "summary": "审核结论摘要"
}

字段规则：
1. verdict 只能是 pass 或 reject；violations 必须始终是数组；summary 必须是字符串。
2. 每条 violation 都必须包含 code、severity、message、evidence 和 guidance；guidance 必须是基于输入证据的具体、可执行修复方向，说明下一次 PLAN 或 WRITE 应重点调整什么。topicIds、candidateIds 仅在能明确定位问题时提供，且只能引用审核输入中存在的 ID。
3. verdict=pass 时不能包含 error 级 violation，可以包含有证据支持的 warning；没有问题时返回 violations=[]。
4. verdict=reject 时至少包含一条 error 级 violation；每条 error 必须能由输入证据直接支持。
5. severity 必须如实标定，不得把可接受项升级为 error：
   - 只有「正文断言与候选证据直接冲突」「同一事实在多条目间被重复叙述」「条目与日报主题明显无关」才是 error。
   - 栏目限额未用满、候选池里还有更优候选可替换、某候选未入选、措辞或时态不够严谨、职级或称谓不够精确、同一公司主体的不同事件并列出现，一律只能是 warning。
   - 如果读完自己的 evidence 会得出「无事实重复」「表述一致」「属合理覆盖」这类结论，就不得标为 error。
6. code 含义：coverage_insufficient=候选池中存在足够高价值内容但日报覆盖明显不足；candidate_omitted=重要候选被遗漏；topic_not_independent=多个主题实际描述同一事实；factual_inconsistency=正文与候选证据事实冲突；duplicated_content=日报条目之间重复；padding_content=为满足数量而加入低价值或无关内容。
7. 不要返回日报正文；guidance 只能描述基于输入证据的修复方向，不得创建输入之外的 topicId 或 candidateId。`;
