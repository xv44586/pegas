# Web Outbox

> Feature：`NOTIFY-003`
>
> 状态：Usable
>
> 更新日期：2026-11-20

## 用户结果

用户可以从左侧展开的 Pegas 导航在 `Channels` 与 `Outbox` 之间切换。Outbox 聚合需要关注的结果、问题和阻塞，展示未读数量、消息详情、投递状态和来源 Channel；用户打开消息后，服务端记录产品已读状态，并可从详情直接打开来源 Channel 的工作区。

左侧 rail 的显式收缩合同不变：收缩后只保留展开按钮，Channels、Outbox、Pegas 身份、设置和插件入口全部隐藏。

## 验收条件

1. 展开 rail 中 `Channels` 与 `Outbox` 是同级页面导航，当前入口有明确选中状态和数量。
2. Outbox 列表与详情来自服务端持久消息，不在 Web 复制事实来源；刷新和直接 URL 访问可恢复当前消息。
3. 打开未读消息调用所有者范围内的已读 API；重复调用幂等，其他用户不能读取或修改该消息。
4. 产品已读状态 `readAt` 与外部投递状态 `pending`、`sending`、`sent`、`failed` 分离；查看消息不会伪造投递成功。
5. 消息详情显示来源 Channel，并能打开该 Channel 的现有右侧工作区。
6. 空列表、长文案、窄屏和移动布局仍可阅读，不产生横向越线或不可达控件。
7. 数据库迁移、存储、API 和 Web 交互均有自动化回归，`pnpm check` 与 `pnpm smoke` 通过。

## 数据、权限与接口

- `outbox_messages.read_at` 是产品已读时间；数据库 schema 版本为 12。
- `POST /v1/outbox/:messageId/read` 要求 `userId`，只更新属于该用户的消息，并返回更新后的消息。
- `status` 继续只描述通知 Dispatcher 的外部投递状态；它不随 Web 阅读动作变化。
- Web URL 使用 `?view=outbox&outbox=<messageId>` 保存当前入口和选择，不把消息正文写入浏览器存储。
- Web 只使用既有 Channel/Run/Outbox API，不从消息文本推断任务状态、Worker 能力或投递结果。

## 非目标

- 本 Feature 不新增审批决策、批量归档、删除、静默时段或通知优先级操作。
- 不改变哪些领域事件应该进入 Outbox；该策略仍由 Control Plane 和 Notification 领域负责。
- 不把普通 progress 复制到 Outbox，也不把外部投递回执当成用户阅读证据。
- 不实现全文搜索或分页；消息规模增长后的游标与虚拟列表属于后续加固。

## 与 GOAL-001 的后续边界

当前 `NOTIFY-003` 只提供持久消息的 Attention 列表、详情、已读和来源 Channel 跳转，不包含 Goal Contract、EvidenceRef、Review Pack、媒体附件预览或完成证据门禁。这些能力属于 Planned 的 `GOAL-001`，不能从现有 Outbox 文本消息推断已经实现。

后续扩展遵守以下产品边界：

- Outbox 是用户判断与验收的入口，Task 交付默认展示按 success criteria 组织的 Review Pack，而不是代码、工具调用和处理日志；
- 图片、视频、UI 和排版变化直接预览绑定最终 Artifact revision 的截图、关键帧或页面渲染；其他 Task 展示与目标匹配的外部确认、测试、数据校验、指标或来源 evidence；
- 多份 evidence 按 criterion 聚合去重，一份 Task 结果默认形成一份 Review Pack，不为每个过程事件制造通知；
- 完整 Artifact、来源 Channel 和 Execution Trace 通过按需入口下钻，Web 不复制服务端事实，也不从消息正文判断完成；
- 产品已读、通知投递、用户接受和 evidence 有效性分别保存，任何一项都不能推断其他项；
- evidence 预览继承用户、Task、Artifact 和敏感信息权限；服务端在 dispatch 时按接收者、渠道可信度和 sensitivity 生成渠道专属投影。站外渠道只提供脱敏摘要或认证短期引用，不嵌入无法在撤权后收回的 evidence 内容。

权威产品与数据合同见 `docs/goal-contract-and-evidence.md`。GOAL-001 实现时需要在独立 Feature worktree 中扩展存储、API、Web 和自动化证据，并保持 `NOTIFY-003` 的已读/投递语义兼容。

## 失败与恢复

- 快照加载失败沿用全局连接错误；已有消息不会被客户端删除或重写。
- 已读请求失败时保留未读视觉状态并显示可恢复错误；下一次打开仍可重试。
- 数据库迁移只新增可空列和索引，旧行默认未读；回滚应用代码时该列可安全保留。
- 回滚本 Feature 时移除 Web 入口和已读 API 即可；通知投递状态与已有 Outbox 数据无需回写。

## 自动化证据

- `test/sqlite-store.test.ts`：产品已读与投递状态分离、幂等和用户隔离、schema 12 迁移。
- `test/control-plane.test.ts`：已读 API 所有者成功与跨用户拒绝。
- `web/src/App.test.tsx`：左侧入口、未读数量、自动已读、投递状态不变和来源 Channel 跳转。
