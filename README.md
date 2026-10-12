# 生花服务端

Cloudflare Worker 提供账号、动态互动、作品与产物接口及 Jules 制作代理。SDK/宿主在 zjh-dynamic，APK 在 zjh-android，应用源码与云端 Agent 规则在 zjh-plugin。维护边界见 [AGENTS.md](AGENTS.md)。

## 安装与部署

```sh
npm ci
npm run deploy
```

维护者登录 Wrangler 后部署，保留 wrangler.jsonc 现有绑定。纯文档修改不部署。

开发清理使用维护者鉴权的 `POST /v1/development-reset`，请求携带 `confirm: "RESET_WORKSHOP_DEVELOPMENT_DATA"`。设置 `scope: "applications"` 清理全部应用目录、制作记录和授权，保留账号、动态与私信；省略 scope 清理全部开发数据。制作进度页属于宿主，不是 plugin 应用，不需要保留应用目录。`dryRun: true` 只返回待清理应用与制作分支，不删除数据。

Secrets 用 `npx wrangler secret put <NAME>` 交互配置，值不写入代码或命令文本，.dev.vars 不提交。

| 配置 | 用途 |
| --- | --- |
| JULES_API_KEY | 制作服务 |
| GITHUB_MERGE_TOKEN | 读取插件分支与导出信息，交付不合入 PR |
| OFFICIAL_PUBLISH_TOKEN | 维护者发布及本轮应用授权签发，不提供给云端 |
| RESEND_API_KEY、MAIL_FROM | 验证码邮件，发件邮箱使用已验证域名 |

GitHub/Jules 集成仅开放 zjh-plugin；云端不获得 R2、Wrangler 或全局发布权限。

求职急救站的公开资料和维护者更新接口见 [资料维护](docs/career-materials.md)。资料复用 Workshop SQLite 原子保存，不新增存储绑定；应用缓存支持离线阅读。

## 应用云数据

APP_DATA 使用 SQLite Durable Objects。私有实例按 userId 分配，内部再按 appId 隔离；公开实例按 appId 分配。入口从宿主登录 Token 获取用户身份，只允许已公开应用或当前作者的作品访问，不使用发布授权。公开记录仅创建者可改删，客户端不能覆盖归属和版本字段。集合首次写入自动创建；单条 JSON ≤32 KB，每个实例业务数据 ≤50 MB、记录 ≤10 万，每应用集合 ≤100；每用户每实例每分钟 ≤120 次请求。写入 requestId 一小时去重，最多保留 2000 条去重结果，超出时拒绝新写入而不提前丢弃旧结果。分页使用绑定账号、应用、集合和条件的游标。

更新及卸载应用不删除云数据。现有 development-reset 仅清理其原有范围，不删除独立 APP_DATA 业务库。业务数据不进入日志；账号 Token 不提供给 plugin。安全回归检查：`node --test tests/applicationData.test.mjs`，使用本地 SQLite，不访问线上数据。

云文件复用 BLOBS 与用户 APP_DATA 实例，对象键包含 appId、ownerId 和文件 ID，避免账号间覆盖；每文件最大 10 MB，每账号每应用最大 100 MB、1000 个文件。公开文件返回 CDN URL；私有文件使用每文件独立 AES-GCM 密钥加密后存入同一公开桶，密钥只存在用户实例内，鉴权下载时解密，不向客户端返回密钥。未完成上传的预约由已有 alarm 回收。GET/DELETE 文件接口仅访问当前用户文件；公开分享使用返回的 URL。

实时房间复用 APP_DATA，按 `room:<appId>:<roomId>` 分配实例，无新增生产绑定或迁移。入口先校验登录和应用访问，再通过用户实例限流。房间编号可分享，持有编号的登录参与者可以协作改删房间集合；不是私有群组的角色权限。集合写入在 SQLite 事务中执行，increment 支持幂等、版本冲突和数值字段原子累加；原 public 集合仍保留创建者写权限。WebSocket 使用休眠 API，身份与限流信息放在 attachment，序列保存在 SQLite；五分钟后重新鉴权，单房间最大 64 条连接，每账号最大 4 条。事件最大 16 KB，每连接每分钟 120 次，只实时广播，不提供离线重放。集合变动仅推送失效通知，重连后客户端重新读取快照。

## 接口边界

| 接口 | 职责 |
| --- | --- |
| /v1/auth/*、/v1/account | 登录与资料，账号凭证由宿主保管 |
| POST /v1/app-data/<appId>/<private\|public>/<collection> | 登录用户的应用云数据；JSON body 的 operation 为 create/get/list/update/increment/remove |
| /v1/app-files/<appId>/<id>、GET .../content | 账号鉴权的文件上传、元数据、删除与下载 |
| GET /v1/app-rooms/<appId>/<roomId>/live | 鉴权的实时房间 WebSocket |
| POST /v1/app-rooms/<appId>/<roomId>/data/<collection> | 房间共享集合，支持 CRUD、原子计数与版本冲突 |
| GET /v1/application-bookmarks | 当前账号的常用应用分页，复用作品收藏记录，游标为本账号收藏项标识 |
| /v1/posts、/v1/notifications、/v1/profiles | 动态、互动、公开身份及关注／粉丝分页 |
| /v1/messages、/v1/messages/<用户 ID> | 私信会话、文字发送与历史；登录鉴权、幂等发送 |
| /v1/workshop、/v1/works、/v1/jules | 按账号和 appId 管理制作，同应用复用会话并串行写入 |
| DELETE /v1/works/<appId> | 作者删除作品及制作记录，同时下架并撤销发布授权；重复删除幂等。作品读取返回当前账号的 deletedAppIds，供设备清理旧缓存；保留模块分配及不可变历史包，删除的 ID 不可再次制作或发布 |
| /v1/creation-media | 账号认证的制作参考图上传，JPEG 最大 2 MB，沿用上传额度 |
| /v1/application-blobs/<id>/<sha256>、/v1/catalog | 候选上传、本轮授权及清单结构检查；不校验文件哈希 |
| /v1/market、应用 public | 作者主动公开的快照，后续候选发布不改变公开版本 |
| POST /v1/application-download/<id> | 宿主成功安装后异步记录，按登录账号及应用去重；仅接受已上架 releaseId，市场列表返回 downloadCount |
| /posts/<id>、/applications/<id>、/download | 公开分享落地页、打开 App 的兜底入口；下载地址重定向到当前 R2 APK |
| /.well-known/assetlinks.json | Android App Links 域名关联，证书指纹必须与分发 APK 签名一致 |
| /v1/official-release、/v1/runtime | 维护者公开官方版本、发布配套 APK 契约；official-release 的 action=withdraw 仅下架官方作品，保留不可变历史包 |
| /v1/updates、/v1/apk | 动态与 APK 更新检查、APK 清单 |

通知 category=creation/interaction 使用独立分页游标；不传 category 返回全部通知。通知列表、未读查询与标记已读均返回 unreadByCategory（creation/interaction 未读数）；点赞、评论、回复归入互动，重复点赞不生成通知，取消点赞清理对应通知。制作状态携带 submissionId/startedAt，旧轮终态不能覆盖新提交；继续修改的 requestId 绑定账号、应用、会话与正文，成功重试不再次提交。

候选发布必须提供 expectedReleases 原子基线，冲突返回 409；candidate 为权威候选，latest 为私有镜像，不检查应用提交祖先。发现与安装只消费公开版本，APK 只内置宿主 vendor/app 包；官方身份由服务端生成。

任务命令保存应用本轮身份，发布脚本通过 POST /v1/application-publisher/<appId> 自动获取最长 30 分钟的发布授权，期限不超过任务凭据；账号、应用与 publishEpoch 必须一致。同一轮 working/ready 状态允许重复发布，停止或开始新一轮立即使旧授权失效。任务提示明确要求完成开发和清单后再发布，不发布初始化模板。

制作表单与进度页面均由宿主提供。服务端注入授权与任务上下文，通用规则引用插件及 SDK 文档。Remix 来源由制作记录维护，客户端清单不填写原作字段，也不因这些字段缺失而拒绝发布。Remix 按原作 releaseId 锁定应用目录源码快照与确切提交，从已确认的原作分支启动新任务；缺失源码记录时明确报错，不退回 main。分支确认后回填对应公开版本的来源，原作后续提交不改变已锁定版本。分配独立身份与模块范围。共享 JS 环境不是恶意代码沙箱。

制作进度返回本轮状态与最后模型输出；尚未确认的新轮终态等待记录校验。本轮候选发布成功即标记可体验，并异步发送完成通知，不依赖用户刷新进度。Jules 未发布即失败的状态仍需查询上游才能获知；不定时查询，定时任务仅重试已生成但尚未送达的通知。/v1/works 默认只读本地快照，refresh=1 才查询上游。

`/v1/updates?apkVersionCode=<本机版本>` 返回 release、apk 与 apkUpdate；APK 文件位于既有 R2 的 v1/apk/<sha256>.apk。运行时与 APK 清单仅允许维护者发布，应用发布授权不可修改。

关注关系由既有 Posts 存储维护正反索引，GET /v1/profiles/<id>/following 或 followers 返回独立游标及关系。旧数据首次读取时补齐反向索引，不改账号或作品存储。

私信复用 Posts 存储，不新建绑定。GET /v1/messages 返回会话与总未读数，GET /v1/messages/<peerId> 返回当前账号与对方的历史；POST 同路径携带 body、requestId，最多 2000 字、每分钟 30 条，重复请求不重复写入。POST /v1/messages/<peerId>/read 携带 through 消息 ID，仅标记读取到的边界；GET /v1/messages/unread 返回私信总未读数。所有接口鉴权，禁止自发私信和跨会话游标。

GET /v1/messages/live 以 Authorization 头建立 WebSocket，复用 Posts 的休眠连接。推送 ready/message/read/notification/feed/work 事件；账号事件带递增 version、私信总未读及通知分类数量，作品事件带 appId。正文须通过鉴权接口读取；过期连接在下一次事件时关闭并由客户端重新鉴权连接，不使用定时查询。客户端合并短时事件，仅刷新可见列表，首页新动态由用户点击提示后展示；后台关闭连接，重连补同步。

制作与继续修改每轮从 npm 的 `@zijinhua/app-sdk/latest` 选择稳定版本，核对其与线上宿主 release.applications.sdk 兼容，再注入安装确切版本的命令；不用请求手机的 SDK 版本选包。获取或兼容核对失败时不占用额度、不创建制作轮次；原请求重试仍复用已有结果。SDK 兼容规则与发布顺序统一见 [dynamic README](https://github.com/jiangfengwhu/zjh-dynamic/blob/main/README.md)。SDK 更新不合并 plugin main。新应用准备使用 init，继续修改使用 authorize；完成开发后统一执行不带授权参数的 publish:application 命令，必须返回 published: true 才算完成。

GET /v1/application-discussions/<appId> 返回已公开作品的独立讨论及当前账号的点赞、收藏状态；讨论按应用 ID 跨版本保留，不进入社区时间线。点赞、评论复用 /v1/posts/<id>/like、comments；POST/DELETE /v1/posts/<id>/bookmark 幂等收藏/取消收藏。讨论不能作为动态删除，读作品讨论时重新校验公开状态。复用既有 Posts 存储与账号鉴权，不新增绑定。

维护者可用 `POST /v1/application-source` 修复当前公开版本的源码定位，携带 appId、releaseId、commit、branch；接口核对应用目录快照和分支包含关系，不修改公开包或合入 PR。提交必须匹配已记录的源码快照，不提供通过重建包哈希绕过快照匹配的旧流程；可用 remixAppIds 指定需要同步来源记录的已有改编任务。接口仅接受维护者授权。

## 宿主页面读模型

- GET /v1/discovery：沿用 market 的 limit/cursor/category/q 条件，批量带回 discussion、authorFollowing，按登录身份组装且不公共缓存；互动失败降级为公开作品页，不预取评论。
- GET /v1/application-discussions/<appId>?comments=1：讨论与评论第一页、nextCursor、following 一起返回。后续评论继续使用既有 post 接口。
- GET /v1/me/works：认证账号的作品展示分页（24 条）、totalCount、summary；支持 q、cursor、refresh=1，游标绑定账号和搜索条件，不携带恢复凭据。原 GET /v1/works 全量恢复契约保留。
- GET /v1/profiles/<id>?view=relationship|summary|posts|apps：只读关系/摘要或当前 tab；applicationCount 为公开作品总数，动态 nextCursor 与作品 applicationsNextCursor 独立。不传 view 时返回摘要，不同时拉取动态与作品列表。
- GET /v1/market?view=summary|picker&limit=24：显示投影，不含 bundle/assets 等执行清单，summaryOnly=true；宿主读取 detail 后才能进行需要完整清单的操作。发现流保留完整 manifest。
- POST /v1/workshop 的 action=progress：沿用账号、应用、会话和本轮凭据校验，仅返回本轮最后模型消息。按 session/轮次/上游 state+updateTime 持久缓存；首次回填或上游版本变化可能遍历历史，失败标 stale，无定时查询。
- GET /v1/account-counts：合并通知 unreadCount/unreadByCategory 和 messageUnreadCount，仅供实时连接失败时回退。
- GET /v1/messages/<peerId>?after=<messageId>：认证会话的增量页，最多 50 条，hasMoreNew 指示后续增量；不能与历史 cursor 混用。message/read 实时事件携带 peerId。GET 不标记已读。

Workshop 和 Posts 的派生 SQLite 索引复用现有存储：公开作品顺序/作者/分类与单字、双字搜索 posting；社区动态作者和关注 join；通知 owner/category。首次读取回填旧 KV，发布/撤回/删除/关注变更在同一 KV/SQL 事务更新，索引不存制作凭据，不新增绑定或清理原数据。中文搜索保留子串匹配，posting 筛选后再做精确包含检查。

针对性回归：`node --test tests/pageReads.test.mjs`，使用本地真实 SQLite 与模拟账号/DO，不访问生产数据。
