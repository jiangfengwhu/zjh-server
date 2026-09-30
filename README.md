# 紫金花服务端

独立维护 Cloudflare Worker：动态清单读写、R2 产物读取和 Jules 会话代理。Android 在 [zjh-android](https://github.com/jiangfengwhu/zjh-android)，RN 在 [zjh-dynamic](https://github.com/jiangfengwhu/zjh-dynamic)。本仓库由服务端当前快照建立独立历史，不携带客户端源码。

| 路径 | 职责 |
| --- | --- |
| src/index.ts | HTTP 路由、清单权限校验与 Jules 代理 |
| wrangler.jsonc | Worker、域名路由、KV/R2 绑定和迁移声明 |
| worker-configuration.d.ts | Wrangler 生成的运行环境类型 |

## 开发与部署

1. `npm ci` 安装工具。
2. `npm run typecheck` 检查类型。
3. `npm run deploy` 发布到既有 zijinhua Worker。

保留 zijinhua.297782.xyz 域名、CATALOG KV 和 BLOBS R2，继续使用现有线上数据与 Secrets。JULES_API_KEY 和 PUBLISH_TOKEN 由 Cloudflare Secrets 管理；本地调试可用忽略的 .dev.vars，不提交凭证。

## 权限边界

/v1/runtime 仅供动态构建读取，动态发布接口只能写 release 与 vendor 编号表。SDK 和包体按 SHA-256 不可变地址读取。运行时契约由 Android 壳维护者的管理权限发布。

Jules 代理仅暴露并允许 sources/github/jiangfengwhu/zjh-dynamic 会话。GitHub/Jules 集成自身的访问权限由账户管理员另外配置。
