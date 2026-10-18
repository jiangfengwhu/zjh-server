# Go 迁移工程（进行中，不可切换生产流量）

目标：Go API、PostgreSQL、Nginx、Let's Encrypt 部署到现有服务器；R2 继续保存包体、图片、云文件和 ASR 模型，保留 CDN 对象地址。沿用 zijinhua.297782.xyz，不要求用户安装应用来变更 API 地址。

已实现配置校验、PostgreSQL 连接池/事务建表、清单与更新查询、R2 流式存取、健康检查和优雅关闭，以及邮箱登录/会话/资料/头像、应用云数据 CRUD/分页/原子累加、求职资料五类统一维护接口。已在服务器新库验证账号隔离、幂等、并发累加和版本冲突。Go 服务目前只用于并行验证，未实现的业务路由返回 404；readyz 明确返回 migrationComplete=false。现有 Worker 仍然是生产服务。

## 本地构建

需要 Go 1.27.2，依赖锁定在 go.mod/go.sum。

```sh
go build -o ../dist/shenghua-api ./cmd/api
```

进程从环境变量读取配置，键见 .env.example。不要将真实环境文件提交。服务默认只监听 127.0.0.1:8080；数据库连接池最多 10 个连接，不直接向公网开放数据库。

## 必须完成的迁移

1. Accounts 接口已移植；仍需导入现有用户、会话摘要与到期时间，保留用户 ID，不强制用户重新注册。验证码邮件发送未做真实投递验证。
2. Workshop：制作记录、Jules、授权 epoch、模块分配、候选与公开版本、素材、作品删除、资料更新；发布基线与制作轮次必须在事务中核对。
3. Posts：动态、HTML 清理、互动、讨论、关注、通知、私信、读模型与账号 WebSocket。与写事务一起提交失效事件，广播不能先于事务成功。
4. APP_DATA 集合接口已移植：按 tenant/appId 隔离、文档版本、幂等结果、配额、分页和原子累加。仍需实现文件接口与房间 WebSocket；文件元数据和 AES 密钥一起迁移，R2 对象不搬家。房间保留身份校验、容量、过期连接重鉴权与重连补快照契约。导入文档时必须在同一事务重建 application_usage，不能只写 application_records。
5. 定时清理与制作通知补偿改成数据库任务，避免进程重启丢失任务。单机先使用进程内 WebSocket hub，不引入 Redis 或微服务。
6. 将 dynamic/android 发布器中直接写 Cloudflare KV 的维护者流程改成 Go 管理接口，原来已经存到 R2 的包体继续复用。

## 迁移与切换

- Durable Object 的数据属于各实例，不能只导出 Wrangler KV 就认为完成数据库迁移。必须盘点四类实例、导出 KV 与业务 SQL 表，并为每页保留游标、实例身份及行数；导出文件包含会话摘要和私有文件密钥，存放在受保护目录，不进入日志、Git 或公开 R2 路径。
- 先导入隔离的新库，核对账号、作品、动态、消息、云记录、文件元数据与密钥。SQL 派生搜索索引可从源记录重建；不要复制 Cloudflare 内部 SQLite 表。
- 迁移窗口短暂停写，排空旧端在途事务，导出最后一致快照再导入。切换后只允许新端写入；回退须先同步新端产生的数据，不能直接把 DNS 指回旧库。
- 沿用原 API 域名时，Cloudflare Worker 的通配路由仍会拦截请求；域名解析与 Worker 路由需要一起处理。TLS 可先使用 DNS-01 签发，避免提前切流才能验证 HTTP-01 的依赖。
- 保留旧 Worker 和原存储到完整验收后。按用户要求，不创建数据库定时备份；迁移用的临时导出文件仅用于导入与核对，验收后清理。现在未修改正式 API 的 DNS、Worker 路由或生产存储。

## 部署配置

deploy/nginx.conf 是切换后的目标配置，处理 HTTPS/WebSocket/大包上传。证书由 Certbot 获取和续期，成功续期后先 nginx -t，再 reload；不得未校验即替换活动配置。初期不自动启用该配置。

deploy/shenghua-api.service 使用独立低权限账号。现有 CentOS Linux 8 按用户要求保留；需要选用能够在当前系统运行的部署方式。证书与密钥持久化到服务器受限目录。

当前服务器运行 Docker 静态发行版 29.9.1（systemd 服务 shenghua-docker），需要维护者主动更新；数据库 postgres:17-alpine 的镜像摘要固定为 `sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24`。容器 shenghua-postgres 使用持久卷，端口只绑定 127.0.0.1:5432，限制 512MB 内存、1.25 CPU、128 个进程；API 数据库角色不具备超级用户、创建库或创建角色权限。镜像拉取时的桌面临时代理已移除。

按用户要求，不部署数据库备份任务，已移除备份脚本、systemd timer/service 和服务器上生成的备份文件。

服务器不能直连 Jules；按用户确认，暂保留独立 [Jules 转发 Worker](../jules-relay/index.ts)，仅允许固定 Google Jules API 路径，使用独立 RELAY_TOKEN 鉴权，不绑定业务存储，也不记录请求内容。服务器 api.env 配置 JULES_BASE_URL=https://jules-relay.297782.xyz 和 JULES_RELAY_TOKEN；Worker 的 RELAY_TOKEN、JULES_API_KEY 用 Wrangler Secrets 配置。不能用桌面代理充当线上出口。现有生产 Worker 不依赖该转发器。

`go build -o ../dist/shenghua-check ./cmd/check` 可构建连接诊断工具；在服务器受限环境中运行，只输出配置、数据库、R2、Jules 的连接布尔值，不打印密钥或上游正文。

当前部署状态：账号与云集合接口已在新服务器运行并通过 21 项定向验证；求职资料接口通过 12 项验证（含 501 条批量写入与并发 revision 冲突），过期记录清理已部署。Go 诊断确认数据库、R2、Jules 均可连接。SSH 公钥认证已恢复，配置被关闭的来源尚未查明。数据库补充 shenghua-postgres.service，显式等待可连接后再启动 API，并随 Docker 的启停和重启联动。Nginx/Let's Encrypt、完整数据导入、动态/社交/制作/房间/文件接口及正式切换尚未完成。

DNS 由用户配置。接口、数据和 HTTPS 就绪后，再将 zijinhua.297782.xyz 的 A 记录改为 1.92.67.206，初次切换使用 DNS only；删除同名冲突的 CNAME 或旧 AAAA 记录。维护者同步解除原正式 API Worker 通配路由，确认流量进入 Nginx，并进行登录、发现、制作、分享、云数据、WebSocket 验证。R2/CDN 域名与 Jules 转发域名保持原配置。
