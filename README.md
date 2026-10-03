# 紫金花服务端

Cloudflare Worker 提供账号、动态互动、应用清单、产物读取与 Jules 制作代理。SDK/宿主在 zjh-dynamic，APK 在 zjh-android，应用源码和云端 Agent 规则在 zjh-plugin。

## 安装与部署

在仓库根目录执行 npm ci；需部署时，维护者登录 Cloudflare Wrangler 后运行 npm run deploy。保留 wrangler.jsonc 中现有资源绑定，不另建生产存储。纯文档修改不部署。

Secrets 通过 npx wrangler secret put <NAME> 交互配置，不把值写入代码或命令文本：

- JULES_API_KEY：制作服务。
- GITHUB_MERGE_TOKEN：读取插件仓库分支和导出信息，交付流程不合入 PR。
- OFFICIAL_PUBLISH_TOKEN：维护者发布及本轮应用授权签发，不提供给云端。
- RESEND_API_KEY、MAIL_FROM：验证码邮件；MAIL_FROM 使用 Resend 已验证域名的发件邮箱。

本地 .dev.vars 不提交。GitHub/Jules 集成仅开放 zjh-plugin，云端没有 R2、Wrangler 或全局发布权限。

## 接口边界

- /v1/auth/*、/v1/account：验证码登录与资料；账号凭证仅由宿主保管。
- /v1/posts、/v1/notifications、/v1/profiles：动态、互动与公开身份。
- /v1/workshop、/v1/works、/v1/jules：按账号和 appId 管理制作；同应用复用 session，同轮写操作串行，不同应用可并行。
- /v1/application-blobs/<id>/<sha256>、/v1/catalog：校验本轮授权、包哈希及 expectedReleases 原子基线，冲突返回 409。candidate 为权威候选，latest 为私有镜像，不检查应用提交祖先。
- /v1/market、应用 public：只提供作者主动公开的版本。体验候选可选，后续发包不改变已有公开版本；已公开快照仍可供已安装应用读取。
- /v1/official-release：维护者指定官方公开版本，官方身份由服务端生成，无邮箱登录。
- /v1/runtime：配套 APK 的运行时契约，普通应用发布不能修改。

制作提示由服务端注入本轮授权与任务上下文；Jolly 只整理用户需求，通用开发与发包规则引用插件及 SDK 文档。Remix 锁定原作 releaseId/commit，为新应用分配独立身份和模块范围。共享 JS 环境不是恶意代码沙箱。
