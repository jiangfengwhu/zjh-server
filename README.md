# 紫金花服务端

独立维护 Cloudflare Worker：账号、应用清单、R2 产物和 Jules 工坊代理。Android 在 zjh-android，SDK/宿主在 zjh-dynamic，应用与云端任务在 zjh-plugin。本仓库只供本地维护者使用。

## 开发与部署

执行 npm ci、npm run typecheck 和 npx wrangler deploy --dry-run；协调升级后执行 npm run deploy。保留现有 Worker、zijinhua.297782.xyz 域名、CATALOG KV、BLOBS R2、WORKSHOP/ACCOUNTS Durable Object 与数据。纯文档修改无需部署。

JULES_API_KEY、GITHUB_MERGE_TOKEN、OFFICIAL_PUBLISH_TOKEN 只保留在服务端及维护者安全环境。GitHub/Jules 集成仅开放 zjh-plugin；合入 token 仅需该仓库内容与 PR 权限。旧 PUBLISH_TOKEN 不再允许发布。本地 .dev.vars 忽略，不提交凭证和缓存。

## 邮箱登录

在 Resend 验证发件域名后，用交互输入配置 Secrets，不将值放进代码或命令文本：

~~~powershell
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put MAIL_FROM
~~~

MAIL_FROM 格式为「紫金花 <login@你的已验证域名>」。缺配置时返回 503，不生成假验证码。POST /v1/auth/code 发送验证码；POST /v1/auth/verify 登录或创建账号，签发 90 天随机凭据，手机保存到 Keychain/Keystore。服务端只保存验证码及登录凭据摘要；验证码有效 10 分钟、最多 5 次验证、60 秒重发间隔，并限制邮箱、IP 和全局发送频率。按邮箱串行，网络发信不阻塞其他邮箱或内部身份读取，限额事务更新。

GET/PATCH /v1/account 读取资料或修改 1–24 字昵称；PUT/DELETE /v1/account/avatar 管理头像，接受不超过 1 MB 的 JPEG/PNG/WebP 并存入 R2 不可变地址；POST /v1/auth/logout 撤销当前登录凭据。以上要求账号 Bearer。公开市场昵称头像不包含邮箱或登录凭据。

## 作品与确认

创建、修改、停止、收下、分享、编辑和撤回都核对账号归属与作品 token。GET /v1/works 仅为当前账号返回作品、session 和作品凭据，换机可接回。创建携带稳定 requestId，在请求 Jules 前记录任务及唯一标题；结果不明确时恢复同一会话，不重复创建。

WORKSHOP 按应用串行，公开读取不等待云端请求；不同应用可并行，同应用收下后继续 session 的新轮次。默认每账号每天 10 轮、同时最多 3 个制作任务，短事务预留额度。模块范围由事务分配，既有 appId 与范围保持稳定。

POST /v1/workshop status 接回交付；confirm 由宿主确认后触发。运行 releaseId 等于本轮候选、source.dirty=false、候选 source.tree 等于最终 PR 的 Git 源码树（旧清单仍要求 source.commit 等于 PR head）；PR 属于 zjh-plugin、指向 main、仅改目标应用与必要根锁文件，并保留 main 的应用改动。普通 merge 核对预期 head SHA，失败保留任务，不自动分享。

## 发布授权

Jules 只接受 sources/github/jiangfengwhu/zjh-plugin。新会话禁用共享环境变量，平台在私有任务提示中签发 HMAC 授权，绑定 appId、ownerId、制作轮次和 7 天有效期；手机返回的 session/活动文本隐藏授权。暂停、收下或开启新轮次撤销旧授权。云端不得取得服务端密钥或本机管理权限。

SDK 1.1.7 的 authorize 将授权保存到 Git 元数据；PUT /v1/application-blobs/<id>/<sha256> 校验轮次、最大 40 MB 和内容哈希后写内容地址。PUT /v1/catalog 只允许该应用清单，携带 expectedReleases（首次 null），按应用串行比较权威 candidate 指针，冲突返回 409。KV latest 只作镜像；模块范围在写镜像前事务预留。不可变清单与候选须相同，包体须已上传。宿主 release/vendor 只用维护者凭据，/v1/runtime 不通过此接口修改。

原作复制绑定 originalAppId、originalReleaseId、originalCommit；初始化读取锁定 Git 提交的 src/assets 与纯 JS 依赖，不能改用 main 的新版源码。

## 开发者上架

应用共用 RN/JS 环境，appId 不构成恶意代码沙箱。开发阶段由开发者决定上架，制作和市场变更由宿主确认；当前不做恶意代码审核，未来 AI 检测另行建设。

candidate（latest 为私有别名）→ 作者体验 → 收下并合入 → accepted → 作者主动上架 → public。后续候选发布保留旧公开版本。候选、accepted、未公开清单仅允许该轮发布授权或账号加 X-Workshop-Token；市场、应用列表、APK seed、安装和回退只读开发者上架的 public。包体内容地址保持可读，不得将业务隐私资料打进包。

GET /v1/applications/<id>/releases/<releaseId> 对已经公开过的快照保持可读，便于已安装应用在更新或撤回后继续运行；私有候选仍须鉴权。已安装公开快照允许离线启动。

官方发布者固定 ID 为 00000000-0000-4000-8000-000000000001，昵称「紫金花官方」，email=null，无验证码登录入口。Jolly、notepad、pomodoro 为官方应用。维护者经 POST /v1/official-release 明确指定不可变版本收下并公开；云端不能调用。authorOfficial 由服务端生成，改昵称不能获得官方身份。

升级须协调 SDK 固定 tarball、server、宿主和 Jolly，旧工具不兼容新授权接口。部署前停止旧任务，撤销历史云端共享 R2 凭据并从 Jules 环境移除；禁用新会话变量不能收回历史密钥，旧会话继续前须清除环境或迁移。完整顺序见 zjh-dynamic/docs/market-trust.md。

开发清库：维护者以 POST /v1/development-reset 及 confirm=RESET_WORKSHOP_DEVELOPMENT_DATA 清除工坊任务、候选、分享和应用清单，保留账号、runtime/宿主清单及不可变产物。重置期间停止新请求并等待在途请求结束，然后重新发布官方应用。不支持历史仓库基线或匿名任务迁移。

Jules 交付按源码树核对，允许提交号重写但拒绝源码内容变化；收下记录最终 PR head 和已核对源码树，分享保持 immutable releaseId，原作初始化使用可从 GitHub 获取的实际 PR 提交。
