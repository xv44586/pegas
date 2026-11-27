# EXEC-009：项目绑定与工作目录

## Intake

基线：`f38e56b6852501ca470cc3c241274ea79468819c`；主工作区 clean。独立分支 `codex/exec-009-project-workspaces`，独立 worktree `pegas-worktrees/exec-009-project-workspaces`。

用户结果：用户可直接选择资料夹/照片目录，也可登记项目并为输入或已有事情选择项目，Agent 在该项目或用户指定的任务目录启动，能加载对应仓库规则；续跑不会串用另一项目的目录或会话。

### 验收条件

- 普通目录可以直接绑定 Task，不创建 Project，不要求 Git 或规则文件；没有规则文件时正常执行。
- 项目由服务端按用户、执行节点持久保存；名称不作为身份，目录为绝对路径。登记操作幂等。
- 显式项目输入只进入该项目的 Task；Task 续跑继承持久绑定。日常未绑定输入仍使用 EXEC-008 默认工作区。
- 用户可在任务空闲时绑定项目或指定执行目录（包括用户自己建立的 worktree）。运行、排队、审批等待期间不原地改目录。
- Run 保存项目、节点、cwd 和绑定版本；真实 Executor 使用该 cwd。目录不存在、非目录或符号链接换指向时在模型执行前失败，不回退默认目录。
- Agent 原生仓库规则加载器随真实 cwd 工作。真实 DSH + 本地模型桩验证 AGENTS 正文进入模型请求；不由 Router 解释或替代仓库规则。
- 是否创建 worktree、使用哪个分支、是否允许修改主目录由用户指令和项目规则决定；harness 不创建 worktree、不修改 Git 状态、不加入开发流程要求。
- 项目绑定不继承宿主 gh/SSH/Keychain 凭证，不改变现有权限档位及审批；目录选择是显式用户输入，不由模型输出任意路径授予权限。
- 旧 Worker 不能消费需要项目绑定的新事件/Run；失败重试和审批继承执行快照，切换目录后不复用旧 session。

### 非目标与边界

不新增 LLM project_router，不自动按名称猜目录，不实现跨仓库规划或全局 worktree 策略，不把 PR 交付升级成发布。项目和普通目录都属于所选执行节点，文件系统检查在执行节点进行；控制端不扫描远端目录。项目根目录不原地更换；需要另一位置时登记另一项目位置。首版项目登记和任务绑定为显式用户操作，Agent 仍可根据用户/仓库要求使用自己的目录工具创建工作区。

### 失败、恢复与回滚

项目登记 ID 可重放，相同 ID 不同内容拒绝。任务绑定使用 revision 防止覆盖；忙碌任务拒绝切换。新 Run 不借用旧目录会话；已有 Run 的重试保持原快照。目录问题修复后可重试，或在任务空闲后显式改绑定。项目记录不删除任何用户文件。

schema v61 为纯增量；回滚前排空/停止项目或普通目录绑定任务、输入及 Run，新契约由数据库领取 fence 阻止旧 Worker 执行。不得通过降级契约继续执行项目任务。当前运行实例不在本次交付范围内。

## 实现与验证

### 使用入口

主对话输入框上方的「工作目录」可选择：默认工作区、普通文件夹、已登记项目或登记新项目。位置选择只是草稿，点击「应用目录」后才生效。选择项目/普通目录后发送的文本或语音会显式新建事情；进入已有事情则沿用其持久绑定。普通文件夹无需起项目名，资料与照片目录不会出现在项目列表里。

事情内的同一入口显示服务端绑定，可在空闲时更改项目或执行目录，也可恢复默认。指定用户已有 worktree 与指定普通目录采用同一机制，不创建目录、不切分支、不迁移文件。失败保留表单草稿。目录要求是执行电脑上的规范绝对路径，符号链接请显式选择其物理目标；失效路径在 Worker 启动模型前报错。

### 服务端合同

- `GET /v1/projects?userId=...`：列出当前用户项目。
- `POST /v1/projects`：`{id,userId,name,nodeId,directory}`。稳定 id 是重试键，同 id 不同参数拒绝；项目位置不可原地修改。
- `GET/PUT /v1/tasks/:taskId/project?userId=...`：绑定读取/修改。PUT 接受 `{projectId,workingDirectory?,nodeId?,expectedRevision}`；普通目录使用 `projectId:null` 和明确的 nodeId，全部清空恢复默认使用 `{projectId:null,expectedRevision}`。
- `POST /v1/events` 的 user.message payload 可带 `projectId`，或 `workspace:{directory,nodeId}`，二者互斥。与 taskId/reply 组合时必须匹配已有绑定，不能借消息偷偷换目录。
- Task 保存 project_id（可空）、working_directory、workspace_node_id、workspace_revision；Run 保存实际 workspace/nodeId、workspaceBinding.revision 和可选 project 身份。项目输入采用 inbox 契约 v5，绑定目录 Run 采用执行契约 v3；DSH 部分继续使用 v2 的完整模型/权限快照。
- 项目选择与目录选择均为已认证用户操作；普通 Router 不从文本生成目录访问授权。现有受控委派可以继承来源的已绑定目录，但不能扩大权限。
- 项目绑定的任务不走基于特殊 targetResource 的旧 SelfChange 自动构建/发布分支；是否创建 worktree 由实际 Agent 依据用户及目录规则决定。未绑定的旧 SELF-001 专用发布入口仍保留。

### 规则与恢复

不维护第二套 AGENTS 合并器。实际 DSH 使用所选 cwd 的原生规则加载器，包含适用的父级/嵌套规则；额外目录的授权不等于其文本自动成为全局规则。项目登记的名字也不会将另一目录的规则强行注入当前工作目录。真实 DSH 测试在本地模型桩收到请求时断言 AGENTS 正文存在，续跑再断言一次。

切换目录后由执行上下文比较阻止复用旧 session；没有切换的续跑保持会话兼容。已有 Run 重试仍按它的原始快照执行，不读取后来修改的目录设置。普通目录与项目都继续受现有凭证隔离和工具审批约束。绑定已存在目录不创建 worktree、不会给其他目录新增权限。

新旧版本混跑时，领取 fence 阻止旧 Worker 处理 inbox v5 / Run v3；数据库还拒绝旧代码给已绑定事情插入旧执行合同。Supervisor 在存在活跃目录任务、待处理 v5 输入或 v3 Run 时阻止回滚到 schema 61 以下。终态历史保留；回滚后不能继续项目绑定任务，需要恢复兼容版本，或提前显式清除可修改事情的绑定。

### 验证入口与限制

- `test/project-workspaces.test.ts`：项目/普通目录 API、身份隔离、幂等、节点定位、未绑定默认、忙碌/版本冲突、恢复、会话隔离、无效路径和回滚。
- `web/src/sealed/WorkspacePicker.test.tsx`：选择不自动提交、普通目录不创建项目、任务 revision、失败保留草稿。
- `scripts/smoke.mjs`：真实 Control Plane/Worker 进程处理项目与普通目录输入，核验 Run 契约和 cwd。
- `scripts/smoke-dsh-runtime.mjs`：真实 DSH、真实 read 工具和 session 恢复，本地模型桩检查 AGENTS 入模。
- `scripts/verify-workspace-picker.mjs`：桌面和 390px 视口实际表单、选择/恢复默认、临时选中任务再取消后目录显示一致与横向边界。

首版只有一个主执行目录；附加目录沿用现有工具权限流程。没有远端目录选择器、目录移动/项目删除和自动项目识别，也不实现 Agent 运行中迁移会话的 API。Agent 自行新建 worktree 后可以用工具选择命令目录；若希望后续整个会话迁移，用户在任务空闲时显式改执行目录。跨机器路径验证在 Worker 所在节点完成，本次自动化使用本地节点与非匹配节点的拒绝场景，没有实际远端主机端到端测试。
