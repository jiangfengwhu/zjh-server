# 服务端边界

只维护服务端源码和部署配置，客户端分别由 zjh-android 与 zjh-dynamic 维护。
保持现有 Worker 名称、路由、KV/R2 绑定、数据和 Secrets，不因迁移新建生产存储。
动态发布接口不得写运行时契约；Jules 会话必须限制到 zjh-dynamic。
不提交 node_modules、.wrangler、.dev.vars、凭证或构建缓存。本次迁移不新增测试文件，使用类型检查与部署构建验证。
