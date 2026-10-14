# Dev 建议落实与来源复核

规范记录：`sqlite://artifact/evaluation/cluster-relation-dev-recheck-2026-10-14`。状态：[dev-review-status.csv](dev-review-status.csv)；审计：[dev-recheck.json](dev-recheck.json)；免费来源抓取：[source-recheck.json](source-recheck.json)。

## 处理结果

- **SR-06 保持 same_event**。用户采纳助手建议：两篇可视为同一次千问 Go 亮相/体验开放的不同报道，共用 70 元理赔案例，“官方回应”字样本身不足以确立新发生。理由注明为助手建议后确认；原始人工标签及其来源不改，不能把新理由称为独立人工撰写。
- **SR-01 列为待复核**。follow_up 仍是待验证倾向，不是用户无条件提供的新标签。原 reviewed-v1.csv 的 same_event 保留为历史标注，但这条暂不作已定边界证据，不据其拟合 Prompt。

## 本次核对到的事实

1. AIbase [31173](https://www.aibase.com/zh/news/31173) 和 [31218](https://www.aibase.com/zh/news/31218) 的当前页面标题与冻结来源一致，正文分别有“计划近期开放源代码”和“已将代码在 GitHub 上开源”、审计结论。访问时间为 2026-10-14T11:24:58/59+00:00，抽取器 defuddle。两篇同一媒体的报道不算独立交叉验证。
2. GitHub 公开 API 返回 zai-org/ZCode 仓库，created_at=2026-09-20T12:01:16Z。**仓库创建时间不是公开开源时间或官方公告时间**，不能单凭它锁定两篇的事件身份。
3. v3.14.0 release API 返回 404；不据此宣称版本没有发布，也没有补造发布时间。
4. 后篇截图只有“今天”“ZCode 开源”等字样，没有可识别的绝对公告日期。图名/上传路径的日期不当作事件日期；图片 SHA256 见审计，原始截图随 SQLite Artifact 保存。

## 尚未解决

缺初始及后续官方公告的可识别日期/ID，无法确证是同一次声明的不同报道，还是后续另一次正式开源/审计公布。当前证据只能支持新增动作线索，不能将 tentative follow_up 自动提升为 gold。

用户“按你建议处理吧”按此前的条件建议执行：保留 SR-06，先复核 SR-01。**没有修改任何确定标签、冻结材料、holdout 或线上 Prompt。** 原批计数仍为 5 same_event / 2 synthesis / 1 unrelated；SR-01 的待核状态以本条规范审计覆盖使用资格，而非覆盖历史标签文件。

来源/标签保留和状态一致性校验通过，0 新增模型或付费调用，不计算效果指标。下一步须定位原官方公告，或由用户明确修改 SR-01 标签；在此之前保持待核，不继续围绕这一争议条目调 Prompt。任何新付费对照仍需新授权。
