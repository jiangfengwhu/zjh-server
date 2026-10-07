# 紫金花服务端

Cloudflare Worker 提供账号、动态互动、作品与产物接口及 Jules 制作代理。SDK/宿主在 zjh-dynamic，APK 在 zjh-android，应用源码与云端 Agent 规则在 zjh-plugin。维护边界见 [AGENTS.md](AGENTS.md)。

## 安装与部署

```sh
npm ci
npm run deploy
```

维护者登录 Wrangler 后部署，保留 wrangler.jsonc 现有绑定。纯文档修改不部署。

开发清理使用维护者鉴权的 `POST /v1/development-reset`，请求携带 `confirm: "RESET_WORKSHOP_DEVELOPMENT_DATA"`。设置 `scope: "applications"` 清理全部应用目录、制作记录和授权，保留账号、动态与私信；省略 scope 清理全部开发数据。Jolly 制作进度页属于宿主，不是 plugin 应用，不需要保留应用目录。`dryRun: true` 只返回待清理应用与制作分支，不删除数据。

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

任务命令保存应用本轮身份，发布脚本通过 POST /v1/application-publisher/<appId> 自动获取最长 30 分钟的发布授权，期限不超过任务凭据；账号、应用与 publishEpoch 必须一致。同一轮 working/ready 状态允许重复发布，停止或开始新一轮立即使旧授权失效。任务提示明确要求完成开发和清单后再发布，不发布初始化模板。

宿主负责制作表单，Jolly 仅查进度。服务端注入授权与任务上下文，通用规则引用插件及 SDK 文档。Remix 锁定原作 releaseId/commit，分配独立身份与模块范围。共享 JS 环境不是恶意代码沙箱。

Jolly 紧凑查询先返回本轮状态，历史在后台预热；尚未确认的新轮终态等待记录校验。本轮候选发布成功即标记可体验，并异步发送完成通知，不依赖用户刷新进度。Jules 未发布即失败的状态仍需查询上游才能获知；不定时查询，定时任务仅重试已生成但尚未送达的通知。/v1/works 默认只读本地快照，refresh=1 才查询上游。

`/v1/updates?apkVersionCode=<本机版本>` 返回 release、apk 与 apkUpdate；APK 文件位于既有 R2 的 v1/apk/<sha256>.apk。运行时与 APK 清单仅允许维护者发布，应用发布授权不可修改。

关注关系由既有 Posts 存储维护正反索引，GET /v1/profiles/<id>/following 或 followers 返回独立游标及关系。旧数据首次读取时补齐反向索引，不改账号或作品存储。

私信复用 Posts 存储，不新建绑定。GET /v1/messages 返回会话与总未读数，GET /v1/messages/<peerId> 返回当前账号与对方的历史；POST 同路径携带 body、requestId，最多 2000 字、每分钟 30 条，重复请求不重复写入。POST /v1/messages/<peerId>/read 携带 through 消息 ID，仅标记读取到的边界；GET /v1/messages/unread 返回私信总未读数。所有接口鉴权，禁止自发私信和跨会话游标。

GET /v1/messages/live 以 Authorization 头建立 WebSocket，复用 Posts 的休眠连接。推送 ready/message/read/notification/feed/work 事件；账号事件带递增 version、私信总未读及通知分类数量，作品事件带 appId。正文须通过鉴权接口读取；过期连接在下一次事件时关闭并由客户端重新鉴权连接，不使用定时查询。客户端合并短时事件，仅刷新可见列表，首页新动态由用户点击提示后展示；后台关闭连接，重连补同步。

制作与继续修改每轮从 npm 的 `@zijinhua/app-sdk/latest` 选择稳定版本，任务开头注入安装确切版本的命令。获取失败时不占用额度、不创建制作轮次；原请求重试仍复用已有结果。SDK 更新不合并 plugin main，版本的宿主兼容性由维护者发布 latest 前核对。

任务 SDK 的 npm 大版本必须与当前生效宿主 release.applications.sdk 一致；切换发布渠道期间不下发不匹配的 SDK。作品清单 requires 只要求 sdk，API/共享库/原生的破坏性升级统一反映到 SDK 大版本。
