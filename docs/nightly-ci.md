# QUALITY-001：夜间质量检查

## Intake（2026-11-27）

- 用户结果：每天自动检查主线的恢复、浏览器交互与稳定性；每次修改后的验证、热更新无需等待 nightly。
- 基线：主工作区 `154a9b205c0df268ff56e2cb2fb243187f7b8e79`、clean；从最新 `origin/main` `7527f4f6bcfc7fc241d1ad040b3ce7383be78a3f` 创建独占 worktree `quality-001-nightly-ci` 和分支 `codex/quality-001-nightly-ci`。
- 验收：北京时间每日 03:17 与手动入口；固定 SHA；独立只读权限、超时与并发组；完整 check/普通 smoke、进程恢复、强制浏览器验收及有限重复测试；失败保留日志和摘要；原有 CI 和热发布门禁不变。
- 非目标：付费模型与 Hindsight 验收、生产监控、自动修复/合并/发布、修改分支保护、安装包签名、多平台矩阵。
- 数据与权限：GitHub 临时 Ubuntu runner、测试数据与回环服务；不注入生产 secrets，不访问生产 Supervisor，不消费真实模型。恢复 smoke 中的候选切换仅限临时 Supervisor。
- 失败与恢复：任一执行失败保留失败结论，独立 job 继续运行；重跑不覆盖原始证据。撤回或禁用新增 workflow 即可回滚，无产品数据迁移，也无需 App 热更新。

## 实施与验证

- 完整 `pnpm check`：159 文件 / 1851 测试全过，无跳过；statement 79.06%、branch 72.75%、function 76.14%、line 82.01%，阈值未变；格式、品牌、Lint、类型、Knip、三端构建通过。保留既有大 chunk 提示。
- 新增 `test/nightly-ci.test.ts` 7 项：时区与手动入口、即时发布边界、只读权限与 SHA、失败后的恢复检查、日志保留；执行实际 workflow 稳定性 shell 验证全通过/第三轮失败两种路径均跑满十轮且失败不被抹去；执行摘要命令验证失败与 skipped 原样记录、Markdown 正常换行。
- `pnpm smoke` 通过（含项目/独立目录执行、Task→Run、通知、Automation）；crash smoke 三崩溃点通过；self-change smoke 发布锁、正常接管、坏候选回滚和恢复平面在线通过；healthcheck smoke offline/recovered 通过。
- 强制 `review:ui` 通过：桌面与移动各 108 次弹层操作、四候选与详情闭环、205 条输入历史、事情对话导航和无障碍断言，以及各 12 次执行设置开关/保存回读。
- 稳定性四套测试每轮 52 项，十轮全部通过，共 520 次执行；每轮 JSON 与日志保留。13 段 workflow shell 语法检查通过。
- 首次完整门禁在同时运行浏览器验收时出现既有 `routing-candidates` 的 5 秒超时（1849 通过 / 1 失败）；保留原日志，单文件复跑 8 项通过，结束并发验收后完整复验 1851 项通过。不改该测试、不放宽超时。第二次新增摘要测试导致总数比首次多 1。
- 验证前再次 fetch，`origin/main` 仍为基线 `7527f4f6`；本地证据位于忽略目录 `output/nightly/` 与 `output/feature-review/`。远程 CI、合并和 nightly 手动运行结果以对应 GitHub Actions 记录为准。

## 运行方式

- `.github/workflows/nightly.yml` 在 UTC 19:17（北京时间次日 03:17）触发；GitHub Actions 的 Nightly 页面也可手动 Run workflow。调度文件合入默认分支后才会定时运行。
- 固定 checkout `github.sha`，四组临时 Ubuntu job 分别执行 baseline（完整 check 与普通 smoke）、recovery（三项进程 smoke）、browser（强制全站浏览器验收）、stability（lease fencing、审批、通知投递、备份恢复四套测试重复十轮）。
- 每组 30 分钟超时；matrix 不 fail-fast；nightly 使用自己的 concurrency group，不取消或等待 PR CI、发布工作流。只有同一 ref 的 nightly 运行之间串行。
- 恢复/浏览器测试显式禁用记忆蒸馏、输入改写、模型对账和 live 开关。默认测试继续使用既有离线 fetch 边界；不注入任何 secrets。安装依赖和浏览器仍需要网络，不把此流程声明为操作系统级网络沙箱。
- 恢复测试使用临时数据与回环端口。self-change smoke 的 Candidate 与 Supervisor 均在测试环境中；不调用 `release:hot`，不接触正在运行的 App。
- shell 使用 Bash pipefail，`tee` 不吞掉失败退出码；一项恢复检查失败后其余恢复检查仍执行。十轮稳定性测试会保存每轮日志与 JSON，任一轮失败就令该组失败。
- always 步骤写入包含 SHA、run URL、attempt、Node 版本和步骤 outcome 的摘要/JSON，上传日志与浏览器证据，保留七天。测试数量在 check 日志及稳定性 JSON 内；安装或构建失败后的未执行检查显示 skipped，不能计为通过。

## 与即时测试、热更新的边界

每次修改后的完整门禁、相关 smoke、精确提交 CI 与不可变 Candidate 发布流程保持不变。Nightly 不加入现有 `CI` workflow，不更改 required checks 或分支保护，不提供任何部署、自动修复或自动合并步骤。夜间绿色状态不替代 Candidate 的精确提交与产物证明；夜间失败也不会自动回滚用户当前使用的 App。

## 未覆盖与运维

- GitHub 定时触发不是实时保证；检查 Actions 中的最近运行时间和各组结果。超过 36 小时没有成功运行应视为过期证据，不能用旧绿色状态宣称健康。本版没有独立于 workflow 的漏跑告警服务。
- GitHub 自身通知取决于账号订阅设置；本版不新增邮件、消息渠道或自动 Issue。
- 本版不运行付费模型、真实外部通知服务、Hindsight、macOS 安装包或长期资源泄漏测试；这些属于后续独立验收。
- 尚未经历实际定时触发时，应明确报告“配置已部署，定时观察待完成”；不能把手动成功称为已验证夜间调度。
- 回滚可在 Actions 禁用 Nightly，或撤回新增 workflow。本变更无生产配置/数据库变更，App 无需重启。
