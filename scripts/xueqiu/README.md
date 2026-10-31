# 雪球昵称搜索服务

构建并启动隔离服务：

```sh
docker compose -f docker-compose.xueqiu.yml up -d --build
```

服务默认只将 `13100` 端口绑定到本机回环地址。Infinitum 在宿主机运行时设置 `XUEQIU_SEARCH_URL=http://127.0.0.1:13100`；Infinitum 运行在 Docker 中时需使用容器可访问的地址并确保网络连通，例如 Docker Desktop 上的 `http://host.docker.internal:13100`（实际连通性依运行环境验证）。服务应只供可信的 Infinitum 后端访问，不要公开到互联网。

`RSSHUB_BASE_URL` 另行配置为 Infinitum 可访问的 RSSHub 服务地址，用于核验和采集用户动态；搜索服务不提供 RSS。修改环境变量后需重启 Infinitum。RSSHub 镜像与雪球非公开接口可能变更，搜索也可能因风控或网络而失败；失败时可使用 UID 或雪球用户主页。镜像包含 Chromium，首次构建需要下载系统依赖。
