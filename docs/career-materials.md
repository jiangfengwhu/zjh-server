# 求职急救站资料维护

资料接口：`https://zijinhua.297782.xyz/v1/career-rescue/materials`。更新资料不需要重发应用包。使用既有维护者授权，客户端只能公开读取，不能修改资料。正文是结构化纯文本，不支持 HTML。

在 zjh-server 执行：

```powershell
node scripts/update-career-materials.mjs C:\资料\本次更新.json
```

默认批量新增/覆盖指定 id，其他资料不变。删除用 `removeIds`。整库替换加 `--replace`；未包含的远程资料会删除，内置原创模板和求职入口仍保留。脚本从本机已有维护者凭据读取授权，不在参数中传密钥。版本冲突会停止，重新检查资料后再提交。

初始资料格式见 [materials.json](https://github.com/jiangfengwhu/zjh-plugin/blob/main/apps/career-rescue/materials.json)。修改资料应保持 id 稳定，更新 updatedAt；服务端另生成正文版本，已学习的资料修改后会提示重新复习。

## 请求字段

顶层为 `{ "items": [...], "removeIds": ["要删除的id"] }`，仅删除时 items 传空数组。

| 字段 | 内容 |
| --- | --- |
| id | 小写字母开头，字母/数字/短横线，最多64字符，唯一且稳定 |
| kind | 考点、面经、指南 |
| title / summary | 标题≤100字、摘要≤300字 |
| roles | 通用、产品、运营、前端、后端、数据分析、设计，至少一项 |
| tags | 搜索与JD匹配用的关键词，≤8项，每项≤30字 |
| level / minutes | 入门或进阶；预计阅读分钟数1–60 |
| updatedAt | 这份资料整理/核对日期，YYYY-MM-DD |
| company / interviewDate | 面经必须提供实际公司和面试日期；指南可仅填公司 |
| sources | 1–5个 `{ "label": "来源名称", "url": "https://原文" }`，保留真实出处 |
| sections | 1–12个 `{ "title": "段落标题", "body": "正文，可用换行" }`，正文每段≤6000字 |
| question | 对应练习问题≤160字，考点必填，面经/指南可选 |
| answerPoints / followUps / pitfalls | 回答要点、追问、易错点，各≤10项，每项≤400字；省略为[] |

单份资料≤32 KiB，全库≤300份/1 MiB。面经注明真实经历的时间和轮次（轮次放 tags/正文），不要把自拟问题写成公司真题。练习情景和示例数据应在正文标明。

## HTTP

- GET：公开读取 `{revision, updatedAt, items}`，返回 `ETag: "版本整数"`；支持 If-None-Match，未更新返回304。
- PATCH：新增/修改 items、删除 removeIds，其余保留。
- PUT：完整替换 items。
- 写入均需 `Authorization: Bearer <维护者授权>`、`Content-Type: application/json`、`If-Match: "刚读到的revision整数"`，例如 GET 返回 revision=1，则传 `If-Match: "1"`。更新脚本会自动处理。
- 成功返回 `{published:true, revision, count, updatedAt}`。403无权限、428缺版本条件、409并发冲突、400资料无效、413超限。失败不修改已有资料。

应用打开时最多每5分钟静默同步，资料库右上角可以立即刷新；断网时使用本机缓存。学习状态、笔记、回答、收藏按账号保存在本机，不上传到资料接口。阅读不需要AI；点评使用用户配置的AI。
