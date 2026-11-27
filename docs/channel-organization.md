# 事情列表整理

Feature：CHANNEL-004。2026-11-27 intake；基线 `154a9b205c0df268ff56e2cb2fb243187f7b8e79`，主工作区干净。隔离分支 `codex/channel-004-organization`。

## 验收条件

- 左侧分为「固定的事情」与「最近的事情」；固定项不因新事情出现而消失；最近列表可续页，置顶列表也不得静默截断。
- 事情可固定/取消固定、归档/恢复。状态重启、刷新、跨客户端保持；归档隐藏于默认列表，已归档视图可找回，归档保留固定偏好但不显示在固定区。
- 所有事情的搜索、状态过滤、三种时间排序、分页由同一服务端查询执行；切换条件重置游标，异步旧响应不得污染新列表；失败可重试。
- 归档独立于 Task 状态。cancelled 显示「已停止」，不得伪装归档；归档不停止 Run、撤销授权、清除通知或删除历史；恢复不自动执行。
- 会议纪要、笔记、讨论沿用现有 WorkChannel，已完成事情仍按既有 Mandate 复核续接。

## 边界与非目标

服务端以 Task owner 为边界保存列表偏好；沿用实例 bearer。新元数据不进入 Router/Executor 执行合同，不修改 Task/Run/Conversation 权威状态。不实现文件夹、批量处理、自动归档、拖拽排序或独立笔记编辑器。

## 一致性与恢复

使用纯增量偏好表，旧记录默认未固定未归档；显式布尔赋值与 revision 比较，重复同值请求幂等，冲突重新读取后再操作。写入失败保留原列表状态；响应丢失可安全重试同值。排序沿用 CHANNEL-003 查询与 ID 决胜。分页期间有新活动时刷新列表取最新顺序。

回滚代码不会删除偏好与历史；旧版本忽略新增元数据，因此归档项会再次显示，但不会启动或停止执行。发布与运行实例切换另走 Candidate/Supervisor 流程。

## API 与集成

- `PUT /v1/channels/:id/organization` 接收 `{ userId, pinned, archived, expectedRevision }`，返回服务端 Channel 投影。不存在或非 owner 返回 404，revision 冲突返回 409；请求沿用实例认证。
- Channel 投影增加 `organization: { pinned, archived, revision }`。历史客户端可忽略字段，Web 缺字段按未固定未归档显示。
- `GET /v1/channels/search` 增加 `pinned`、`archived`、`waiting` 布尔过滤；未传时保持旧合同。所有事情与两组侧栏列表每页 8 条，使用已有时间排序与 ID 决胜游标。
- 已集成目标 `origin/main` `7527f4f6`。该目标占用 schema 60/61，本 Feature 迁移编号调整为 62（新建 `channel_organization`），并同步 Candidate 兼容上界。点击侧栏沿用新主分支的事情专属对话页，不丢失专属历史与草稿。
- 轮询发现列表成员、活动时间、状态或偏好版本变化时，重新读取首屏以获得最新排序；保存返回后取消较早轮询结果的写入资格。设置页隐藏侧栏时卸载其查询，避免后台无关请求。

## 验证

2026-11-27，同步目标 `7527f4f6` 后完成：

- `test/channel-organization.test.ts` 4 条：纯增量迁移及重开、同值幂等/revision 冲突、停止与归档独立、Task/Run 不变、三种排序分页全量可达、owner 隔离、HTTP 认证/404/409/非法输入。
- `web/src/sealed/ChannelOrganization.test.tsx` 5 条：停止不得进入归档（旧实现失败）、续页去重/失败保留游标/重试、筛选排序重置、丢弃旧查询响应、独立固定区与最近续页、保存失败可重试。
- `pnpm check`：160 个测试文件、1853 条测试全部通过；statement 79.02%、branch 72.68%、function 75.97%、line 81.98%。格式、品牌、Lint、类型、Knip、覆盖率及 server/web/desktop build 全部通过。
- `pnpm smoke`：真实隔离 Control Plane、Worker、Scheduler、Notification，事情/Run、项目与独立目录、自动化和通知链路通过。
- 本地真实服务端 + Chromium：1440×960、540×900、390×844；首屏 8 条和续页、固定后刷新保持、进入事情专属对话、归档/恢复；无横向越界、无脚本错误。明暗主题主内容 axe WCAG A/AA 无违例；真实触屏模拟确认整理按钮至少 44×44。捕获动画结束后再做颜色检测，避免把主题过渡中间帧当作最终对比度。
- 独立 impeccable UI 审查结论 SHIP；已修正触屏点击宽度与 521px 附近固定列宽挤压。截图与临时浏览器验证脚本保留于本 worktree 忽略目录 `.impeccable/review/`、`output/playwright/`，不提交生成物。

## 交付与剩余边界

源码位于独立 Feature 分支，可独立审查；尚未合并主分支、运行远程 CI 或发布 Candidate，运行实例不变。后续合并必须通过 CI，发布必须由 Supervisor 执行。

当前全局 Conversation snapshot 仍沿用既有全量读取；这次事情列表和侧栏查询虽已分页，尚不承诺海量历史的启动性能。固定组按创建时间稳定排序，不含拖拽自定义顺序；运行/偏好有新事实时列表回到首屏重新查询。没有更改 Router 的长期主题自动归类规则。真实 iOS/macOS VoiceOver 未测试；浏览器和自动化证据不替代原生辅助技术验证。

回滚本 Feature 提交并重新构建 Candidate 即可撤回 UI/API；保留 schema 62 偏好表与历史数据，旧代码忽略它。仍须满足已有其他 Feature 的 Supervisor 回滚限制，不能据此绕过权限、项目目录或任务恢复 Guard。
