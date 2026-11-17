# Pegas Repository Rules

## Feature 开发流程

所有 Feature、Bug 修复和结构性重构都必须遵循以下流程。主工作区只用于集成与运行稳定版本，不能作为多个任务共享的开发目录。

### 1. Intake：先定义再编码

1. 阅读 `docs/feature-map.md`、相关架构文档和现有测试。
2. 使用 Feature ID、用户结果和关键领域词搜索代码，确认是否已有相同或相邻能力。
3. 复用已有 Feature ID；确实是新能力时，先在 Feature Map 中登记 ID、用户结果、初始状态、权威实现和验收证据。
4. 开始编码前写清验收条件、非目标、数据与权限边界，以及失败和恢复行为。

### 2. Isolation：一个 Feature 一个工作区

1. 每个 Feature 必须使用独立 Git branch 和独立 worktree；branch 建议命名为 `feat/<feature-id>-<slug>` 或 `fix/<feature-id>-<slug>`。
2. 一个 worktree 同一时间只属于一个 Task/Agent。不得让多个 Agent 在同一工作区并发修改，也不得直接在运行中 Pegas 的主工作区开发。
3. 创建 worktree 前记录基线 commit 和工作区状态。发现未知的未提交改动时，不覆盖、不格式化、不暂存、不删除，也不把它们带入自己的 commit；应先确认归属，或创建不包含这些改动的新 worktree。
4. 如果无法获得隔离 worktree，停止代码修改并报告阻塞；不能以“改动很小”为由在共享工作区继续。

### 3. Implementation：保持边界和最小闭环

1. 从最小可验证的纵向闭环开始，复用既有领域对象、接口和事实来源，不为不同客户端复制服务端能力。
2. Router 只负责输入所属 Task 和控制意图，不判断 Executor 的工具能力，也不代替实际 Agent 向用户答复。
3. Conversation 的权威状态在服务端；Web、iOS、macOS 和其他渠道只做交互适配。
4. 用户可见的执行确认由实际 Executor Agent 在检查真实工具和权限后生成。传输状态只作为界面元数据展示。
5. 数据库、外部副作用、权限或恢复路径的变更必须同时设计幂等、兼容、失败恢复和回滚行为。
6. 不顺手修改无关功能。发现相邻问题时记录到对应 Feature，而不是扩大当前 commit。

### 4. Verification：证据先于完成声明

1. 新功能必须有自动化测试；Bug 修复必须先增加能复现原问题的回归测试。
2. 完成修改前运行 `pnpm check`；涉及进程、持久化、通知、网络或恢复链路时同时运行 `pnpm smoke`。
3. 不能只报告“命令执行过”，必须记录测试数量、关键场景和仍未覆盖的风险。
4. 不通过降低覆盖率阈值、关闭 Lint 规则、跳过测试或添加宽泛 Knip 例外来绕过质量问题。
5. 验证必须在当前 Feature worktree 中完成；合并或 rebase 最新目标分支后，再运行一次完整门禁。

### 5. Documentation：代码与地图一起演进

1. 同一变更中更新 Feature Map 的状态、权威实现、自动化证据和下一缺口。
2. 架构边界、运行方式、配置、数据模型或恢复行为变化时，同步更新对应文档和示例配置。
3. `Scaffold`、`Partial`、`Usable` 和 `Hardened` 必须按 Feature Map 定义如实标记；存在关键缺口时不能标记为 `Usable`。

### 6. Integration：只合并可独立审查的 Feature

1. 一个 PR/commit 系列只承载一个 Feature ID；不得暂存或提交其他 Task/Agent 的改动。
2. 合并前检查 diff、Feature Map、迁移与回滚说明，确认没有凭证、本地数据、生成产物或意外文件。
3. CI 全绿后才能进入主分支。合并后在主分支或候选 Release 上执行关键路径 smoke test。
4. Pegas 自我修改时，不直接替换当前运行版本；必须构建不可变 Candidate，由独立 Supervisor 验证、切换，并在观察失败时回滚。

### 7. Completion：明确交付状态

只有同时满足以下条件才能宣告完成：验收条件满足、自动化证据通过、完整质量门禁通过、Feature Map 与相关文档已更新、改动位于独立可审查的提交中、已说明剩余风险和回滚方式。

如果并发任务仍在写入、CI 因其他 Feature 失败、改动尚未隔离或无法区分文件归属，状态必须报告为 `DONE_WITH_CONCERNS` 或 `BLOCKED`，不能提交混合改动或宣告全部完成。

## 长期架构约束

- Router 只负责输入所属 Task 和控制意图，不判断 Executor 的工具能力，也不代替实际 Agent 向用户答复。
- Conversation 的权威状态在服务端；Web、iOS、macOS 和其他渠道只做交互适配。
- 用户可见的执行确认由实际 Executor Agent 在检查真实工具和权限后生成。传输状态只作为界面元数据展示。
