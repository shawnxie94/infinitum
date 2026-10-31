# WeRSS 账号接入

接口按 `rachelos/we-mp-rss` 源码版本 `9fd4edb2a9311bffa571db050f53f415705db294` 核对：`/api/v1/wx/mps/search/{kw}`、`/api/v1/wx/mps` 和 `/feed/{id}.xml`。自行部署的 WeRSS 必须提供兼容接口，并在微信公众平台完成其自身授权；此代码不负责登录或保存微信 Cookie。WeRSS 的空搜索结果可能同时表示授权失效或频控。

1. 在宿主机启动兼容版本的 WeRSS，服务只监听本机 `127.0.0.1:8001`，按其文档持久化数据并完成授权。不要使用默认口令。其微信授权数据和日志需由部署者保护；本项目不创建或启动该服务。
2. 在 macOS Keychain 中以 `access_key:secret_key` 格式存放 WeRSS AK/SK，service 为 `kb-model`、account 为 `werss-ak-sk`。通过系统钥匙串管理界面录入，避免将密钥写入命令行、配置文件或环境变量。
3. 在宿主机运行 `node scripts/werss/keychain-bridge.mjs`。代理监听 `127.0.0.1:18765`，默认访问本机 `127.0.0.1:8001`；可用非敏感配置 `WERSS_UPSTREAM_URL` 修改端口，地址必须是 127.0.0.1。代理只转发限定的搜索、订阅列表和添加接口，不返回 Keychain 凭据。
4. Infinitum 容器配置 `WERSS_BASE_URL=http://host.docker.internal:8001` 和 `WERSS_BRIDGE_URL=http://host.docker.internal:18765`，这些仅为地址，不含密钥。Docker Desktop 下已验证容器能访问宿主回环监听端口；其他环境需自行验证网络。代理端口不得对公网或不受信任的网络开放。宿主机本地进程属于信任边界，能访问回环代理的本地程序也可调用限定接口。

搜索结果缓存于 Infinitum 进程内 5 分钟；重启、跨实例请求或过期时需重新搜索。添加前先核对 WeRSS 订阅列表；请求结果不明时不要自动重放，重新搜索并选择会先查已有订阅。首次添加会触发上游的文章抓取任务。尚未使用真实 WeRSS 授权账户完成端到端验证，不能据此保证文章完整性、稳定性或无漏稿。

本目录的 `docker-compose.werss.yml` 使用固定源码提交及固定基础镜像构建，数据放在命名卷，端口绑定回环；它不自动启动。基础镜像实际为 amd64，Apple Silicon 运行需 Docker x86 仿真，真实浏览器功能尚待验证。执行 `docker compose -f docker-compose.werss.yml build` 后再由部署者执行 `docker compose -f docker-compose.werss.yml up -d`。构建会校验源码归档哈希，禁用上游通知并关闭容器日志持久化，降低上游登录过程输出敏感信息的风险。微信会话仍由上游保存在其数据卷中，应限制本机及卷访问。

**初始化安全步骤**：上游首次启动默认账号为 `admin`、默认密码为 `admin@123`。服务仅绑定回环，但本机其他进程仍可访问；首次登录后应先修改管理员密码，再进行微信扫码和创建 AK/SK。AK/SK 仅通过钥匙串界面存入上述条目；不要贴入终端、配置或聊天。固定构建与真实微信授权在本环境尚未完成验收。
