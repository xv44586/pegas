# Approval 与 Action 生命周期

APPROVAL-001 为高风险外部动作提供服务端权威的持久等待与恢复。Approval 不是聊天文案，也不代表动作已经成功；它是绑定 Task、原 Run 和 Action 的结构化控制对象。

## 边界

- Router 仍只负责输入所属 Task 和控制意图，不判断工具权限或风险。
- 实际 Executor 在看到真实工具、参数和权限后提出 Action，并生成 `summary`、`impact`、互斥选项和建议。
- 策略层对 `high`、`critical` Action 强制 Approval。`low`、`medium` 不允许伪装成 Approval；它们未来由 Action Policy 的自动授权路径承接。
- Web、macOS 和移动端只读取、显示和提交决定。Approval、Action、Decision、Inbox Event 和恢复 Run 的权威状态全部在 Control Plane。
- 批准表示授权 Executor 继续，不表示外部副作用完成。恢复后的 Executor 必须另行记录 `succeeded`、`failed` 或 `unknown` outcome。

## 状态与恢复

```text
Run(running) + high-risk Action
  └─ request Approval ─→ Run(waiting, no lease) + Approval(pending)
                              │
                              └─ Decision append + Inbox Event + atomic apply
                                      ├─ old Run(cancelled/superseded)
                                      ├─ Approval(resolved)
                                      ├─ successor Run(queued, resume session)
                                      └─ Inbox later consumed as idempotent audit/wakeup
                                                    │
                                                    └─ Action outcome
                                                       succeeded|failed|unknown
```

创建 Approval 时会在同一数据库事务中保存 Action request、恢复点、结构化 prompt、Outbox 通知，并清除原 Run 的 `claimed_by`、lease 与 claim hash。等待 Run 不会被普通执行领取，因此不会占用 Worker，也不会因为等待时间变长而被当作崩溃恢复。

用户决定作为 append-only `approval_decisions` 记录和 `approval.decided` Inbox Event 持久化。写入决定、关闭原 Run、创建 successor、更新 Task 和写入 Outbox 在同一个事务中完成；因此旧版 Worker 即使只消费事件也不会吞掉尚未应用的决定。新版事件处理器只接受能回查到该内部 decision 记录的事件，客户端直接向通用 Event API 写同名事件会被拒绝。唯一 decision、event、`retry_of_run_id` 与 `resume_run_id` 使事件重放只返回同一个 successor。

如果 Task 在提交 decision 前被用户停止，未决 Approval 变为 `cancelled`，Action 变为 `rejected`。已经授权但尚未记录 outcome 的 Action 会改为 `unknown`，并产生必须人工核对的 Outbox 通知。`unknown` 或尚未记录 outcome 的 `failed` 保留未结算的外部状态，普通 continuation 和 Task 完成仍被阻止；已记录 `failed` outcome 的例外及其他操作的保护见下文。

用户在 Action 未决期间发送的 continuation 不会恢复原 Executor，也不会因重试耗尽而丢失。Inbox Event 会以 `blocked_action` 关系持久停放；Approval 被拒绝/要求修改，或 Action 成功记录 outcome 后，Control Plane 会把原事件重新放回队列。批准后的 continuation 必须等待授权 successor 报告 outcome。Task 被停止时，仍停放的事件保留为明确失败记录。

## API

所有 Approval 用户 API 要求实例已配置 bearer，并接受有效 bearer 或同用户回环 Web 认证，同时以 `userId` 校验 Task owner；未配置实例 token 时这些端点 fail closed。Executor 写 API 不接受全局 bearer 代替 Run 身份，只接受短期 `x-pegas-run-claim-token`。服务端在解析业务 payload 前先验证 capability，因此错误 token 不会借由 400/403 差异探测 Action/Run 状态；已持久化命令的原 capability 仍可用于精确响应重放。

### 本机 Web 与桌面认证（2026-11-25）

- 验收：同系统用户在 macOS、Linux 直连本机回环 Web 时自动认证，桌面首次启动自动连接。跨源、带转发头、入口端口不匹配、其他系统用户与普通无凭证 API 请求仍需有效凭证。审批的 Task 所有权和 Run capability 守卫沿用原约束。
- Control Plane 从实际 TCP 连接验证请求为同用户的同源 Web 访问。macOS 使用系统 `lsof`，Linux 查询 `/proc/net/tcp*`。按连接缓存进程用户校验，并限制并发验证数。浏览器只发送请求类型标记，免凭证路径不返回 token 或 Cookie。页面禁止嵌入 iframe。私有证据和附件只内联预览允许的图片和视频类型，HTML、SVG 等原件走下载。指标、Supervisor Recovery 和 Executor 的专用身份校验沿用各自接口合同。
- 桌面端、Supervisor 和 Control Plane 复用 `ensureInstanceBearer`。实例 token 首次启动写入 `dataDir/api-token`（0600），启动进程通过环境变量传递。显式 `PEGAS_API_TOKEN` 优先。
- 非回环绑定、`PEGAS_LOCAL_WEB_ACCESS=manual`、系统无法确认对端身份、Vite 或其他代理入口回退到手动认证。同 UID 的透明 TCP 转发与直连使用相同的系统身份。通过此类代理对外提供服务前须显式配置 manual。当前范围不引入身份账户、模型密钥管理、实例 token 轮换或数据库迁移。回滚时保留 token 文件，旧 Web 恢复手动认证。

### 实例 bearer 引导修复 Intake（2026-11-24）

> Feature `APPROVAL-001`；worktree `pegas-worktrees/approval-001-token-bootstrap`（branch `fix/APPROVAL-001-token-bootstrap`，基线 origin/main `a294791`）。

**问题（P8 发布实拍发现）**：上述 fail-closed 是有意合同（不弱化），但只有桌面端实现了「未配置时生成随机实例 bearer」；Supervisor 拉起与裸 `node dist/control-plane/main.js` 启动在无 `PEGAS_API_TOKEN` 时不生成 token，导致 approvals/actions/policy-audit/worker-profile-changes 恒 401，Web 访问令牌门永远无法通过——运行实例（launchd）实际不可审批。根因是 bootstrap 缺口，不是守卫语义错误。

**用户结果**：任何本机启动路径（Supervisor/裸进程/桌面）在未显式配置 token 时都自动拥有随机实例 bearer；审批卡与 Web 令牌门恢复可用；已显式配置的 token 优先且不被覆盖。

**方案（对齐桌面既有模式）**：

1. 新增 `src/core/instance-token.ts`：`ensureInstanceBearer({ dataDir, environment })`——env 已有 `PEGAS_API_TOKEN` 直接沿用；否则读 `dataDir/api-token`（0600），不存在则 `randomBytes(32).base64url` 以 `wx` 模式创建（并发首启竞争时读回胜者），损坏/空文件视为缺失重建；返回值写回 `environment.PEGAS_API_TOKEN`。
2. `control-plane/main.ts` 在 `loadConfig()` 前调用（覆盖裸启动与一切 spawn 路径）；`supervisor/main.ts` 在读取 recoveryToken 前调用（recovery API 与子进程 env 同源受益）。桌面行为不变（其 env 注入优先）。
3. 守卫语义不改：无 token 配置时上述端点仍 fail closed（单测锁定）；非 loopback 无 token 拒启不变。

**验收条件**：

1. 回归先红：无 env token 时临时 dataDir 引导后 `loadConfig().apiToken` 非空、文件 0600、二次调用稳定复用、显式 env 优先、损坏文件重建。
2. 进程级：无 `PEGAS_API_TOKEN` 裸启动 control-plane，`/v1/approvals` 与 `/v1/tasks` 无凭证 401、带引导 token 200。Intake 核实修正：server 顶层本就有全局 bearer 守卫（无 token 时对非豁免请求放行），此前「tasks 200 vs approvals 401」的不一致来自该放行分支；引导后全 API 统一要求 bearer，回归锁定两个方向。
3. Supervisor 无 token 启动时 recovery API 与子进程使用同一引导 token（代码路径 + smoke 覆盖）。
4. `pnpm check` + `pnpm smoke` + `pnpm smoke:crash` 全绿；UI/a11y 采集脚本显式注入测试 token 并经 sessionStorage 提供给 Web（不依赖引导），真实浏览器门通过。
5. 运行实例修复后：真实浏览器输入引导 token 通过令牌门，P8 探针审批卡可见并可决定。

**非目标**：不改任何守卫的 fail-closed 语义；不做 token 轮换/多用户 token；不把 token 写入日志、prompt、Outbox；不改 Web 令牌门交互。

**数据与权限边界**：token 文件位于 dataDir（与 model-credentials.key 同级同权限 0600），只含随机 bearer；不入库、不入 git（data/ 已忽略）。

**失败与恢复**：文件不可写时启动失败并给出明确错误（不静默降级为无 token）；删除文件即下次启动重新生成（旧会话 token 失效属预期）；回滚 revert 即恢复旧行为，无 schema 变更。

### 实例 bearer 引导实现记录（2026-11-24）

- **实现**：`src/core/instance-token.ts` `ensureInstanceBearer`（env 显式 token 优先；`dataDir/api-token` 0600 持久化，`wx` 首建、EEXIST 读回胜者、空文件重建、非 0600 权限收紧、不可写抛错不降级）；`src/control-plane/main.ts` 与 `src/supervisor/main.ts` 在 `loadConfig()`/recoveryToken 读取前调用（Supervisor 子进程经 env 继承同一 token，recovery API 同源受益）；桌面既有随机 bearer 行为不变。守卫语义零改动。`.env.example` 说明留空自动生成与 Web 令牌门用法。
- **采集脚本适配**：`capture-ui-review.mjs`、`a11y-review.mjs`、`capture-dependency-canary.mjs` 显式注入测试 `PEGAS_API_TOKEN`，seed fetch 带 bearer，全部浏览器 context（含 UI review fixture harness）经 sessionStorage 提供 token——不依赖引导文件，采集合同不变。`smoke*.mjs` 本就显式配置 token，零改动。
- **证据（先红后绿）**：`test/instance-token.test.ts` 6 项——生成 0600 持久 bearer + loadConfig 贯通、重启复用、显式 env 优先不落盘、空文件重建 + 权限收紧、目录不可写抛错、真实裸进程回归（无 env token 启动 dist control-plane：approvals/tasks 无凭证 401、带引导 token 200）。`pnpm check` 134 文件 / 1378 测试全绿（statement 85.56% / line 88.65%；首轮 dsh SIGKILL 计时 flaky 隔离 32/32 复跑后全量绿）；`pnpm smoke`、`pnpm smoke:crash`、`pnpm smoke:desktop`、`pnpm review:ui --force`（首轮 fixture harness 因 App 在 unauthorized 时先于 harness 返回而超时，补 sessionStorage 注入后全量采集通过）、`pnpm a11y:review` 0 违例、`pnpm review:canary --force` 全部通过。
- **剩余风险**：token 文件被删除后旧 Web 会话需重新输入新 token（预期行为）；多实例共享同一 dataDir 时共用同一 bearer（与 SQLite 单写者模型一致）；token 不轮换（非目标）。
- **回滚**：revert 即恢复旧行为（无 token 部署审批端点恒 401）；`dataDir/api-token` 文件保留不删除，旧代码忽略；无 schema 变更。

### 实例 bearer 引导发布记录（2026-11-24）

- **合并**：PR #86 合入 main（merge `60ed412`，PR check 3m57s success；main CI run 45365641094 success）。
- **Candidate**：`main-60ed412-r1`（隔离 worktree exact commit 构建，compatibility 31–48；node_modules APFS clonefile 重锚定 1532 symlink 树内相对，manifest verify 通过）。Supervisor staging → stable，`/readyz` 报告新 Release；recovery restart 与主仓 ff + build + launchd kickstart 后 active 保持；previous=`main-3d36113-r1` 可回滚。
- **引导生效**：运行实例自动生成 `data/api-token`（0600，44 字节）；API 实测 approvals 无凭证 401、带引导 token 200（含 pending 探针审批）、tasks 带 token 200。**行为变化如实记录**：recovery API（4318）此前无 token 开放，现与实例 bearer 同源要求认证——发布/恢复脚本需带 `Authorization: Bearer $(cat data/api-token)`。
- **真实用户入口验证（LESSON-20261124-01 要求）**：真实浏览器打开运行实例 Web → 访问令牌门输入引导 token → 通过 → 待处理列表可见 → P8 探针审批卡完整渲染（对外网络发送·高风险、命令原文、发送内容预览 `{"live":"egress-probe-fact"}` 与文件逐字一致、状态等待决定）。审批决定留用户处置。
- **回滚**：Supervisor rollback 到 previous 可用（需带 bearer）；无 schema 变更。

Worker 只把当前 claim 的 Control Plane URL、Run/Task ID 和短期 claim token 注入当前 DSH 子进程；会先剥离父进程中可能残留的同名变量以及实例 bearer、恢复 token 和模型密钥。DSH 执行合同给出创建 Approval、等待恢复和记录 Action outcome 的协议。claim 轮换后，新 Run 只收到自己的 token；该 token 不进入 prompt、对话、Outbox 或持久化明文。macOS 桌面端每次内置服务启动会生成随机实例 bearer，由 Electron session 仅对可信本机 origin 自动附加；renderer 不读取或保存该 bearer。

Run capability 的 HTTP 传输固定使用 loopback。`PEGAS_API_HOST` 为 `0.0.0.0` 或 `::` 时，Worker 分别通过 `127.0.0.1` 或 `::1` 访问同一服务；绑定具体非回环 IP 时 Worker 拒绝启动 capability 通道，避免明文 claim 穿过局域网。需要远程 Control Plane 的后续部署必须另建 HTTPS/mTLS 内部通道，不能复用本协议的明文 URL。

- `POST /v1/runs/:runId/approvals`：当前 Run 提出高风险 Action 并释放 claim。
- `GET /v1/approvals?userId=&status=&limit=&cursor=`：按用户分页读取 Approval。
- `GET /v1/approvals/:approvalId?userId=`：读取单个 Approval。
- `POST /v1/approvals/:approvalId/decisions`：owner 提交一次结构化决定并写入 Inbox。
- `GET /v1/actions/:actionId?userId=`：owner 读取 Action 的授权与最终 outcome。
- `GET /v1/approval-rules?userId=`：读取该 owner 的授权管理列表，包含规则状态与最近命中时间；撤销仍走 `POST /v1/tasks/:taskId/approval-rules/:ruleId/revoke`，使用规则原属 Task 与幂等 commandId。
- `POST /v1/actions/:actionId/outcomes`：恢复后的 Run 用自己的 claim 记录 Action outcome。
- `POST /v1/actions/:actionId/reconcile`：owner 人工核对 `failed`/`unknown` outcome。请求体为 `{userId, commandId, resolution, note}`；`resolution` 只能是 `succeeded` 或 `failed`，`note` 必填且不超过 2000 字符。

### 人工核对（reconciliation）

已记录 `failed` outcome 的动作保留失败审计，但不阻塞新的用户输入及其 Run 领取；workflow 也不把这一已结算失败投影为「待核对」。路由、Worker claim 与状态投影必须使用相同判断，不能允许消息入队后又永久阻止领取。`unknown` 和未记录失败 outcome 的 `failed` 继续等待核对。新 Approval、原 Run retry、Goal revision 与协作仍遵循各自的严格保护，允许回答新的追问不表示允许重做外部副作用。

`unknown` 或尚未记录 outcome 的 `failed` 会阻塞 continuation；已记录的失败允许新追问，不等于授予新的外部操作权限。原授权 successor 在失败未核对时不能请求下一项 Approval，唯一例外是桥已明确记录 failed outcome 且 `notExecuted: true`，证明该调用尚未开始，可重新请求审批；缺失或非布尔 true 不构成此例外。新的 Run 请求新的 Approval 仍需走完整审批流程；人工确认失败则在整个 Task 范围阻止新 Approval。用户确实需要核对外部结果时，在外部系统核实后通过 reconcile API 提交一次性结论：

- 核对记录 append-only：`action_reconciliations` 保存 resolution、note、核对前的 status 与 result 快照、核对人和时间；数据库 trigger 拒绝改写或删除。每个 Action 只允许一条核对记录，重复提交返回 `409 action_reconciliation_conflict`。
- 相同 `commandId` 加相同 payload 幂等重放当前 Action 投影；不同 payload 复用 command 返回 409。不存在和跨 owner 一律 `404 not_found`。
- Action 状态变为 `reconciled`，`result` 保存 `{resolution, note, previousStatus, previousResult?}`；原始 outcome 在核对记录中保持可审计。
- `resolution=succeeded`：解除该 Action 的阻塞，唤醒停放的 continuation，Task 等待原因更新为 `action_reconciled`；failed Run 可以 retry；Review Pack 把该 side effect 视为已满足并附带核对信息。
- `resolution=failed`：外部失败成为人工确认的事实。Task 保持开放并显示 `action_failed`，停放的用户输入仍会唤醒，可在新 Run 中继续追问；retry、Goal revision、协作与新 Approval 仍被拒绝，确认失败不等于允许重做外部操作。Review Pack 不会把该 side effect 计为成功。
- Task 停止后仍允许核对已 `unknown` 的 Action（外部副作用审计不随 Task 结束消失），但不再改写 ended Task 的状态。
- 写入核对记录、Action 状态、Task 原因、唤醒事件与 `action.reconciled` Outbox 在同一事务提交。
- **自动核对（EXEC-003，2026-11-24）**：对账进程可对文件写类 `unknown` Action 主动探测外部事实并走同一事务结算，核对人为 `system:auto-reconciliation`，commandId `auto-reconcile:<actionId>` 幂等；Outbox payload 带 `reconciledBy` 与自动核对文案。目标缺失或内容指纹不符只会结算为 `failed`，绝不判成功；非文件类动作保持 `unknown` 留人工。无静态指纹的复杂 bash 写由模型辅助对账（第五环）：以命令原文 + 逐目标现状为证据做严格 JSON 判定，模型失败/证据不足/inconclusive 一律留人工，note 标注模型判定；`PEGAS_MODEL_RECONCILE=disabled` 可关。核对记录带 `automatic=1` 标记（schema v44），详见 `docs/observability.md`。桥在创建 Action 时推导预期落盘字节（人工审批与自动审阅放行都带）：`write` 记录完整内容 sha256（`request.effect.contentHash`）；`edit` 与单文件 `apply_patch` 增量在原文件上重放推导最终字节（edit 用 contentHash，patch 用逐目标 `effect.targets` 映射）；无法静态推导（多文件/Delete/Move 补丁、命中不唯一等）不记录指纹，fail closed。

创建 Action 的 `idempotencyKey`、决定的 `commandId` 和 outcome 的 `commandId` 都是幂等键。相同键和相同 payload 返回已有对象；相同键配不同 payload 会拒绝，不会悄悄覆盖审计事实。Run claim token 只保存 SHA-256 digest，不通过 API 或 Outbox 回显。

Capability 写入的首次 mutation 必须发生在 Run claim lease 内。成功提交后，服务端保存 capability digest 与 payload fingerprint；即使 lease 随后过期，完全相同的请求仍可只读重放首次创建时的不可变 pending 响应，不能创建、修改或读取后续决定、恢复 Run 与 Action outcome。错误 token 始终返回 `403 run_claim_invalid`。

### 请求与响应

创建 Approval：

```json
POST /v1/runs/{runId}/approvals
X-Pegas-Run-Claim-Token: <capability>

{
  "action": {
    "kind": "publish.release",
    "risk": "high",
    "idempotencyKey": "publish-v1",
    "request": { "release": "v1" },
    "recoveryPoint": { "step": "before_publish" },
    "approval": {
      "summary": "发布 v1",
      "impact": "所有用户将看到新版本",
      "recommendedOptionId": "approve",
      "options": [
        { "id": "approve", "label": "发布", "kind": "approve" },
        { "id": "reject", "label": "暂不发布", "kind": "reject" }
      ]
    }
  }
}
```

首次成功返回 `201 { action, approval }`；同 capability、幂等键和 payload 的重放返回同一对象。

自我修改发布使用同一契约：`SelfChangeExecutor` 创建 `kind: "self_change.publish"`、`risk: "high"` 的 Action（幂等键 `self-change:<taskId>:<head>`），批准后的后继 Run 经 Recovery API staging 并以 `POST /v1/actions/{actionId}/outcomes` 记录结果；staging 请求发出后失败记 `unknown` 并走对账路径。

提交决定：

```json
POST /v1/approvals/{approvalId}/decisions
Authorization: Bearer <instance-token>

{
  "userId": "owner",
  "commandId": "client-command-id",
  "optionId": "approve",
  "rationale": "确认回滚开关已开启"
}
```

服务端在返回前已原子创建 successor，响应为 `202 { approval, decision, event }`；`event` 仍作为 Inbox 审计与唤醒事实。相同决定即使命令 ID 因传输重试而变化，也返回已保存结果；不同选项会冲突失败。

记录 outcome：

```json
POST /v1/actions/{actionId}/outcomes
X-Pegas-Run-Claim-Token: <successor-capability>

{
  "commandId": "outcome-command-id",
  "status": "unknown",
  "result": { "reason": "提交后上游超时" }
}
```

首次成功返回 `201 { action }`。Approval 列表返回 `{ approvals, nextCursor? }`，`limit` 默认 50、最大 200；`status` 可为 `pending`、`decision_recorded`、`approved`、`rejected`、`revision_requested` 或 `cancelled`。

| 情况                          | HTTP | error                |
| ----------------------------- | ---- | -------------------- |
| 实例 bearer 缺失或错误        | 401  | `unauthorized`       |
| Run capability 缺失           | 403  | `run_claim_required` |
| Run capability 错误或已失效   | 403  | `run_claim_invalid`  |
| Approval 不属于该用户或不存在 | 404  | `not_found`（读取）  |
| payload、状态或幂等键冲突     | 400  | `bad_request`        |

## DSH 工具审批桥接

除执行合同中由 Executor 主动发起的 Approval 外，Worker 现在以 `--approval-policy ask` 运行 DSH，并通过 `--patch` 注入进程内桥接插件 `src/executor/dsh-approval-bridge.mjs`。桥接分两层：**Policy Gate**（`tools/pre-execute` waterfall，对每个工具调用先做确定性分级）与 **越权 seam**（`approval/request`，承接 DSH 沙箱升级请求，例如 bash/fs 的 `sandbox_permissions`）。

### Policy Gate（APPROVAL-001 P1）

分类器 `src/executor/policy-gate.mjs` 对每个调用按实际效果做确定性静态分类（不看工具名自述）：

| 类别                   | 判定                                                                               | 处置                                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| read                   | fs 读/搜索、web fetch/search 只读                                                  | allow，发 `policy_decision` 记录                                                                               |
| workspace-write        | 写路径 canonical（symlink/父目录解析后）在工作区内                                 | allow，发 `policy_decision` 记录                                                                               |
| out-of-workspace-write | 写路径越界（write/edit/apply_patch 全部目标路径；bash 重定向/写命令目标）          | ask，risk `high`                                                                                               |
| network-egress         | bash 命中外部发送模式（POST/上传/scp/rsync 等）                                    | ask，risk `high`                                                                                               |
| destructive-command    | bash 命中不可逆模式（区外递归删除、force push、DROP/TRUNCATE、mkfs/dd of=/dev 等） | ask，risk `critical`                                                                                           |
| control-plane-mutation | 写 Pegas 数据目录 / DSH home（含 bash 间接写与重定向）                             | **deny + 强制审批**，risk `critical`；同时经 `tools.guard()` 注册审批后仍生效的单调拒绝，任何 grant 都不能放行 |
| unknown                | 未知工具、缺路径、补丁不可解析、bash 间接执行（eval/管道 sh/解释器 -c 等）         | ask（fail closed to human）                                                                                    |

Gate 的边界事实来自 Executor 注入的 patch config `policy { workspaceRoot, protectedRoots }`：`workspaceRoot` 取 Run 的实际工作目录；`protectedRoots` 由 Worker 传 `dataDir`，Executor 追加受管 DSH home。缺少边界信息时写入类调用一律 ask。ask 经 DSH `approval/request` seam 进入下述同一停放/恢复/一次性放行链路；`policy_decision` 事件由 Executor 转为 Activity 进度（「安全检查通过 / 已拦截」）。静态分类只是审批路由，不是安全边界：真正的硬边界仍是 DSH sandbox 与 guard 底线。

### 权限档位现读（APPROVAL-001 P2）

桥在每次 `tools/pre-execute` 分级前，用 Run claim capability 现读 `GET /v1/runs/:runId/permissions`（3s 超时、无缓存），拿到「生效档位 + 代次指纹 + mismatch」。生效档位由服务端组合：全局默认（`runtime_settings.permission_tier`）→ Task 覆盖（`worker_profiles.permission_mode`）为 live 档位，Run 创建时冻结的 `executionContext.permissionTier` 为下界——运行中收紧立即生效；放宽被钳制在快照档位（`clamped: true`），要越过快照上限需新 Run。读取失败、代次错配或存量 Run 缺快照档位时按 `strict` 处置（fail closed），不静默放行。

档位映射：`strict`→read-only 沙箱且 write/edit/apply_patch/bash/web_fetch/web_search 全部 ask；`standard`→workspace-write 沙箱 + Gate 分级；`full`→danger-full-access 沙箱 + ask（Web 启用前强制风险确认）。control-plane-mutation 的 guard 硬拦在三档一致。切档走 `PUT /v1/tasks/:id/worker-profile`（`permissionMode` 字段，commandId+expectedRevision 幂等），权限变更写 append-only `worker_profile_changes` 审计并发 `task.permission_changed` 时间线事件；判定时的 tier/generation/mismatch 随 `policy_decision` 事件与 Action request 持久化。

### 规则批准（APPROVAL-001，含统一命令与目录授权）

`approve_rule` 将用户选择的范围、实际规则与决定同事务保存；规则为一等持久对象，撤销保留历史。普通文件写入可选择本事情或同用户长期目录授权；已适配的 `git fetch` 可选择准确参数或命令族，各有事情 / 长期期限，默认仍是仅本次批准。命令许可不按字符串前缀推断，外发、破坏性操作、控制面修改及未适配命令不因普通规则获得持久权限。具体适配、路径与配置边界见 [命令授权](command-authorization.md)。

桥的 pre-execute 与 approval/request 均重新读取本事情及同 owner 长期有效规则，并重新核验实际资源；strict 档与 mismatch 下不复用。事情规则在事情完成或停止时撤销，重开不复活；长期规则跨事情和重启保留。每次匹配通过 `policy_decision` 的 ruleId 写入独立逐调用审计，事情执行面板可查看授权依据；后续复用不逐次创建 Action/outcome，首次批准恢复的 Action 则必须结算真实 outcome。设置 → 隐私 → 授权管理或事情详情可撤销，尚未开始的下一次调用重新审批，进行中的进程沿用现有停止能力。

审批卡在 Web 待处理抽屉以结构化形态渲染（P4）：来源事情入口（打开对应事情抽屉）、操作预览（类别 + 风险白话、工具 + 生效档位、bash 命令等宽块、canonical 目标列表、档位错配提示）与「需要你决定」reason 行；桥的 Action request 携带命令原串（`command`）。`approval.required` 通知经 external 投递（webhook 等）时，payload 投影为指向 `/?view=outbox&outbox=<messageId>` 的 deepLink（复用既有收件箱恢复参数），其余通知类型 payload 不变。

### 自动审阅（APPROVAL-001 P5）

设置页隐私区「自动审阅」开关（默认关，`runtime_settings.auto_review_enabled`，schema v42）。开启后，桥对 ask 且 high 的调用（开关开、无档位错配、存在认证人类原话）先做一次模型审阅：`ctx.llm.stream` 按桥内自写 REVIEW_POLICY 判定（provider/model 取自 session requestHeader，temperature 0，20s 超时），授权来源只认服务端投影的认证人类 user.message 原话（30000 字符预算从最旧整条丢弃并标记 omitted，机器输入永不构成授权）。输出必须是严格 JSON：allow 仅 low/medium 两键，deny medium/high 可带 reason，其余形状、流异常、超时一律 failed。allow 时桥创建 Action/Approval 但不停放 Run，经 `POST /v1/actions/:id/review`（claim 鉴权、append-only `approval_reviews` 幂等记录）同事务把 Action 置 authorized、Approval 置 approved 并发时间线事件，工具就地执行并记 outcome；登记失败 fail-closed 不执行。deny/failed 降级人工 ask，审阅结论随停放落库并在审批卡显示（「自动审阅未放行：{reason}」）。critical、control-plane-mutation、unknown 不进入审阅；开关开启时 Supervisor 拒绝回滚到 <v42。

### 停放与恢复（seam 共用链路）

1. **停放**：插件用当前 Run 的 claim capability 调 `POST /v1/runs/:runId/approvals` 创建持久 Approval。Action `kind` 为 `dsh.tool.<tool>`，risk 由 Gate 分级写入（`high`/`critical`；seam 越权无 Gate 判定时按 `high`），`request` 保存 `tool`、`callId`、`reason`、`category`、`targets` 与 `argumentsHash`（工具参数的稳定序列化 SHA-256），幂等键为 `dsh-tool:<runId>:<callId>`。创建成功后向 headless JSON 流写入 `approval_pending` 事件并对本次调用返回 `rejected`；Executor 识别该事件后按持久等待结算 Run（服务端已把 Run 置为 `waiting` 并清除 lease），不再提交 Report。创建失败时写入 `approval_bridge_error` 事件，Executor 将其作为执行失败处理，不放行工具。
2. **恢复**：用户以 `approve` 或 `approve_rule` 批准后，successor Run 的输入是结构化 `approval.decision` 上下文。Worker 解析出 `actionId`，回查服务端 Action 确认 `status='authorized'` 且 `resumeRunId` 等于当前 Run，才构造一次性 `toolApprovalGrant {actionId, tool, argumentsHash}`；存在命令 selector 或所绑定规则时一并传入，持久决定标记必须复核规则。规则去重也保留该决定到实际规则的绑定。
3. **一次性放行**：插件记录每个 `callId` 的工具名与参数哈希；只有 `tool`、`argumentsHash` 及适用的规则、命令上下文复核通过时才放行并登记 outcome 追踪，seam 同样重新核验，每个 DSH 进程只消费一次。首次 grant 的规则检查只针对它绑定的 Action，不阻断后续独立授权的调用。复核确认尚未执行即失效时记录 `failed` 与 `notExecuted: true` 后重新审批；一般执行失败或未知结果沿用原核对保护。control-plane-mutation 类别永不接受 grant 豁免。
4. **记录结果**：被放行调用结束后，插件在 `tools/post-execute` 用 successor 的 claim 调 `POST /v1/actions/:actionId/outcomes`（`commandId` 为 `dsh-tool-outcome:<actionId>`）：工具报错或 post-execute 被 block 记 `failed`，否则记 `succeeded`。outcome 上报失败会发出 `approval_bridge_error` 事件并使该 Run 失败，Action 由既有 lease/完成 fence 转为 `unknown` 进入人工核对，不会静默丢失。

claim token 只经进程环境传给 DSH 主进程，DSH 自身的 subprocess 环境清洗会剥离 `*TOKEN*` 与 `DSH_*` 变量，因此不会进入 bash 等工具子进程。`PEGAS_TOOL_APPROVAL_GRANT` 与 `PEGAS_APPROVAL_BRIDGE` 也在 Worker 的父进程环境剥离清单内，防止残留串扰。

桥接的已知边界：

- Policy Gate 覆盖全部工具调用，但 bash 只做确定性静态分类：重定向与写命令（rm/mv/cp/tee/touch 等）目标经 canonical 判定——区外 ask（out-of-workspace-write）、区内 allow（workspace-write，沙箱边界兜底）；未命中任何写/发送/不可逆模式的命令按低风险交由沙箱边界执行，间接执行按 unknown 强制人工确认；桥对「allow 但类别非 read/workspace-write」的判定一律升为 unknown ask（fail closed，不留静默放行面）；execpolicy 级完整命令语义解析属后续阶段。
- Gate 的每次判定（allow/ask/deny）自 2026-11-24 起落 append-only `policy_call_audit` 独立审计表（含档位代次、规则引用、审阅结论与 Action 引用，`GET /v1/policy-audit` 可查），Activity 进度流只做白话展示；切档动作本身另有 append-only 审计。
- 档位对象与运行中热切换已落地（P2），持久规则批准（approve_rule）已落地（P3），审批卡结构化渲染与通知深链已落地（P4），模型自动审阅（默认关、失败降级人工）已落地（P5）。
- 桥现读档位是每工具调用一次本地 HTTP 往返；控制面不可达时该 Run 的工具全部按 strict 升审批，不会静默放行。
- 同一 DSH 进程只停放第一个越权调用；并行的其余审批请求 fall through 到 DSH 默认 `unavailable`，fail closed。
- 批准后恢复的是同一 DSH session，但模型需要重新发起同参数调用才能命中一次性 grant；grant 不预执行任何工具。
- 拒绝或要求修改时不注入 grant，Action 走既有 `rejected`/修订路径。
- 停放的 DSH 进程在 turn 结束后仍有最长约 5 秒的 bounded dispose 窗口，期间持有 session 内核写锁。successor 恢复同一 session 时若遇到 `already owned by an active write handle`，Executor 在有限窗口内有界重试（默认 20s，`PEGAS_DSH_SESSION_BUSY_WAIT_MS`/`PEGAS_DSH_SESSION_BUSY_RETRY_MS` 可调，abort 立即停止）；超时仍按执行失败结算，绝不绕过写锁或强杀持锁进程。

## 当前限制

持久对象、策略边界、API、Web 决策、恢复协议与人工核对闭环已可用；Policy Gate 覆盖全部工具调用并做确定性 risk 分级（P1），权限档位（全局默认 + 事情覆盖 + Run 快照下界 + 运行中热切换）已落地（P2），本事情内同类规则批准与撤销已落地（P3），审批卡结构化渲染与通知深链已落地（P4），模型自动审阅已落地（P5，默认关闭），逐调用独立审计表（P6）与档位审计列表 UI（P7）已落地（2026-11-24）。文件写类 unknown Action 的自动对账已由 EXEC-003 落地（2026-11-24，`system:auto-reconciliation` 探测结算；同日桥四环补齐 write/edit/apply_patch（含多文件/Delete/Move）与简单 bash echo/printf 重定向的最终字节指纹与 absent 判定，按 sha256 判定；Gate 同步把 bash 区外写纳入 out-of-workspace-write ask；第五环为无指纹复杂 bash 写增加模型辅助对账，证据不足/模型失败仍留人工）；仍标记为 `Partial`：非文件类副作用无探测面仍留人工，模型判定存在语义误判风险（保守方向：inconclusive 留人工，绝不猜测成功）。组织级 RBAC、多人会签、超时策略与可配置风险阈值同样不在当前范围内。

## 回滚

schema v23 只新增 `action_reconciliations` 表与 trigger。存在 `status='reconciled'` 的 Action 时，回滚到不支持 v23 的 Release 会被 Rollback Guard 以 `rollback_incompatible` 拒绝：旧版本不认识该状态，会把人工确认过的外部事实误判为仍在等待或允许绕过。未核对的 `failed`/`unknown` Action 在旧版本中仍被原有 fence 阻塞，可以安全回滚。

schema v44 为 `action_reconciliations` 追加 `automatic` 标记列（默认 0，人工核对不受影响）。存在 `automatic=1` 的自动核对记录时，回滚到 schema < 44 的 Release 被拒绝：旧版本没有探测语义，会把系统结算的事实误当作人工确认。仅有 v44 列而全部为人工核对时可安全回滚（v23 Guard 仍按 reconciled 状态独立生效）。

schema v60 为规则添加 kind、lifetime、command selector 与不可变决定绑定，并回填已结束事情的旧规则失效状态。存在带 commandSelector 且仍 awaiting_approval、authorized 或 unknown 的 Action 时，Supervisor 拒绝回滚到 schema < 60；旧版不复用新命令规则并恢复询问。既有 v41 等 Guard 继续独立生效，规则与审计数据不得删除；完整兼容范围见 [命令授权](command-authorization.md#数据与回滚)。
