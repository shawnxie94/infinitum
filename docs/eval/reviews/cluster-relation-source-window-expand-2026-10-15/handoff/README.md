# 辅助复核候选 PB-08～10

只交3组经正文初筛的候选，不把建议当确认标签。原文页面为 `review.html`（source-only静态渲染），全部整簇文章保留；空白模板为 `labels.blank.csv`，建议单列 `ai-suggestions.json`。因为本轮会披露建议，后续用户确认按assisted_human_confirmation记录，不称独立盲标/独立holdout。

- PB-08：建议same_event；同一路透三位消息人士的Anthropic IPO前拟推新模型消息，独特数字、背景和阶段一致。
- PB-09：建议follow_up；同一QwenBook项目从早期研发消息到云栖大会正式发布；名称空格、产品变体及官方原始发布仍需确认，不保证报道事实真实。
- PB-10：建议same_event；两侧都是Step 5 Preview全量开放，参数、实验、权重时间表一致；右侧2篇已同簇原稿完整显示，不能省略。

相同品牌、基准比较或报道晚几小时本身不是关系证据。Gemini跨实验室长文不因共享事件片段就硬判same_event，初始Step发布与后续访问阶段也不强判，详见deferrals.json。

真实6簇、7篇原文；已排除旧身份/家族与已披露评审，不拆同簇造对。本批明显较旧：从30天source池抽取，不能据此直接称当前7天生产队列漏并，不复现准入/缓存/约束/向量/触发条件，也不调用PairDTO/模型。独立新正例gold仍0、质量/发布/回放门为false。

结构校验：

`node_modules/.bin/tsx .agent/tmp/cluster-relation-source-window-expand/prepare-handoff.ts --verify`

校验只证明hash、原文/摘句/真实全簇成员、出处不复用、空gold及渲染一致，不证明助手语义建议正确。保留原文未核验源站完整性/外部事实，主题holdout独立性未证明。
