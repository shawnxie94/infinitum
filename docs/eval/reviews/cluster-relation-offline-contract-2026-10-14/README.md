# 离线来源关系输入契约 v1

规范冻结：`sqlite://artifact/evaluation/cluster-relation-offline-contract-2026-10-14`。

## 已实现

`scripts/prepare-cluster-relation-source-replay.ts` 是独立离线 CLI，没有 provider/client、数据库、网络或密钥读取代码，也没有发送模式。输入选择固定为 **SR-02/04/05/06/08、FN-01** 共 6 个 dev；SR-01 待核，以及 SR-03/07/FN-02 的 holdout 均不进入请求。选择/数据状态变化须重新审查，不把此工具当通用生产准入器。

```bash
# 生成到新目录，已存在的目录一律拒绝覆盖
node_modules/.bin/tsx scripts/prepare-cluster-relation-source-replay.ts --out <new-packet-dir>

# 校验当前冻结；末尾可指定来自 SQLite Artifact 的外部可信 manifest SHA
node_modules/.bin/tsx scripts/prepare-cluster-relation-source-replay.ts --verify \
  docs/eval/reviews/cluster-relation-offline-contract-2026-10-14/packet \
  1495ed0fb7576e0304e9045554abb4ad77d18b88be7bf83bf454396146b4fb40
```

## 输入与两臂对照

- [packet/input.json](packet/input.json)：保留 `pairs/pair_id/left/right` 外形，批内 ID p1～p6；每侧为一个来源记录，`id` 就是原始 source ID，不伪造线上 cluster ID。
- 只传原始标题、完整保留正文/完整版本发布说明、来源 URL/单位和来源发布时间。FN 使用完整发布说明，不把此前挑选的短摘录当全文。
- 新字段 `sourceEvidence` 是**实验性来源证据扩展**；`itemCount=1` 只表示每侧一个来源单元，不表示线上真实簇计数。summary 和缺失结构化事件签名都为 null；不造事件主体/动作/日期，不把 publishedAt 当 eventDate。
- 人工标签、理由、reviewer、dev/holdout 信息、样本编号和 gold 文件内容不进入模型消息。独立 [packet/mapping.json](packet/mapping.json) 仅供配对/后续获授权的评分，不能作为消息发送。
- [基线请求](packet/baseline.request.json) 的系统 Prompt 精确复用当前代码契约；[候选请求](packet/candidate.request.json) 仅在该系统 Prompt 后追加未应用的 v2 业务片段。二者用户包装、源输入和生成参数完全一致：temperature=0、maxTokens=2000。
- 沿用现有 decisions/pair_id、五类关系及对应 reasonCode 协议，只有 same_event 可合并。候选不是完整重写的线上 Prompt，基线与候选均是本实验的来源增强轨道。

**这不是生产 DTO 等价回放。** 当前生产输入并未自动附带这些来源全文；本包也未重新运行候选准入。未来对照至多衡量这个来源增强 dev 切片，不能声称生产端到端质量或独立 holdout 效果通过。

## 冻结与验证

[packet/manifest.json](packet/manifest.json) SHA256：

`1495ed0fb7576e0304e9045554abb4ad77d18b88be7bf83bf454396146b4fb40`

清单锚定源文件、原标签、待核状态、v2 草案、代码拥有的系统 Prompt/契约及冻结器源码。校验器除检查 hash，还从原来源重建输入/映射/两臂消息，防止只更新局部 hash 后注入替代正文、标签提示或不对称用户消息。单独工作区 SHA 文件只做一致性检查；正式使用应再以 SQLite Artifact 的可信 SHA 校验。

- `cluster-relation-offline-input` 新增 18 项测试，配合已有契约/协议测试，共 **39/39 通过**。
- 两个新增代码文件定向 ESLint 通过。
- 真正的“生成→加载→校验”链路已运行，6 对冻结成功、requestsSent=0。
- 单测覆盖 pending/holdout 排除、标签/理由不入请求、日期不偷换、完整发布正文、两臂对称、不可覆盖、篡改/可信锚拒绝，以及禁止冒充生产验证。

这些是输入与安全边界验证，不是模型分类效果测试。FN-01 仍为辅助确认，新增独立盲标 follow_up 正例为 0；SR-06 后补理由来源亦保留在引用审计。

## 下一步门槛

当前 provider/model 均为 null、sendAllowed=false、readyForReplay=false，上一轮付费授权不复用。若要执行两臂模型对照，需另行明确 provider/model、预算（预计两臂各一次、重试限制）和授权，并另建发送/回执/评分阶段；本 CLI 即使收到参数也无法自行发送。独立盲标及真正生产 DTO 验证仍是后续事项。未改线上 Prompt、策略、阈值或旧 gold。
