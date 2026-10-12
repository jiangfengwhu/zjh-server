# 求职急救站统一内容接口

一个接口：`https://zijinhua.297782.xyz/v1/career-rescue/content`。GET公开读取五类资料；PATCH批量新增、覆盖和删除，可在同一批次混合所有kind。PUT全量替换。旧materials接口和脚本已删除。

维护者在server仓库运行：

```sh
node scripts/update-career-content.mjs C:\资料\本次更新.json
```

全量替换加`--replace`。授权沿用本机保存的维护者配置，脚本自动读取revision与处理并发冲突。发布内容不需要重发应用。

正文格式为`{"items":[...],"removeIds":["待删除id"]}`。PUT不传removeIds。批次id不得重复，也不得同时更新和删除；失败整批不写入。单条32KiB，整个库1MiB、最多500项。成功返回published、revision、count和按kind分类的counts。

| 字段 | 说明 |
| --- | --- |
| id | 全库唯一，以小写字母开头，最多64位小写字母、数字、短横线 |
| kind | resume / question / followup / risk / timeline |
| title、body | 标题最多160字；Markdown正文最多12000字 |
| company | 公司名称，可选；risk、timeline及公开面经必填 |
| roles、tags | 各最多12项；roles为自由岗位标签，通用资料可写通用 |
| provenance | 官方资料 / 公开面经 / 示例。非示例必须提供source |
| source | `{label,url}`，真实来源名称与无凭据HTTPS链接 |
| updatedAt | YYYY-MM-DD有效日期 |

各类额外字段：

| kind | 字段 |
| --- | --- |
| resume | before、after：改写前后正文，各最多6000字；公司与来源用于大厂语料筛选，先脱敏 |
| question | question必填，followups最多12项；provenance为公开面经时须company、interviewDate（YYYY-MM-DD） |
| followup | body写追问逻辑；通过roles、company、tags确定适用范围 |
| risk | company、source必填；severity为高/中/低，reportCount为1–100000；不接受示例指控。请提供可追溯反馈，不将传闻写成已核实事实 |
| timeline | company、source、startAt、eventType必填；eventType为网申/笔试/面试/截止/宣讲；可填endAt、applicationUrl。时间须为带时区ISO日期，如2026-10-20T18:00:00+08:00 |

一批更新多类的示例：

```json
{
  "items": [
    {"id":"resume-star-demo","kind":"resume","title":"项目表达示例","body":"说明STAR结构和事实边界。","roles":["通用"],"tags":["STAR"],"provenance":"示例","updatedAt":"2026-10-12","before":"负责项目。","after":"负责［真实模块］，完成［真实动作］，交付［可核验结果］。"},
    {"id":"question-project-demo","kind":"question","title":"项目中的取舍","question":"你如何选择项目方案？","body":"说清约束、备选方案与验证方式。","roles":["通用"],"tags":[],"provenance":"示例","updatedAt":"2026-10-12","followups":["为什么没有选择另一方案？"]}
  ],
  "removeIds": []
}
```

直接HTTP维护：Authorization使用维护者凭据，Content-Type为application/json，If-Match填写GET正文revision的强ETag，例如`"3"`。公开GET支持If-None-Match及304；不要将Cloudflare可能返回的弱ETag直接用于写入。403无权限、428缺版本条件、409冲突、400格式错误、413超限。

应用按五分钟缓存静默更新，也支持用户刷新。用户简历、回答与面试日程按账号保存在本机，不进入此公开接口。
