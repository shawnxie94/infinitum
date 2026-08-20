---
id: ai-prompt-contract-boundary-optimization
type: execution_plan
status: completed
created_at: 2026-08-20
updated_at: 2026-08-20
sources:
  - src/config/prompts.ts
  - src/lib/ai/provider.ts
  - src/lib/settings/core.ts
  - src/lib/settings/runtime-service.ts
  - src/lib/settings/types.ts
  - src/lib/settings/prompt-config-service.ts
  - src/app/api/admin/settings/prompt-configs/route.ts
  - src/app/api/admin/settings/prompt-configs/[id]/route.ts
  - src/components/admin/ai-settings-panel.tsx
  - prisma/schema.prisma
  - scripts/setup-sqlite.mjs
  - docs/plans/daily-report-reviewer-context-usage-execution-plan.md
related:
  - docs/plans/daily-report-reviewer-context-usage-execution-plan.md
base_commit: f3fc14c05ff5f3f7d176b5989c2184cdc0febe9e
---

# AI 提示词协议边界优化执行计划

## 1. 变更摘要

### 目标

将所有 AI 任务统一改造成“代码拥有输入/输出协议，用户只配置业务补充指令”的链路，避免管理员自定义提示词改变模型的实际输入结构、输出 JSON 合同、枚举约束、候选 ID 边界、重试与发布安全规则。

覆盖任务：

- 条目理解 `item_understanding`
- 聚合摘要 `cluster_summary`
- 归组判定 `cluster_match`
- 聚合合并 `cluster_merge`
- AI 日报 `daily_report`
- AI 日报审核 `daily_report_review`

### 不变范围

- 每类任务仍可单独选择模型 API 配置。
- 温度、最大 Tokens、Top P 等采样参数仍可按任务配置。
- 日报模板仍是产品层的栏目/字段配置，不改造成普通用户提示词。
- Reviewer 的独立模型、开关、一次中间阶段重试、失败生成草稿但禁止自动发布等既有行为继续保留。
- 本计划不扩大到新的 AI 任务类型，也不在本阶段重写业务解析语义。

### 核心结论

当前问题的根因不是某个文本写得不够清楚，而是配置对象和运行时对象的职责边界错误：同一个 `PromptConfig` 同时承载了内部协议、用户指令、输入模板和运行参数。仅继续在各任务 system prompt 末尾追加几条固定规则，无法可靠阻止用户覆盖前面的协议。

推荐采用“代码拥有的任务协议注册表 + 数据库只保存用户补充指令和运行参数”的统一方案。Reviewer 当前的实现作为迁移过程中的参考模式，但不再为每个任务单独打补丁。

## 2. 当前链路与影响分析

### 2.1 当前配置链路

```text
Admin AI Settings
  -> POST/PUT /api/admin/settings/prompt-configs
  -> PromptConfig { prompt, systemPrompt, templateJson, sampling, model }
  -> serializeSelectedPromptConfig()
  -> RuntimeConfig.selectedPromptConfigs
  -> createAiProvider()
  -> resolvePromptConfig()
  -> messages[0] = 可被配置覆盖的 systemPrompt
  -> messages[1] = 用户模板渲染结果 + 代码输入
  -> 宽严不一的 parser / fallback
```

当前 API 仍要求 `systemPrompt`，设置服务仍把它作为运行时实际 system message 的来源，Provider 也对大多数任务直接采用该值。因此 UI 隐藏字段并不能形成真正的安全边界，API、数据库中的历史数据和运行时拼装仍可能绕过 UI。

### 2.2 各任务现状

| 任务 | 当前协议来源 | 当前解析保护 | 主要风险 |
|---|---|---|---|
| 条目理解 | 默认 system prompt；管理员 system prompt 可覆盖，仅追加少量固定枚举规则 | JSON 修复 + 字段级 fallback，允许部分字段退回 fallback | 用户可删除完整字段合同，模型输出缺字段时被 fallback 掩盖，协议漂移不易发现 |
| 聚合摘要 | 管理员 system prompt 可直接覆盖默认合同 | 只要求合法 JSON、`title` 和 `summary` 非空 | 长度、Markdown、不可编造等要求主要依赖用户可改文本 |
| 归组判定 | 管理员 system prompt 可直接覆盖默认语义 | 允许 JSON 失败后的正则兜底，只校验候选 ID | 用户可改变保守匹配规则；正则兜底可能接受非合同输出 |
| 聚合合并 | 管理员 system prompt 可覆盖；服务端只拦截少数旧协议标记 | 解析 decisions 并基于输入 metadata 归一化 | 用户可改变 verdict/reasonCode/逐 Pair 判断等核心要求 |
| AI 日报 | Provider 已有阶段合同；模板又会编译成 system prompt | 阶段级合同和校验较完整 | `PromptConfig.systemPrompt`、模板编译结果和用户配置仍共用字段，概念不清，后续容易回归 |
| AI 日报审核 | 已固定内部 system prompt；用户指令与审核输入分离 | Reviewer JSON 合同、证据字段、ID 校验和发布门禁 | 这是目标模式，但还没有抽象成所有任务共用的机制 |

### 2.3 受影响层

1. 配置模型：`PromptConfig` 的 `prompt/systemPrompt` 语义需要拆分。
2. API 合同：当前 POST/PUT schema 强制接收可编辑 `systemPrompt`。
3. 设置服务：序列化、校验、seed、迁移和运行时选择都依赖旧字段。
4. Provider：需要集中管理 system message、输入注入、用户指令和 parser。
5. 解析器：需要把“模型输出协议校验”和“业务容错 fallback”明确分层。
6. UI：所有普通 AI 任务都应显示用户补充指令，而不是 system prompt 编辑器或输入占位符维护器。
7. 任务可观测性：任务详情和 generation signature 需要记录协议版本/哈希，便于复现和评估。
8. SQLite 初始化与升级：需要保持旧数据库可幂等升级，不使用 Prisma migration history。
9. 测试和 Docker：需要增加消息级、恶意指令、旧配置迁移和真实 Compose smoke 验证。

## 3. 目标架构

### 3.1 任务协议注册表

新增代码拥有的 typed registry，建议放在 `src/lib/ai/contracts/`，按任务提供以下能力：

```ts
type AiTaskContract<TInput, TOutput> = {
  key: PromptConfigType;
  contractVersion: string;
  systemPrompt: string;
  defaultUserInstruction: string;
  buildInput: (input: TInput) => unknown;
  buildUserMessages: (input: TInput, userInstruction: string) => ChatMessage[];
  parseOutput: (raw: string, input: TInput) => TOutput;
  defaultSampling: SamplingConfig;
  allowsUserInstruction: boolean;
};
```

实际类型可以按现有 Provider 结构拆分，不要求一次引入完整泛型框架。最低要求是每个任务有独立且可测试的内部 system 协议、代码生成输入、输出 parser/validator、合同版本或稳定哈希、用户指令默认值。

### 3.2 配置职责拆分

目标运行时对象不再把数据库的 `systemPrompt` 当作实际 system message：

```text
代码注册表 systemPrompt / contract
  + 用户补充指令（user role，可为空）
  + 代码生成的结构化输入（user role，自动注入）
  + 代码控制的 parser / validator
```

建议分两步迁移：

1. 第一阶段新增 `userPrompt`（或 `userInstruction`）字段，保留旧 `prompt` 和 `systemPrompt` 用于兼容、审计和回滚；实际运行只读取新字段和代码注册表。
2. 第二阶段确认管理员完成迁移后，再移除或彻底标记旧字段。不要在 SQLite 迁移第一步直接删列。

对外管理对象应改为：`name`、`type`、`userPrompt/userInstruction`、日报专用 `templateJson`、采样参数、模型配置、启用/默认状态，以及只读的 `contractVersion/contractHash`。

过渡期可以只读返回旧 `systemPrompt` 的“内部协议由系统维护”状态，但不能继续作为用户可写字段，也不能从持久化值构造实际请求。

### 3.3 消息组装规则

每类任务统一遵循：

1. `system`：只放代码拥有的内部协议、输出合同、安全边界和任务职责。
2. `user`：放用户补充指令；该指令只能调整表达偏好、关注重点、语言风格等业务层偏好。
3. `user`：放代码序列化的输入对象。输入不依赖用户模板中的占位符。
4. parser/validator：只接受代码定义的输出合同；容错必须有明确的兼容模式和诊断记录。
5. 所有影响发布、候选 ID、主题关系、数据库写入和重试的判断，都必须由代码完成。

用户指令不再进入 `system` role，也不再负责维护 `{{inputText}}`、`{{candidatesJson}}`、`{{clustersJson}}` 等内部输入占位符。迁移时保留用户文本，但移除或忽略这些占位符，避免用户通过模板改变输入边界。

### 3.4 输出合同分层

每个任务的 parser 分成三层：

1. 语法层：合法 JSON、顶层类型。
2. 合同层：字段、枚举、数组、ID、空值和未知字段。
3. 业务层：长度、事实支持、候选覆盖、来源映射、数量上下限等确定性规则。

条目理解保留已有 fallback 作为最后安全兜底，但必须记录合同缺失诊断；不能把“部分字段成功 + 其他字段静默回退”当成协议校验通过。

## 4. 任务级目标合同

### 条目理解

固定 JSON 字段、枚举、事件结构、最大事件数和 JSON 字符串规则由代码协议维护；用户只配置摘要关注点、语言或编辑偏好。解析器区分完整合同成功、可修复 JSON、合同缺失后 fallback 三种结果。用户不能新增任意输出字段来影响实体关联、聚合拆分或过滤状态。

### 聚合摘要

固定输出 `{title, summary}`，长度、空值、格式和事实约束在业务校验层复核。用户只能调整摘要侧重点，不得要求补充候选之外的事实。

### 归组判定

固定输出 `{clusterId: string | null}`；ID 必须来自本次代码注入的候选集合。默认采用保守的同一具体事件判定，“主题相似”不能通过用户指令改成自动归组。正则兜底只在显式兼容模式使用，并记录 `legacy_parse` 诊断。

### 聚合合并

固定逐 Pair 输出 decisions、verdict、confidence、reasonCode、reasonText。Pair ID 只允许来自输入 metadata；`approved/ambiguous/declined` 与 reasonCode 的组合由代码校验。旧 `approvedPairs/mergeGroups` 仅在迁移兼容期识别并失败。

### AI 日报与审核

日报阶段合同继续由代码编译，日报模板作为产品配置保留，但内部阶段规则只读。Reviewer 继续使用当前固定协议、证据字段和发布门禁，并接入统一 registry。

## 5. 执行 DAG

### U1：协议盘点与 golden message 基线

冻结六类任务的输入、输出、parser、重试和持久化边界，产出 messages snapshot、合法/非法输出样本。无代码行为变化。依赖：无。

### U2：建立 typed contract registry

将 system prompt、输入构造、输出解析入口和 contract version 从 Provider 分散逻辑收拢，六类任务各有 registry entry。依赖：U1。共享代码由单一写入者维护。

### U3：补齐合同级 parser/validator

将语法、合同和业务校验分层，保留必要 fallback 但增加诊断。覆盖四个历史任务，日报阶段和 Reviewer 复用已有校验。依赖：U1、U2。

### U4：重构 Provider 消息组装

system message 永远来自 registry；用户补充指令和代码输入作为独立 user message 自动注入。即使传入恶意旧 `systemPrompt`，实际请求仍使用固定协议。依赖：U2、U3。

### U5：配置存储与运行时兼容迁移

新增 `userPrompt/userInstruction`，保留旧列过渡，改造 seed、序列化、运行时选择和 generation signature。未修改默认值迁移为安全用户指令；旧 system prompt 只留审计，不参与运行；迁移必须幂等。依赖：U2、U4。

### U6：管理 API 合同改造

POST/PUT 不再要求或接受用户可写 `systemPrompt`。过渡期可接受旧字段但忽略并返回固定协议摘要，随后删除字段并让非法请求失败。返回用户指令、只读协议版本/hash 和模型信息。依赖：U5。

### U7：管理 UI 改造

所有任务统一显示“用户补充指令”；隐藏 system prompt 编辑器和内部输入占位符帮助。可显示“内部协议：系统维护”、版本/hash 和只读状态。允许空补充指令。依赖：U6。

### U8：任务详情与评估可观测性对齐

在现有 token/context usage 外记录任务对应的 contract version/hash；任务详情展示模型、token/context usage 和统计来源，不泄露 API Key，提示词全文遵循敏感信息策略。补充指令配置 ID、parser 诊断摘要和更细粒度的调用审计作为后续可观测性扩展。依赖：U4、U5。

### U9：兼容、对抗和回归测试

覆盖六类 messages snapshot、恶意用户指令、缺字段/未知枚举/未知 ID/旧协议输出、旧配置幂等迁移、日报 Review retry/draft/no-publish、API/UI 只读协议展示。依赖：U3-U8。

### U10：Schema、构建和 Compose 发布验证

完成生成 schema、SQLite runtime upgrade、Next app、worker 和 Docker Compose 实际路径验证。依赖：U9。

关键路径：`U1 -> U2 -> U3/U4 -> U5 -> U6/U7 -> U9 -> U10`。Provider、schema、settings、API 和 UI 属于共享写入面，不建议并行改写；只读盘点和测试样本整理可以并行。

## 6. 数据迁移与兼容决策

推荐新增 `userPrompt`，保留旧 `prompt` 和 `systemPrompt` 一个过渡周期：

- `userPrompt`：新的用户补充指令，允许为空。
- `prompt`：legacy user template，运行时逐步停止读取。
- `systemPrompt`：legacy audit，运行时永不读取为用户协议。
- `templateJson`：仅用于日报产品模板。

不要把旧 system prompt 原样搬到 user prompt，否则只是把内部协议暴露从 system role 转移到 user role。旧模板中的输入占位符应失去输入职责，代码必须重新注入正文、候选池和 Pair metadata。已自定义配置保留审计值，并在管理页提示将业务偏好整理到用户补充指令。

generation signature、日报缓存键和任务快照必须带 contract version/hash，避免协议升级后复用旧结果。

## 7. 验证方案

### 静态和单元验证

```bash
npx tsc --noEmit
npm run lint
git diff --check
```

重点单元测试：`tests/unit/ai-provider.test.ts`、`tests/unit/ai-provider.daily-report-stages.test.ts`、`tests/unit/ai-usage.test.ts` 和新增的 `tests/unit/ai-contracts.test.ts`。

### 集成验证

```bash
vitest run \
  tests/integration/admin-settings-api.test.ts \
  tests/integration/admin-settings-service.test.ts \
  tests/integration/sqlite-setup.test.ts \
  tests/integration/ingestion-service.test.ts \
  tests/integration/background-task-service.test.ts \
  tests/integration/daily-report-service.test.ts
```

必须验证旧 SQLite 数据库幂等升级、已自定义配置迁移、运行时 system role 不含数据库自定义 systemPrompt，以及用户指令无法改变候选 ID、输出合同、Review verdict 和发布门禁。

### 构建和 Compose smoke

```bash
npm run schema:generate
npm run build
docker compose up -d --build --remove-orphans
docker compose ps
curl -fsS http://localhost:3001/
curl -fsS http://localhost:3001/api/feed
curl -fsS http://localhost:3001/api/feed/rss
curl -fsS http://localhost:3001/daily
curl -fsS http://localhost:3001/api/daily/rss
docker compose logs --tail=120 app worker
```

Compose 必须同时确认 app 和 worker 使用相同的 runtime schema/协议代码；只验证页面能打开不足以证明后台任务没有继续读取 legacy systemPrompt。

## 8. 风险与处理

### 用户现有配置行为变化

部分管理员可能依赖 system prompt 改变任务语义。固定协议后这些修改不再生效，这是有意的安全边界变化。迁移保留旧值供审计，将可保留的业务偏好迁移到 userPrompt，并在 UI 中给出一次性复核状态。

### 输入模板行为变化

旧配置可能依赖占位符顺序、重复注入或自定义裁剪。目标架构会由代码掌握输入边界，应通过 golden message 对比确认有效输入没有丢失，再逐步关闭 legacy 模板渲染。

### 条目理解 fallback 复杂度

第一阶段只增加诊断和合同分层，不直接将所有不完整输出改成硬失败；待样本和统计稳定后，再逐步收紧。

### 日报模板和 system prompt 混淆

日报模板编译后的 system prompt 是应用生成的产品协议，不应重新暴露为普通用户 system prompt；UI 可编辑模板，但不能编辑编译后的内部阶段合同。Reviewer 输入必须保持代码注入。

### 兼容客户端

旧前端/脚本可能继续提交 `systemPrompt`。建议一个版本周期内接受但不生效并返回固定协议版本，随后删除请求字段并让非法请求失败，避免长期静默误导。

## 9. 待确认但不阻塞方案的决策

1. **字段命名**：推荐 `userPrompt`；若更强调非协议性质，使用 `userInstruction` 更清晰。
2. **是否允许为空**：推荐允许为空。代码输入和内部协议不应依赖用户填写模板。
3. **未知输出字段**：推荐四个历史任务拒绝未知顶层字段；兼容期只在明确标记的 legacy parser 中容错。
4. **systemPrompt API 兼容窗口**：推荐一个版本周期内接受但忽略，随后删除请求字段并让非法请求失败。
5. **协议展示**：展示任务名、合同版本/hash 和“系统维护”的只读状态，不在普通配置弹窗展示完整内部协议正文。

## 10. 完成定义

只有同时满足以下条件，才认为改造完成：

- 六类任务的实际 system message 都来自代码合同注册表，数据库自定义 systemPrompt 不再生效。
- 用户补充指令统一以 user role 注入，不再承担内部输入占位符职责。
- 六类任务都有代码级输出合同校验；fallback、JSON 修复和 legacy parse 都有明确诊断。
- API、设置服务、UI、SQLite 升级以及 worker/admin 双路径使用同一配置语义。
- 任务详情可看到模型、token/context usage、统计来源；任务用量快照保留对应的协议版本/hash。
- 旧数据迁移幂等，已自定义配置不会被静默覆盖。
- 单元、集成、lint、build 和本地 Docker Compose app/worker smoke 均通过。
- 日报 Reviewer 的失败草稿、不自动发布、一次中间重试和现有审核逻辑无回归。

本计划当前保持 `draft`，因为它改变所有 AI 任务的配置/API/运行时边界，实施前需确认字段命名、兼容窗口和迁移提示策略。确认后可按 DAG 从 U1 开始进入实现阶段。
