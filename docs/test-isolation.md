# QUALITY-001：默认测试隔离真实模型

## Intake（2026-11-26）

- 基线：`6b42c3df157bc895622d4c19b73dc285f5a7b996`，主工作区 clean；独立分支 `codex/fix-quality-001-offline-tests` 与 worktree `quality-001-offline-tests`。
- 用户结果：日常 `pnpm test`、`pnpm test:coverage`、`pnpm check` 不因本机网关在线而运行付费模型验收。
- 验收：四组 11 项真实模型用例单独收集，原断言保留；只有显式 `pnpm test:live` 执行；直接误收集在任何探测前拒绝；显式执行缺少网关或 DSH 时失败；默认 fetch 拒绝外网与本机 3425 模型网关，保留本地 HTTP 夹具；回归先红后绿；完整 check 与 smoke 通过。
- 非目标：不改变生产模型、权限、用户数据、质量阈值或实际模型语义；不在本次修复中执行付费验收；不实现操作系统级网络沙箱或完整费用预算平台。
- 数据与权限：默认检查只使用测试数据；真实测试仍用临时数据库、workspace 和 DSH home，不读取生产任务；模型选择沿用 `PEGAS_LIVE_MODEL`。
- 失败与恢复：默认测试访问受阻地址时给出明确错误；真实测试依赖故障保持失败，修复环境后显式重跑。回滚本 Feature 提交即可，无数据库迁移；回滚将恢复原来自动调用模型的行为。

## 运行方式与保护范围

- 默认 `pnpm test` / `pnpm test:coverage` / `pnpm check` 不收集 `test/support/test-suites.ts` 列出的四组 11 项付费模型用例。即使继承 `PEGAS_LIVE_TESTS=1`，默认配置仍隔离这些文件。
- `pnpm test:live` 显式设置 `PEGAS_LIVE_TESTS=1`，使用独立配置；支持 `PEGAS_LIVE_MODEL=<路由>` 与文件名 / `-t` 过滤。串行执行、Vitest 不自动重跑；生产 Provider 内已有的有限 HTTP 重试仍保留。这不是费用上限，执行前应选定验收范围。
- 真实套件在目录探测或 DSH 启动前检查授权开关；依赖不可用会失败，不再条件跳过。默认测试与付费验收的结果必须分别报告，默认门禁不声称验证模型语义。
- 普通测试的 fetch 只允许带端口的 HTTP 回环地址，拒绝本机 3425 网关；强制禁止自动重定向，手动重定向的下一次 fetch 再检查。测试可注入固定响应；已有 Provider HTTP 协议测试仍走真实本地夹具。
- 此防护只覆盖 Vitest 进程中的全局 fetch，不能作为系统网络沙箱：原生 http/net、独立子进程及其他端口上的本机转发服务不在其保证范围。四组真实 DSH 启动由独立收集与入口授权隔离。新增真实模型套件须登记到独立集合；进一步子进程网络隔离与预算计量是后续缺口。
- 普通 `pnpm smoke` 显式关闭记忆蒸馏和输入改写；模型配置指向本次测试创建的回环拒绝端点，用例末尾断言没有模型请求，避免继承开发环境中的模型配置。`pnpm smoke:memory` 是独立的真实 Hindsight 验收，会消耗模型 token；`pnpm smoke:dsh-auth` 使用真实 DSH 对接假响应回环网关，不消耗付费模型 token。
- `pnpm smoke:command-authorization` 使用真实 Electron、Worker 和 DSH，模型请求只访问脚本创建的确定性回环网关，Git fetch 只访问隔离本地 bare remote。它验证实际 FETCH_HEAD 变化与撤销后不执行，不验证外部模型语义或 HTTPS 远端服务；运行前置条件与 CI 证据见 [命令授权](command-authorization.md#验证证据)。

## 验证记录

- 原配置：四组默认收集回归 4/4 失败；普通 smoke 配置隔离回归 1/1 失败。
- 修复后定向验证：3 文件 / 31 项通过（收集隔离、外网与网关零传输、重定向限制、环境开关泄漏、真实验收前置条件、OpenAI/Anthropic 本地 HTTP 协议）。
- 与最新 `origin/main`（仍为基线 `6b42c3df`）对齐后，`pnpm check` 全绿：149 文件 / 1616 项通过、0 跳过；statement 78.25%、branch 71.73%、function 75.07%、line 81.31%，阈值未改。格式、品牌、ESLint、类型、Knip、三端构建全部通过；构建保留既有 >500 kB chunk 提示。
- `pnpm smoke` 通过，Task→Run、通知 webhook、定时 Automation 与零模型请求断言通过；额外在继承 `PEGAS_MEMORY_PROVIDER=hindsight PEGAS_REWRITE_MODE=light` 时也通过。
- `env -u PEGAS_LIVE_TESTS pnpm exec vitest run --config vitest.live.config.ts` 按预期拒绝全部四组套件（4 个显式 opt-in 错误，0 个测试执行），没有网关探测或 DSH 启动。
- 四组 11 项真实验收的 TypeScript 测试体 AST 与基线一致，原有断言和文字参数保留。付费验收未运行，不声称本次验证了上游模型质量。
- 初次交付为独立 Feature 提交，后续通过 PR 集成；远程 CI 和合并状态以对应 PR 记录为准。
- 合并前复验（2026-11-26）：rebase 最新 `origin/main`（`9755635d`）无冲突，`pnpm check` 149 文件 / 1618 项通过、0 跳过；statement 78.31%、branch 71.76%、function 75.12%、line 81.37%；`pnpm smoke` 通过。未运行付费验收。

APPROVAL-001 桌面命令夹具在 Linux 使用用户目录下的独立临时目录：bwrap 会把 `/tmp` 换成私有挂载，工作区之外的 sibling remote 不可见。远端仍位于授权工作区之外且只读，不添加可写目录或关闭沙箱；每次 Git 工具结果同时断言零退出和真实 FETCH_HEAD。
