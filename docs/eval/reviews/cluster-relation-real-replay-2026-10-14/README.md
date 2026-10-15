# MiniMax-M3 真实来源开发集回放：评分阻塞

规范记录：`sqlite://artifact/evaluation/cluster-relation-real-replay-2026-10-14`。新授权先于发送记录到 `sqlite://artifact/evaluation/cluster-relation-real-replay-authorization-2026-10-14`。

## 执行事实

- 本轮用户明确请求真实回放，并允许使用本地 Docker 库的 API 配置。只读核对本机 desktop-linux/unix socket、infinitum、/app/data/dev.db 中 cluster_merge 有效默认配置：MiniMax-M3 / https://api.minimaxi.com/v1。
- `scripts/replay-cluster-relation-source.ts` 只在进程内读取所选配置的已有密钥，无密钥值落盘、输出、写回或注册。没有读取其他模型的密钥。输出检查阻止密钥回显；不保存请求 Authorization 头。
- 源包及两臂消息不变，使用原始冻结 6 dev（SR-02/04/05/06/08 + FN-01），temperature=0/max_tokens=2000；不添加 response_format、reasoning_split、业务 Prompt 或标签提示，不切换 provider/model。
- 真实基线、草案各发送 **1 次**，收到 **2 次 HTTP 200**，返回模型均为 MiniMax-M3，**0 重试**。授权在发送前一次性消费，进程崩溃/网络不确定亦不可复用。当前预算已消耗，不自动重跑。
- 原始完整 provider JSON（含原始 content/usage）、时间、请求/回复 SHA 保存为 `*.model-receipt.json`；明确区别于前期模拟回执。真实 HTTP 与注入测试 transport 分开标记，测试结果不冒充网络执行。凭本机执行日志和可信 SHA 留证，不宣称厂商密码学签名。

## 结果：不能评分或比较

| 臂 | Provider finish_reason | 协议问题 | 输入 token | 输出 token | 总 token | 耗时 |
|---|---|---|---:|---:|---:|---:|
| baseline | stop | message.content 为闭合 `<think>…</think>` 推理段 + JSON，不是约定的纯 JSON | 15,754 | 1,201 | 16,955 | 19.284s |
| candidate | length | 达 2,000 token 上限；仅返回闭合推理段，尚未输出 decisions JSON | 15,936 | 2,000 | 17,936 | 24.496s |

Provider 用量合计：输入 **31,690**、输出 **3,201**、总 **34,891 token**。耗时合计 43.780s。费用金额没有 provider 数据，未按未经核实的价格估算。

两臂严格评分均 protocol_failed；metrics=null、paired=null，不计成“不合并”，不补造缺失判定，不从基线外包装中抢救部分判定来宣称准确率。原始 model content 可用于协议故障定位，不能充当用户理由或独立人工证据。**这轮没有基线/草案效果结论。**

这暴露的是当前回放封装对 MiniMax 推理输出的适配缺口和冻结输出预算不足，不是 v2 语义改善/退步证据。未修改严格评分规则、Prompt、标签或旧包来让本轮通过。

## 验证与锚点

- 新增 14 项授权/网络预算/密钥保护/截断/协议失败/模型身份/回执完整性测试，与前期共 **86/86 通过**；定向 ESLint 通过。
- 实际执行已验证：授权→本机只读配置→每臂一次真实请求→原始回执/用量留存→严格校验失败→失败报告/manifest。
- 非网络的回执重新加载、文件 hash、授权/来源/请求绑定和报告重建均一致；CLI 正确以 exit 2 表示不可评分，不等于证据文件损坏。验证命令不得当成自动重发。

```bash
node_modules/.bin/tsx scripts/replay-cluster-relation-source.ts --verify \
  docs/eval/reviews/cluster-relation-real-replay-2026-10-14 \
  739685c4fad3292fe951bfa04140acd7d6afa018935765a835c86f7146e79021
```

- 源包可信 manifest SHA：`1495ed0fb7576e0304e9045554abb4ad77d18b88be7bf83bf454396146b4fb40`
- 本轮新授权 SHA：`b25901ee02731bb8a221500f17a8c1d556a948296d0f4b7ef7948bbaa478debe`
- 执行 manifest SHA：`739685c4fad3292fe951bfa04140acd7d6afa018935765a835c86f7146e79021`

README 是执行 manifest 以外的人读解释，原始回执/授权/消费锁/失败报告不可覆盖；执行 SHA 同步外部 SQLite Artifact。

## 后续门槛

需新授权才能额外付费：建议先确认 MiniMax 推理分离/JSON 输出参数支持，再冻结一份明确版本的两臂传输参数覆盖层，提高双方输出上限（例如 8192），保持相同来源输入和现有业务 Prompt；两臂各 1 次、0 重试。不能覆盖本轮原请求/回执或直接重用已消费授权，不得只把失败状态改成成功。

独立盲标 follow_up 仍 0、SR-01 隔离、holdout 不参与、生产 DTO 不等价。本次未改 Docker 库/配置、线上 Prompt、gold、旧草案或生产行为，未 stage/commit/push。任务处于 blocked：需要用户新授权并先冻结有推理输出适配/更高 token 上限的新传输契约，才能得到完整两臂评分。
