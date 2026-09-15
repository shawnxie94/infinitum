# OrcaRouter 模型服务商

Infinitum 的模型 API 配置里，`OrcaRouter` 是一等的服务商预选项，提供两种并列的接入方式：
粘贴 API Key，或用 OrcaRouter 账号登录（OAuth 2.0 + PKCE）。两种方式最终都会得到同一把
归属用户自己的 OrcaRouter API Key（`sk-orca-…`），下游的推理、模型目录与各 AI 入口不区分
凭据来源。

管理后台路径：`/admin` → 设置 → AI 配置 → 模型 API。

## 两个 origin 不要混用

| 用途 | 地址 |
| --- | --- |
| 认证与授权码交换 | `https://www.orcarouter.ai` |
| 推理与模型目录 | `https://api.orcarouter.ai/v1` |

授权页固定在 `/auth`，授权码交换固定在 `/api/v1/auth/keys`。
`https://api.orcarouter.ai/v1/auth/keys` 是 404 —— 这是最常见的接入错误，不要通过替换
hostname 或拼接 `/v1` 从一个 origin 推导另一个。

## 配置项

| 变量 | 说明 |
| --- | --- |
| `ORCAROUTER_API_KEY` | 项目级 API Key 兜底；未在界面保存凭据时使用 |
| `ORCA_BASE_URL` | 自托管单 origin 部署的共享地址 |
| `ORCA_AUTH_BASE_URL` | 显式覆盖认证 origin |
| `ORCA_API_BASE_URL` | 显式覆盖推理 origin |

显式覆盖优先于共享地址，共享地址优先于公开默认值。远程 origin 必须是 HTTPS，
仅回环地址允许 HTTP。

## 两种认证方式

**API Key**：直接在配置界面填入 `sk-orca-…`，或通过 `ORCAROUTER_API_KEY` 提供。
无浏览器环境也能使用。密钥以密码控件输入与保存，界面只回显掩码。

**Connect with OrcaRouter（OAuth 2.0 + PKCE）**：采用 out-of-band code 流程（Flow B）。
Infinitum 是自托管部署，每套安装的访问地址都不同，没有可预测的回调地址，因此由授权页
展示授权码、用户粘贴回程序。授权请求始终使用 S256；`code_verifier` 只存在于服务端进程内，
不进入 URL、日志或浏览器响应。

可见性范围（scope）以服务端返回的实际授权为准，请求值与实际授权不一致时会明确提示，
不会假定已获得更宽的权限。

## 凭据生命周期

PKCE 换回的是**长期有效的 API Key，不是 refresh token**：没有 refresh 端点，也不会主动刷新。
密钥会保存在项目已有的模型配置存储中并在重启后继续复用，直到用户在
<https://www.orcarouter.ai/console/authorized-apps> 撤销。

每用户每 24 小时最多签发 10 个 PKCE 密钥，因此不会每次启动都重新授权。

推理请求返回 `401` 时按终止性重新认证处理：只把发出该请求的确切账号与凭据 generation
标记为 `needsReauth`，界面提示重新登录；旧请求的延迟失败不会污染刚完成的新登录，也不会
伪造 refresh 或无限重试。新登录成功前不会删除旧密钥。

## 模型目录与能力过滤

模型清单的唯一事实源是当前推理 origin 的 `GET /v1/models`。切换服务商后，模型控件会从该
目录生成下拉选择器，按入口能力过滤，不需要用户手填模型名。

- 文本 chat / agent：`?capability=chat`，并要求 `supported_endpoint_types` 命中
  `openai` / `anthropic` / `gemini` / `openai-response`。
- 多模态理解：先满足 chat，再要求 `architecture.input_modalities` 明确包含入口实际上传的
  模态。未声明能力的模型 fail closed，不会混入多模态下拉。
- embedding / 图片生成 / 视频 / rerank：分别严格匹配 `embeddings`、
  `image-generation`、`openai-video`、`jina-rerank`。

输入模态变化时会重新拉取并按新能力过滤；已选模型不再兼容时会被清空并提示重新选择，
不会静默保留。目录请求失败时回退到一小份已验证的冷启动目录，并在界面上标注为回退状态；
实时目录成功时以实时结果为准，不会把回退项混入。

服务端持有 API Key 完成目录发现，浏览器只拿到最小的模型元数据。
