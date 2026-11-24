# Feature Review Gate

> Feature：`QUALITY-001`
>
> 状态：Usable
>
> 更新日期：2026-11-24

## 用户结果

Pegas 把可重复的测试能力和验收契约永久保留在仓库中，但不再为每次 Feature 运行提交一份结果 manifest。PR 在准确 Git SHA 上完成检查后自动生成短期审核报告、截图和其他脱敏附件；审核人依据这些证据确认同一个 SHA，Candidate 只保存必要摘要与哈希。

## 永久事实与临时证据

永久进入仓库：

- Feature Map 中的用户结果、验收条件、非目标、数据和恢复边界；
- 自动化测试、浏览器几何断言、视觉阈值和 canary runner；
- CI、Candidate 和 Lessons 的门禁代码。

不进入主分支：

- `output/feature-review/report.json` 和 `summary.md`；
- 截图、录屏、录音、trace 和详细日志；
- 模型、ASR、通知等真实依赖的脱敏 canary 输出。

这些文件由 `.gitignore` 排除。GitHub Actions 以 artifact 保存 7 天，PR 的 job summary 展示同一份报告摘要。报告过期不会删除仓库里的测试能力，也不会改变已经创建的 Candidate manifest。

## 自动流程

1. PR 标题必须包含 Feature ID；验收条件仍以 Feature Map 和测试代码为准。
2. CI 显式检出 PR 的完整 head SHA（而不是 GitHub 临时生成的 merge commit）；`pnpm check` 和 `pnpm smoke` 完成后，再根据 diff 判断是否包含 Web 改动。
3. Web 改动运行 `pnpm review:ui`：在临时数据目录中启动构建后的 Pegas 和 echo Worker，生成首页、工作区展开、侧栏收缩、设置、插件详情和 390px 窄屏截图，同时检查页面、输入器和面板是否越界。
4. `src/model|speech|notification` 或 `services` 改动运行 `pnpm review:canary`（`scripts/capture-dependency-canary.mjs`）：在临时数据目录中启动构建后的 control-plane、echo Worker 和真实 notification dispatcher，向 loopback webhook 接收器投递 approval.required，核验幂等键、消息 ID、outbox 深链、prompt 不出信任边界、落库 sent 与站内完整 payload，写出只含字段名与断言结论的 `notification-real-service-canary.json`。
5. `pnpm review:evidence` 收集准确 head SHA、changed files、命令摘要和临时媒体的大小及 SHA-256，生成报告和 Markdown 摘要。
6. Web 改动没有截图、外部服务代码改动没有脱敏 canary，都会自动产生关键 `Not tried`，报告状态为 `incomplete` 并让 CI 失败。
7. 审核记录必须写明 reviewed commit SHA；之后有新 push 时必须重新运行和审核。

## 证据层级与完成声明

四种证据回答不同问题，不得相互替代：

1. `pnpm check` 和单元/集成测试只证明当前源码满足已编码合同。
2. PR CI、UI Review 和 Candidate 报告证明准确 PR head 在隔离环境中通过。
3. 合并记录只证明该 commit 已进入 main，不证明运行进程已经切换。
4. `/readyz`、实际静态资源与新浏览器页面中的原始用户场景，才证明正在服务的 main 可用。

完成报告必须明确列出已经验证到哪一层。用户报告的是运行中界面时，不能凭 Candidate 截图宣称问题已修复；合并并重启后还必须：

- 检查 `/readyz`，确认进程健康且实际静态资源来自合并后的构建；
- 用新页面按原始视口、展开/收缩状态和代表性长内容重现问题；有未保存状态的旧页面不得直接刷新作为验证手段；
- 对布局缺陷记录目标组件及其关键子元素边界，不能只验证页面能打开或某个移动视口正常；
- 发现运行实例与 Candidate 不一致时，把状态报告为未完成并继续定位，不先归因于缓存。

本地生成示例：

```sh
pnpm check
pnpm smoke
pnpm review:ui -- --changed-from origin/main
pnpm review:canary -- --changed-from origin/main
pnpm review:evidence -- \
  --changed-from origin/main \
  --feature QUALITY-001 \
  --artifacts-dir output/feature-review/media \
  --passed "pnpm check|quality gate passed" \
  --passed "pnpm smoke|isolated smoke passed"
```

## Candidate 绑定

Candidate manifest schema v2 保存临时报告的文件名、SHA-256、Feature ID、tested commit，以及审核人的 reviewed commit、身份和时间。`ReleaseStateStore.stage` 在状态变化前重新读取报告，确认：

- report、CI、release、artifact 和人工审核引用同一个完整 commit；
- report 没有关键 `Not tried`；
- report 与 release artifact 均未在 Candidate 创建后变化。

stage 完成后临时报告可以删除；Candidate manifest 已保留必要摘要和校验值，后续 `confirm` 与 `rollback` 不依赖临时媒体仍然存在。审核 SHA 不一致、报告不完整或文件被修改时保持当前 active Release 不变。

## 数据与权限边界

- GitHub 托管 CI 不持有生产模型、ASR 或通知凭证。通知投递 canary 使用真实 dispatcher 进程和 loopback webhook 接收器，在 CI 内即可执行且不产生外部副作用；需要生产凭证的模型/ASR canary 仍在受控 Candidate 环境执行。
- 报告不得包含 API key、token、环境变量、用户原文或上游响应全文。
- UI collector 使用临时 HOME/数据目录和 echo Executor，不读取或修改当前运行中的 Pegas。
- 截图和日志只进入短期 artifact，不提交到主分支。

## 失败与恢复

- Feature ID 缺失：修正 PR 标题，不自动猜测产品归属。
- UI 媒体缺失或真实依赖 canary 缺失：报告保留关键 `Not tried` 并失败，不能通过空 manifest 绕过。
- 截图采集失败：仍上传已经生成的临时目录和 job summary，修复采集器或产品问题后重跑。
- 新 commit：旧报告和旧审核不能复用，重新生成并确认新 SHA。
- PR merge commit 与 head SHA 不一致：以显式检出的 head SHA 运行门禁并生成报告；不得把 GitHub 临时 merge commit 写成 Candidate 的 tested commit。
- 回滚本门禁：撤销 `QUALITY-001` 变更即可恢复旧 CI；不得关闭既有格式、类型、覆盖率或 smoke 门禁。

## 仍需加固

当前 UI collector 覆盖 Pegas 的通用壳层状态，CSS cascade lint 会阻断主题覆盖切换为 column flex 时遗漏 `align-items` 重置；具体 Feature 的特殊页面状态仍应通过相应 Playwright 测试永久编码。通知投递已有 CI 内真实 dispatcher canary（2026-11-24）；需要生产凭证的模型/ASR canary 与受控 Candidate 环境的通用 runner 仍需随 SelfChange 执行器一起完成，合并后运行实例验证也仍是发布阶段责任。
