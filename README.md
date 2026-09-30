# 紫金花服务端

独立维护 Cloudflare Worker：动态清单读写、R2 产物读取和 Jules 会话代理。Android 在 [zjh-android](https://github.com/jiangfengwhu/zjh-android)，RN 在 [zjh-dynamic](https://github.com/jiangfengwhu/zjh-dynamic)。本仓库由服务端当前快照建立独立历史，不携带客户端源码。

本仓库由本地维护者管理，不向云端 Agent 开放。云端只使用 zjh-dynamic，不需要服务端源码；服务端变更由用户交给本地维护者处理。

| 路径 | 职责 |
| --- | --- |
| src/index.ts | HTTP 路由、清单权限校验与 Jules 代理 |
| wrangler.jsonc | Worker、域名路由、KV/R2 绑定和迁移声明 |
| worker-configuration.d.ts | Wrangler 生成的运行环境类型 |

## 开发与部署

1. `npm ci` 安装工具。
2. `npm run typecheck` 检查类型。
3. `npm run deploy` 发布到既有 zijinhua Worker。

保留 zijinhua.297782.xyz 域名、CATALOG KV 和 BLOBS R2，继续使用现有线上数据与 Secrets。JULES_API_KEY、PUBLISH_TOKEN 和 GITHUB_MERGE_TOKEN 由 Cloudflare Secrets 管理；本地调试可用忽略的 .dev.vars，不提交凭证。GitHub 合入凭证仅保留在本地维护者与服务端，部署时应使用只允许 zjh-dynamic 内容与 PR 写入的凭证，不下发手机或 Jules。

## 工坊确认

WORKSHOP Durable Object 串行管理一份活动心愿，记录会话确认凭证。新建会话会占用工坊；制作完成仍保留，只有用户确认合入或制作中止才能释放。不允许并行制作或向已完成会话追加任务。

POST /v1/workshop 的 status 接回状态，confirm 由用户点击触发。确认必须持有会话凭证，并核对正在运行代码的 buildId 等于最新清单 source.buildId、源码已提交且清单 commit 等于该会话 PR head、PR 属于 zjh-dynamic 并以 main 为目标、底稿没有遗漏 main 的改动。确认使用普通 merge 和预期 head SHA，重复请求可返回已经收好的结果；失败保留当前心愿。

发布仅表示作品可体验，不自动合入。升级前已有会话在首次接回时登记，旧包或与 PR 不对应的包仍不能确认。

## 权限边界

/v1/runtime 仅供动态构建读取，动态发布接口只能写 release 与 vendor 编号表。SDK 和包体按 SHA-256 不可变地址读取。运行时契约由 Android 壳维护者的管理权限发布。

Jules 代理仅暴露并允许 sources/github/jiangfengwhu/zjh-dynamic 会话。维护者须在用于云端 Agent 的 GitHub/Jules 集成授权中仅开放 zjh-dynamic，代理过滤不能代替账户授权。

云端环境只注入动态上传凭证和清单发布 token，不注入 JULES_API_KEY、Cloudflare 管理 token 或本机 Wrangler 登录信息。通过 /v1/catalog 的动态发布 token 不能写 /v1/runtime；直接 R2/KV 管理凭证的权限需要维护者另外配置，不能把 API 的限制等同于管理凭证的限制。

纯文档修改无需部署 Worker。
