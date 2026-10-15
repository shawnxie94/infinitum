# 离线回执与评分链路（仅模拟验证）

规范记录：`sqlite://artifact/evaluation/cluster-relation-offline-scoring-2026-10-14`。

已实现 `scripts/score-cluster-relation-source-replay.ts` 与 `tests/unit/cluster-relation-offline-score.test.ts`，不改此前冻结器或请求包，不访问网络、密钥、模型客户端或业务数据库，也没有发送模式。

```bash
# 明确标记的模拟回执→严格校验→读取独立标签文件→评分→报告
node_modules/.bin/tsx scripts/score-cluster-relation-source-replay.ts --mock <new-dir>

# 对本次真实跑通的模拟链路重建并校验
node_modules/.bin/tsx scripts/score-cluster-relation-source-replay.ts --verify-mock \
  docs/eval/reviews/cluster-relation-offline-scoring-2026-10-14/mock

# 离线评分只启用显式 simulation 模式；输出目录不得已存在
node_modules/.bin/tsx scripts/score-cluster-relation-source-replay.ts --score \
  <packet-dir> <trusted-manifest-sha> <baseline-receipt> <candidate-receipt> <new-out> simulation
```

## 回执契约与错误处理

每个 envelope 必须包含 schemaVersion=1、kind、arm、manifestSha256、requestSha256、responseSha256、rawResponse，拒绝额外字段。评分前以外部可信 manifest SHA 验证旧请求包及原来源/标签，再把每臂回执绑定到该臂冻结请求，原始回复 hash 不得变化。

模型输出按既定 decisions 五字段严格校验：每个 pair_id 恰好一次，允许乱序；confidence 为 0～100 整数、relation/reasonCode 对应、reasonText 有非空中文。缺失、重复、未知 ID、非法字段、损坏 JSON、代码围栏、旧 verdict 格式均令该臂 protocol_failed，其 metrics=null；不抢救后偷换分母，不把缺失判成“不合并”。合法另一臂可单独显示，但任一失败时 paired=null。CLI 保留失败报告并退出 2。

这是**离线评测的严格协议**，不修改生产 parser 的逐条容错/旧格式兼容/JSON 修复行为。本阶段主动拒绝 model_receipt：真实回放仍需另建授权、执行与可验证回执阶段，不能只把模拟 envelope 的 kind 改名就当真实结果。

## 指标定义

- relationAccuracy：五分类相等数 / 全部完整合法 pair 数。
- binaryAccuracyOnDecisive：只在 gold 已知且预测非 uncertain 的 pair 上比较合并/不合并，另报 decisiveCoverage；不把 uncertain 奖励为正确的确定性拒并。
- falseMerge：已知非 same_event 的 gold 被预测 same_event；falseMergeRate 分母为 gold 已知非同一事件数。
- missedSame：gold same_event 未预测 same_event，包括暂缓人工审核；另列 explicitRejectedSame 与 heldSame，避免把暂缓和明确拒并混淆。分母为 goldSame。
- abstentions 单独计数；gold uncertain 不进入二分类/误并已知负例分母。所有零分母率、无法定义的率差为 null，而非 0。
- 输出五类混淆表、逐 case 的 merge/do_not_merge/manual_hold 路由、两臂配对变化及差值；FN-01 的 assisted_human_confirmation 单列，不冒充独立盲标证据。

## 已验证

- 新增 **33 项**评分/回执/CSV测试；结合输入、现有契约和协议测试，共 **72/72 通过**。
- 新增代码文件定向 ESLint 通过。
- 实际 CLI 已跑通 6 对模拟 envelope→校验→读取标签→两臂评分→报告→重建验证，requestsSent=0。
- 单独实际调用 CLI 验证缺一条 decision：退出 2、候选 metrics=null、paired=null，无假“不合并”结果。
- 支持含逗号、换行、双引号、BOM/CRLF 的 CSV 理由；只选择固定 6 个 dev，待核 SR-01 及所有 holdout 不参与评分。

[mock/](mock/) 内均为 **simulation**。候选模拟结果刻意使用 gold，基线模拟结果刻意插入一个误并和一个 uncertain，只为了验证计数/错误路径；任何“改善”都是人为测试输入，不是模型效果，不说明 v2 优于基线。报告始终 modelBehaviorValidated=false、qualityPassed=false、releaseEligible=false、独立盲标 follow_up=0。

旧请求包信任锚仍为 `1495ed0fb7576e0304e9045554abb4ad77d18b88be7bf83bf454396146b4fb40`。本次未改标签、冻结数据、草案、生产 Prompt 或策略；未 stage/commit/push。下一步提交代码须用户确认；实际模型两臂对照须明确 provider/model 与预算并重新授权，随后才做真实发送和授权回执适配。
