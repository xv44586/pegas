# EXEC-007：DSH 独立 Node 运行时

基线：`f019b33461cbc7f2608bf6fc5cdb58f00e62a2fd`，主工作区无未提交变更。独立分支 `codex/fix-exec-007-standalone-node-runtime`。

## 验收条件

- 从真实 Electron（包括已安装 App）继承最小 Finder PATH，目录读取、完整 DSH host boot、模型 HTTP 请求、只读文件工具调用、session 恢复全部成功。
- DSH Node CLI 使用独立 Node，绝不将 Electron 的 `ELECTRON_RUN_AS_NODE` 当作兼容性证明。安装包和不可变 Candidate 自带 Node 二进制及其许可证；运行不依赖开发 worktree、nvm shell 初始化或个人 DSH profile。
- 缺失、过旧或误装 Electron 的运行时明确失败，不静默退回 Electron。启动失败在创建临时执行资源之前发生。
- Lint 禁止执行器绕过共享启动器或直接使用当前宿主可执行文件；CI 在 Electron 父进程内跑真实 DSH 和本地 HTTP fixture，不以目录读取或 mock CLI 代替执行验证。
- 完整 check、smoke、新 runtime gate 通过；Feature Map、架构、配置说明及既有 Lesson 同步更新。

## 边界与恢复

不修改用户任务、模型凭证、代理设置或 DSH 安装；不重试原有可能产生副作用的任务。不升级 Electron 以追赶 DSH 的内部 ABI 支持名单，不改变工具审批权限。测试只在临时 home/workspace 和 loopback HTTP 服务中读测试文件。运行时随 Candidate 版本与摘要固定，故障通过 Supervisor 回滚整个 Candidate；现有数据库和 session 格式不变。

## 初始证据

2026-11-26，同一 DSH 0.2.2-rc.5、隔离 home、最小 PATH：已安装 Electron 的 `--dump-config` 成功，`--help` 完整 boot 失败（Unsupported/no-context）；独立 Node 24.22.1 两者成功。DSH package engines 要求 Node >=24.9.0。此前目录回归未加载 native host，是错误完成声明的根源。原始本地证据位于 ignored `output/exec-007-runtime/baseline.json`；第三方调研放在 ignored `research/dsh-runtime/`。

## 验证记录

- 2026-11-26：基线真实 Electron/Node 对照复现；新 Electron smoke 先红再绿。
- 4 个执行器相关测试文件 / 53 项通过；完整门禁 150 文件 / 1,632 项通过。
- ESLint 的直接宿主、计算属性宿主、直接 spawn DSH 三种反例均被拒绝。
- smoke 与真实 DSH 鉴权合同（17 Provider、4 HTTP 场景）通过；新增 Electron 门禁含目录、真实只读工具和 session 恢复，共 3 次 HTTP 请求。
- 独立 Node 体积约 117 MiB，是安装包增加的主要成本；保留完整 Node 许可证。签名/公证仍沿用仓库既有本地分发方式，未在本次引入。
- 打包后隔离验证：macOS Electron smoke 通过；从安装包解包目录加载执行器，使用真实 DeepSeek Flash 读取随机测试文件并核对内容通过。未重试用户原任务。
