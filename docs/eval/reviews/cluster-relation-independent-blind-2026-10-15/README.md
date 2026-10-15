# 原文配对盲标候选

打开 [blind.html](blind.html)，阅读每对 A/B 两侧的全部保留文本，独立填写关系、原文依据并导出标注。也可填写 `labels.blank.csv`。不要在标注前查看核验 Artifact、映射或任何关系建议。

- `same_event`：同一具体事件；`follow_up`：同一事件链的新进展；`synthesis`：同主题不同事件的综合报道；`unrelated`：无直接事件关系；`uncertain`：依据不足。
- 时间栏为报道发布时间，不等于事件发生日期。文本来自既有系统保留字段，未联网核对源站完整性。
- 这是候选材料，不预设类别分布；当前人工标签为零，不代表评测或上线效果已通过。
- 采样基于当前源码对只读快照执行的规则/保留缓存路径；未执行新 embedding、模型调用、运行镜像对齐或生产端到端验证。

来源核验与生产只读快照：`sqlite://artifact/research/independent-blind-candidates-production-2026-10-15`。标注完成后再查看。
