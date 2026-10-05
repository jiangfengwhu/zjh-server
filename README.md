# 紫金花服务端

Cloudflare Worker 提供账号、动态互动、作品与产物接口及 Jules 制作代理。SDK/宿主在 zjh-dynamic，APK 在 zjh-android，应用源码与云端 Agent 规则在 zjh-plugin。维护边界见 [AGENTS.md](AGENTS.md)。

## 安装与部署

```sh
npm ci
npm run deploy
```

维护者登录 Wrangler 后部署，保留 wrangler.jsonc 现有绑定。纯文档修改不部署。

Secrets 用 `npx wrangler secret put <NAME>` 交互配置，值不写入代码或命令文本，.dev.vars 不提交。

| 配置 | 用途 |
| --- | --- |
| JULES_API_KEY | 制作服务 |
| GITHUB_MERGE_TOKEN | 读取插件分支与导出信息，交付不合入 PR |
| OFFICIAL_PUBLISH_TOKEN | 维护者发布及本轮应用授权签发，不提供给云端 |
| RESEND_API_KEY、MAIL_FROM | 验证码邮件，发件邮箱使用已验证域名 |

GitHub/Jules 集成仅开放 zjh-plugin；云端不获得 R2、Wrangler 或全局发布权限。

## 接口边界

| 接口 | 职责 |
| --- | --- |
| /v1/auth/*、/v1/account | 登录与资料，账号凭证由宿主保管 |
| /v1/posts、/v1/notifications、/v1/profiles | 动态、互动、公开身份及关注／粉丝分页 |
| /v1/messages、/v1/messages/<用户 ID> | 私信会话、文字发送与历史；登录鉴权、幂等发送 |
| /v1/workshop、/v1/works、/v1/jules | 按账号和 appId 管理制作，同应用复用会话并串行写入 |
| /v1/creation-media | 账号认证的制作参考图上传，JPEG 最大 2 MB，沿用上传额度 |
| /v1/application-blobs/<id>/<sha256>、/v1/catalog | 候选上传、哈希与本轮授权校验 |
| /v1/market、应用 public | 作者主动公开的快照，后续候选发布不改变公开版本 |
| /v1/official-release、/v1/runtime | 维护者公开官方版本、发布配套 APK 契约 |
| /v1/updates、/v1/apk | 动态与 APK 更新检查、APK 清单 |

通知 category=creation/interaction 使用独立分页游标；不传 category 返回全部通知。通知列表、未读查询与标记已读均返回 unreadByCategory（creation/interaction 未读数）；点赞、评论、回复归入互动，重复点赞不生成通知，取消点赞清理对应通知。制作状态携带 submissionId/startedAt，旧轮终态不能覆盖新提交；继续修改的 requestId 绑定账号、应用、会话与正文，成功重试不再次提交。

候选发布必须提供 expectedReleases 原子基线，冲突返回 409；candidate 为权威候选，latest 为私有镜像，不检查应用提交祖先。市场、安装及 APK seed 只消费公开版本；官方身份由服务端生成。

宿主负责制作表单，Jolly 仅查进度。服务端注入授权与任务上下文，通用规则引用插件及 SDK 文档。Remix 锁定原作 releaseId/commit，分配独立身份与模块范围。共享 JS 环境不是恶意代码沙箱。

Jolly 紧凑查询先返回本轮状态，历史在后台预热；尚未确认的新轮终态等待记录校验。通知发送不阻塞查询；进度由用户手动查询，定时任务仅重试已生成但尚未送达的通知。/v1/works 默认只读本地快照，refresh=1 才查询上游。

`/v1/updates?apkVersionCode=<本机版本>` 返回 release、apk 与 apkUpdate；APK 文件位于既有 R2 的 v1/apk/<sha256>.apk。运行时与 APK 清单仅允许维护者发布，应用发布授权不可修改。

关注关系由既有 Posts 存储维护正反索引，GET /v1/profiles/<id>/following 或 followers 返回独立游标及关系。旧数据首次读取时补齐反向索引，不改账号或作品存储。

私信复用 Posts 存储，不新建绑定。GET /v1/messages 返回会话与总未读数，GET /v1/messages/<peerId> 返回当前账号与对方的历史；POST 同路径携带 body、requestId，最多 2000 字、每分钟 30 条，重复请求不重复写入。POST /v1/messages/<peerId>/read 携带 through 消息 ID，仅标记读取到的边界；GET /v1/messages/unread 返回私信总未读数。所有接口鉴权，禁止自发私信和跨会话游标。

GET /v1/messages/live 以 Authorization 头建立 WebSocket，复用 Posts 的休眠连接。推送 ready/message/read/notification/feed/work 事件；账号事件带递增 version、私信总未读及通知分类数量，作品事件带 appId。正文须通过鉴权接口读取；过期连接在下一次事件时关闭并由客户端重新鉴权连接，不使用定时查询。客户端合并短时事件，仅刷新可见列表，首页新动态由用户点击提示后展示；后台关闭连接，重连补同步。
