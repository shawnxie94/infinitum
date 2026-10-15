# MiniMax-M3 来源开发集真实对照 v2

规范记录：`sqlite://artifact/evaluation/cluster-relation-real-replay-v2-2026-10-14`。
新授权记录：`sqlite://artifact/evaluation/cluster-relation-real-replay-v2-authorization-2026-10-14`。

## 本轮范围

用户在明确「两臂各 1 次、0 重试、8,192 token 上限、推理输出适配」后回复「可以」。使用本机 Docker 原有 cluster_merge 默认 MiniMax-M3 连接配置，readonly SELECT 取选中配置的凭据，仅用于进程内 HTTP 头，不输出或落盘。

这不是重写前轮：独立 v2 sender、授权、消费锁、冻结 wire、原始回执和结果全部另存；前轮 2,000 token 的失败记录/代码保留原样。source packet、6 对 dev、两臂消息、业务 Prompt 和严格评分规则均不变；每臂唯一的系统差异仍是此前未应用的 v2 业务片段。两臂统一覆盖 `max_tokens=8192`、`reasoning_split=true`；不禁用 thinking，不添加 response_format、不更换模型或 endpoint、不造结构化事件信息。

### 参数依据

[parameter-evidence.json](parameter-evidence.json) 记录官方中英文文档的标题、URL、访问时间和关键参数。两份文档来自同一发布者，缺跨发布者验证；真实响应进一步验证该端点的分离行为。

- [OpenAI SDK（中文）](https://platform.minimaxi.com/docs/api-reference/text-openai-api)
- [OpenAI SDK（英文）](https://platform.minimax.io/docs/api-reference/text-openai-api)
- accessed_at：2026-10-14T13:55:41+00:00

文档明确 reasoning_split 是输出格式开关，true 将推理移到 reasoning_content；max_tokens 也包含思考 token。保留原有兼容长度字段，不切换为 max_completion_tokens。生产传输另有 JSON 模式和 MiniMax disabled-thinking，本轮不引入这些模式变化，因此**不声称生产 DTO/推理模式等价**。

## 真实执行与结果

两臂各 **1 次 HTTP 200**，返回模型均 MiniMax-M3、finish_reason 均 stop，每臂均有完整、纯 JSON 的 6 条合法判定，推理文本单独保存在原始 provider reply。没有剥离 think、围栏、修复 JSON 或逐条抢救后偷换分母。完整原始响应及 usage、dispatch/请求 hash 留在 `*.model-receipt.json`；只解析 message.content，推理不能充当判定或人工 rationale。

| 指标（6 对 dev；仅与现有标签比较） | baseline | candidate |
|---|---:|---:|
| 五分类一致数 | 4/6（66.7%） | 5/6（83.3%） |
| 决定性合并/不合并一致数 | 5/6（83.3%） | 6/6（100%） |
| 决定性覆盖率 | 6/6 | 6/6 |
| 误并 | 0/3 已知非同一 gold | 0/3 |
| 漏同一（含暂缓） | 1/3 同一 gold | 0/3 |
| uncertain 暂缓 | 0 | 0 |

唯一分类变化：**SR-06：follow_up → same_event**，与保存的人工 same_event 标签一致，漏并少 1。

未解决：**FN-01** 两臂都返回 unrelated，保存的标签为 follow_up；该标签仍是 assisted_human_confirmation，不能当作独立盲标正例，也不因模型输出自动改变。SR-06 后续 rationale 经辅助确认的事实保留，不能冒充新增独立人工解释。

分组保持分离：初始用户标签组 5 对，一致数 4/5→5/5；FN-01 辅助确认组 1 对，一致数两臂均 0/1。没有把辅助标签并入独立盲标结论。

### 用量和耗时

| 臂 | 输入 token | 输出 token（provider报告） | 总 token | provider缓存输入 token | 耗时 |
|---|---:|---:|---:|---:|---:|
| baseline | 15,754 | 1,126 | 16,880 | 15,744 | 17.330s |
| candidate | 15,936 | 1,333 | 17,269 | 128 | 19.869s |
| 合计 | 31,690 | 2,459 | 34,149 | 15,872 | 37.199s |

这是本轮而非累计用量。缓存不对称、单次运行存在随机性，不能据耗时声称 Prompt 更快/更慢。provider 未报费用金额，不用未经核实的价格估算；usage 不等于计费金额。保留完整原始 usage，不凭字符长度补造思考 token 数。

## 验证与信任锚

- 新增 14 项 v2 传输/授权/冻结/失败/密钥保护测试，与旧版本回归共 **100/100 通过**；新代码定向 ESLint 通过。
- 验证的真实链路：新授权与冻结原文 wire→只读 Docker 配置→两次真实 HTTP→完整原始回执→每臂严格六对覆盖→读取固定标签→两臂及 provenance 分组评分→保存报告→带外部 SHA 重建一致。
- 模拟注入 transport 明确标记 synthetic，不能冒充本轮真实 HTTP；失败仍 metrics/paired=null，旧 v1 的失败不补算为通过。
- 运行目录消费锁已使用，禁止再调用发送或复制授权到新目录复用；复制文件不是新授权。它是本次可信本地操作的消费记录，不是防恶意复制的全局 capability 服务。

```bash
node_modules/.bin/tsx scripts/replay-cluster-relation-source-v2.ts --verify \
  docs/eval/reviews/cluster-relation-real-replay-v2-2026-10-14 \
  f84144d09961a55b3895756ca285d1662a2443a010f48aa7cf5191ab9cf86fc1
```

- 源包锚：`1495ed0fb7576e0304e9045554abb4ad77d18b88be7bf83bf454396146b4fb40`
- v2 新授权锚：`46ff34dde2f13d1acdbf135645c8fc313ae6e2308b49fd8de139311b0ae6ab00`
- v2 执行锚：`f84144d09961a55b3895756ca285d1662a2443a010f48aa7cf5191ab9cf86fc1`

README/参数引用属于清单之外的解释文件，核心授权/wire/消费锁/dispatch/回执/结果的执行 SHA 同步 SQLite Artifact。

## 结论与未完成项

**本轮来源增强 dev 有一例标签一致性改善，尚不足以支持上线或独立效果结论。** 单次/每臂 6 对不是统计显著性验证。qualityPassed=false、releaseEligible=false、holdoutMeasured=false、productionDtoEquivalent=false。

- 独立盲标 follow_up 正例仍为 0；FN-01 关系边界仍未验证，不用本轮错误热调 Prompt。
- 待核 SR-01 及 SR-03/07/FN-02 holdout 未参与请求或评分，不按其错误调参。
- 下一阶段先补独立盲标和生产 DTO/候选准入验证；新付费请求仍须另行授权。本次 v2 业务片段未应用线上。
- 本轮只完成 v2 对照/诊断，前轮失败永久保留为历史结果。未改 Docker 配置/业务数据、源码生产策略、旧 gold 或冻结材料，未 stage/commit/push。
