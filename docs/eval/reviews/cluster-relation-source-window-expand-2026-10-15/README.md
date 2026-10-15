# 30天原文扩窗与内容初筛

规范记录：`sqlite://artifact/evaluation/cluster-relation-source-window-expand-2026-10-15`。

本轮按用户新流程先由当前会话助手读原文初筛，再交少量可行候选；不把AI建议当人工确认或独立盲标。

## 范围与来源

只读本地Docker SQLite，一致事务，query_only/-readonly，无密钥/额外模型/embedding/外网补文/业务写入/提交。新源窗为簇latestPublishedAt向前30天，保留整簇全部有效原稿，成员可能更早；不是公共feed的items.createdAt语义变更，也不是线上参数变更。

诊断查询保留sourceGate与旧来源隔离，放宽状态为有有效成员的真实簇并提高只读采样上限至1000；实际477个pool簇、未触达上限，簇状态库存实际均active。隔离旧20来源及递归后代、旧6人工负例、PB07已披露建议与先前正文复核路由/同簇控制，共32个已披露簇，按规范化出处追加来源隔离。共享业务脚本/Prompt/指纹和旧冻结包未改。

243篇原稿/216簇中，169簇/192篇符合整簇材料与保留文本门槛。相对上轮7天冻结池，新增135个完整簇、155篇有效原文；余34簇只是之前标题初筛的未交付材料，不冒充新来源。通览新增135簇标题，全文读取9簇10篇保留原文，从中留下3组6真实簇/7原稿，无拆簇造对，无跨case来源复用。

## 交给用户的复核材料

打开 `handoff/review.html`，完整读PB-08～10的A/B原文。原文页不含AI摘要/译题/签名/score/簇ID或建议高亮；空模板在 `handoff/labels.blank.csv`。建议已在对话披露，复核性质为辅助人工确认，不再声称独立盲标。

- PB-08，建议same_event：同一路透三位消息人士的Anthropic IPO前拟推新模型消息，关键数字、竞争背景、安全评估与阶段一致。
- PB-09，建议follow_up：同一QwenBook项目从早期研发试水/上市计划不明，到云栖大会正式发布。仅按现有原文认定名称差异为同一项目，产品变体与官方原始发布未独立核验。
- PB-10，建议same_event：均为Step 5 Preview全量开放，参数/实验/权重安排一致，右侧两篇同簇原稿全部保留。

Gemini长文综合多家实验室事件，保留边界疑问而不强塞same_event；初始Step发布/全量开放对也因阶段表述和与PB10来源复用而不交。出处与理由在 `handoff/deferrals.json`，不作为gold。

## 锚链与验证

阶段一原文捕获 manifest SHA：`fd48e8f34f87c3a247009594e786b65ebe4751df0143d8d0bdcab7a610bc65fd`。

阶段二辅助复核 handoff SHA：`0481b7d87f7b9077f4f6d0d7a90c8febb7a22bc61596ecc7718a4c23968110bf`。

阶段一report的handoffCandidates=0/status=new_sources_require_content_prescreen是内容初筛前冻结状态，保持不改；阶段二 `handoff/report.json` 才是初筛后3个候选的状态，显式绑定前阶段。

```bash
node_modules/.bin/tsx .agent/tmp/cluster-relation-source-window-expand/probe.ts --verify
node_modules/.bin/tsx .agent/tmp/cluster-relation-source-window-expand/prepare-handoff.ts --verify
```

验证涵盖前包引用、代码/文件SHA、窗口SQL重建、状态与真实全簇成员、原始材料/摘句、已知出处家族不复用、静态渲染、空CSV和空gold。只验证结构与来源，不保证AI关系建议正确。CodeGraph索引有6个pending新增、未覆盖本次临时采样与新捕获助手；实际小范围SQL/材料路径来自现行文件读取，未擅自重建索引。

## 限制与下一步

这批是30天原文种子，年龄较旧，不是当前7天生产准入队列回放。未复现候选准入/hash/缓存TTL/约束/向量/触发范围，不因历史真实簇中存在相近报道就声称线上漏并，不直接调用PairDTO/模型。源站全文完整性、报道外部真实性和主题/事件holdout独立性仍未验证。

所有humanRelation/humanEvidence/gold仍null；新人工确认0、独立新正例gold0；qualityPassed/releaseEligible/readyForModelReplay=false。用户确认须保存实际回执、关系及依据，并标明assisted_human_confirmation；不得凭同意建议就升级成独立gold，亦不得转移源级gold充当cluster gold。任何额外模型请求仍须另行授权。
