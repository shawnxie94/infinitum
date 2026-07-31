# 实体模型改造说明

## 目标

Infinitum 不再要求 AI 独立输出 `entities`。文章实体关系由结构化事件字段自动生成：

- `eventSubject`
- `eventObject`
- 聚合拆分后的子事件主体和对象

## 数据模型

实体链路使用独立表：

- `entities`：实体规范名
- `entity_aliases`：实体别名
- `item_entities`：文章与实体关系
- `entity_suggestion_candidates` / `entity_suggestion_decisions`：实体治理

旧 `tags`、`tag_aliases`、`item_tags`、Tag 治理表和 `feedTagsJson` 已在迁移中直接删除。运行时代码、API、配置和 UI 不再访问或兼容旧 Tag 链路。

## 历史回填

`publishedAtKnown` 对历史已有条目采用兼容性默认值 `true`，因为旧版本没有记录发布时间是否来自 RSS；新抓取条目会准确记录该可信度。无法可靠区分历史 fallback 时间时，不执行猜测式批量改写。

部署迁移会自动根据 `createdAt` 最新的 500 条历史内容回填实体关系，不读取或迁移旧标签数据；`id` 仅作为同一时间的确定性排序兜底。这样首次升级后，当前速览、日报和公开 Feed 中更可能出现的内容会优先获得实体关系。Docker Compose 的 SQLite setup 会在检测到旧实体/Tag 结构的首次升级时执行该回填，随后不会在每次容器启动时重复执行。对同一条内容会删除不再由事件字段推导出的旧实体关系；事件字段本身和聚合指纹不会被修改。

如果历史内容超过自动回填上限，可在部署完成后手动续跑：

```bash
npm run entities:backfill -- --dry-run --batch-size 200
npm run entities:backfill -- --batch-size 200
```

脚本具备以下特性：

- 自动迁移优先处理 `createdAt` 最新的 500 条；手动脚本默认每批 200 条，单批最大 500 条，并会继续扫描全部历史内容；
- 别名命中时复用已有规范实体；
- 可重复执行，关系集合保持稳定；
- `--dry-run` 只统计，不写入；
- 完成后刷新受影响的聚合 Feed 统计、速览和日报缓存。

## 后续阶段

本阶段不让新增 alias 直接重写既有 `eventSubject/eventObject` 和历史聚合 fingerprint。实体关联回填完成后，新增内容会在抓取/聚合落库阶段自动生成实体关系。
