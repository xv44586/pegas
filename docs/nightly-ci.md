# QUALITY-001：夜间质量检查

> 当前正在迁移到自有服务器/Mac；尚未启用。机器确认与磁盘空间阻塞见末尾记录。

## Intake（2026-11-27）

- 用户结果：每天自动检查主线的恢复、浏览器交互与稳定性；每次修改后的验证、热更新无需等待 nightly。
- 基线：主工作区 `154a9b205c0df268ff56e2cb2fb243187f7b8e79`、clean；从最新 `origin/main` `7527f4f6bcfc7fc241d1ad040b3ce7383be78a3f` 创建独占 worktree `quality-001-nightly-ci` 和分支 `codex/quality-001-nightly-ci`。
- 验收：北京时间每日 03:17 与手动入口；固定 SHA；自有 runner、只读仓库权限、超时与并发组；完整 check/普通 smoke、进程恢复、强制浏览器验收及有限重复测试；失败保留日志和摘要；保留原有 CI 检查和热发布门禁，执行机器迁为自有 runner。
- 非目标：付费模型与 Hindsight 验收、生产监控、自动修复/合并/发布、修改分支保护、安装包签名、多平台矩阵。
- 数据与权限：自有 Linux runner 和本机 macOS runner、测试数据与回环服务；不注入生产 secrets，不访问生产 Supervisor，不消费真实模型。恢复 smoke 中的候选切换仅限临时 Supervisor。
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
- 固定 checkout `github.sha`，四组自有 Linux job 分别执行 baseline（完整 check 与普通 smoke）、recovery（三项进程 smoke）、browser（强制全站浏览器验收）、stability（lease fencing、审批、通知投递、备份恢复四套测试重复十轮）。
- 每组 30 分钟超时；matrix 串行且不 fail-fast；nightly 使用自己的 concurrency group，不取消或等待 PR CI、发布工作流。只有同一 ref 的 nightly 运行之间串行。
- 恢复/浏览器测试显式禁用记忆蒸馏、输入改写、模型对账和 live 开关。默认测试继续使用既有离线 fetch 边界；不注入任何 secrets。安装依赖和浏览器仍需要网络，不把此流程声明为操作系统级网络沙箱。
- 恢复测试使用临时数据与回环端口。self-change smoke 的 Candidate 与 Supervisor 均在测试环境中；不调用 `release:hot`，不接触正在运行的 App。
- shell 使用 Bash pipefail，`tee` 不吞掉失败退出码；一项恢复检查失败后其余恢复检查仍执行。十轮稳定性测试会保存每轮日志与 JSON，任一轮失败就令该组失败。
- always 步骤写入包含 SHA、run URL、attempt、Node 版本和步骤 outcome 的摘要/JSON，日志与浏览器证据归档到 runner 用户的 `~/.local/state/pegas-ci/evidence/`，保留七天；GitHub 仅保存日志和摘要，不上传 artifacts 或依赖缓存。测试数量在 check 日志及稳定性 JSON 内；安装或构建失败后的未执行检查显示 skipped，不能计为通过。

## 与即时测试、热更新的边界

每次修改后的完整门禁、相关 smoke、精确提交 CI 与不可变 Candidate 发布流程保持不变。Nightly 保持独立 workflow；现有 CI 只迁移 runner 与证据存储，不删减检查，不更改 required checks 或分支保护，不提供任何部署、自动修复或自动合并步骤。夜间绿色状态不替代 Candidate 的精确提交与产物证明；夜间失败也不会自动回滚用户当前使用的 App。

## 未覆盖与运维

- GitHub 定时触发不是实时保证；检查 Actions 中的最近运行时间和各组结果。超过 36 小时没有成功运行应视为过期证据，不能用旧绿色状态宣称健康。本版没有独立于 workflow 的漏跑告警服务。
- GitHub 自身通知取决于账号订阅设置；本版不新增邮件、消息渠道或自动 Issue。
- Nightly 不运行付费模型、真实外部通知服务、Hindsight、macOS 安装包或长期资源泄漏测试；现有 macOS 凭据隔离检查继续在自有 Mac 执行；这些属于后续独立验收。
- 尚未经历实际定时触发时，应明确报告“配置已部署，定时观察待完成”；不能把手动成功称为已验证夜间调度。
- 回滚可在 Actions 禁用 Nightly，或撤回新增 workflow。本变更无生产配置/数据库变更，App 无需重启。

## 自有机器迁移 Intake（2026-11-27）

用户明确要求 PR/main CI 与 nightly 全部迁到自有机器、保留质量门禁，并提出 dev-machine 承接夜间检查。修改前 worktree clean、HEAD `32496000`，最新 main 仍为 `7527f4f6`。复用原 QUALITY-001 分支，不改生产运行目录。

- Linux job 使用 `[self-hosted, Linux, X64, pegas-ci]`；macOS 专属 job 使用 `[self-hosted, macOS, ARM64, pegas-ci]`。保留 CI 的 `check` 与 `credential-boundary-macos` 名称，所有原检查仍执行。
- GitHub 保留 PR/push/schedule 调度与检查状态；自有 runner 执行代码。没有 GitHub 托管计算回退，也不新增 Codex 模型调度。安装与后台服务只使用独立 runner 目录。
- checkout 不保留仓库 token；不配置生产 secrets。Linux runner 预装 bubblewrap、Xvfb 与浏览器系统依赖，job 不运行 sudo 安装；应用数据与测试目录隔离。
- `scripts/archive-ci-evidence.ts` 只归档三个预定 output 子目录，精确 SHA、步骤状态与机器位置写入 manifest 和 Actions 摘要。同一 run/attempt/job 不覆盖，七天后仅清理自身可识别档案，不上传 GitHub artifacts 或启用远端依赖缓存。
- 原有云端用量不会因迁移而消失；本变更不修改账单、预算或支付设置。账号限制是否也影响自有 runner 需实际排队验证。
- 服务器身份和安装状态以实机核验为准；尚未安装的 runner 不声明在线。服务回滚可停止/卸载本任务安装的 runner，GitHub 中移除相应注册；工作流不自动回退到收费托管机器。

### 迁移验证进度

- 工作流边界、运行时版本与本地证据归档测试：3 文件 / 19 项通过。覆盖安全路径、精确 SHA、失败事实、同 attempt 不覆盖、七天清理仅处理已识别档案。
- 完整 `pnpm check` 的格式、品牌、Lint、类型与 Knip 通过；coverage 阶段遇本机磁盘耗尽（ENOSPC），1741 项通过、2 项失败、37 个运行错误，未通过完整门禁，不作为完成证据。没有调整阈值、跳过测试或修改失败的产品测试。
- Mac runner 下载包已验证官方 SHA256；解压时磁盘不足，已清理本次下载和不完整目录。注册请求尚未执行，无 runner 服务安装；清理后磁盘约 527 MiB 可用，需先腾出足够空间才能安装并运行完整门禁。
- `dev-ts` 可连接，主机名 `ubuntu-22`、Linux x86_64、有 Docker、磁盘约 286 GB 可用。仍待用户确认它就是 dev-machine；只读检查，未在服务器安装服务或修改文件。
- 当前本增量状态 Partial / BLOCKED：机器确认、runner 安装、精确提交远程 CI、合并后 nightly 手动验收均未完成。原有远端 main 仍使用托管 runner，迁移尚未启用。

- 自有机器迁移后的 `pnpm smoke` 通过；十九项定向测试通过。当前完整门禁仍以 ENOSPC 失败记录为准，不能用定向通过替代。
