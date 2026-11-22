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

如果 Task 在提交 decision 前被用户停止，未决 Approval 变为 `cancelled`，Action 变为 `rejected`。已经授权但尚未记录 outcome 的 Action 会改为 `unknown`，并产生必须人工核对的 Outbox 通知。`failed` 或 `unknown` outcome 明确保留外部状态，系统不得通过普通 continuation、Run retry 或 Goal revision 绕过它，也不能完成 Task。

用户在 Action 未决期间发送的 continuation 不会恢复原 Executor，也不会因重试耗尽而丢失。Inbox Event 会以 `blocked_action` 关系持久停放；Approval 被拒绝/要求修改，或 Action 成功记录 outcome 后，Control Plane 会把原事件重新放回队列。批准后的 continuation 必须等待授权 successor 报告 outcome。Task 被停止时，仍停放的事件保留为明确失败记录。

## API

所有 Approval 用户 API 强制使用已配置的实例 bearer（即使服务只监听 loopback），并以 `userId` 校验 Task owner；未配置实例 token 时这些端点 fail closed。Executor 写 API 不接受全局 bearer 代替 Run 身份，只接受短期 `x-pegas-run-claim-token`。服务端在解析业务 payload 前先验证 capability，因此错误 token 不会借由 400/403 差异探测 Action/Run 状态；已持久化命令的原 capability 仍可用于精确响应重放。

Worker 只把当前 claim 的 Control Plane URL、Run/Task ID 和短期 claim token 注入当前 DSH 子进程；会先剥离父进程中可能残留的同名变量以及实例 bearer、恢复 token 和模型密钥。DSH 执行合同给出创建 Approval、等待恢复和记录 Action outcome 的协议。claim 轮换后，新 Run 只收到自己的 token；该 token 不进入 prompt、对话、Outbox 或持久化明文。macOS 桌面端每次内置服务启动会生成随机实例 bearer，由 Electron session 仅对可信本机 origin 自动附加；renderer 不读取或保存该 bearer。

Run capability 的 HTTP 传输固定使用 loopback。`PEGAS_API_HOST` 为 `0.0.0.0` 或 `::` 时，Worker 分别通过 `127.0.0.1` 或 `::1` 访问同一服务；绑定具体非回环 IP 时 Worker 拒绝启动 capability 通道，避免明文 claim 穿过局域网。需要远程 Control Plane 的后续部署必须另建 HTTPS/mTLS 内部通道，不能复用本协议的明文 URL。

- `POST /v1/runs/:runId/approvals`：当前 Run 提出高风险 Action 并释放 claim。
- `GET /v1/approvals?userId=&status=&limit=&cursor=`：按用户分页读取 Approval。
- `GET /v1/approvals/:approvalId?userId=`：读取单个 Approval。
- `POST /v1/approvals/:approvalId/decisions`：owner 提交一次结构化决定并写入 Inbox。
- `GET /v1/actions/:actionId?userId=`：owner 读取 Action 的授权与最终 outcome。
- `POST /v1/actions/:actionId/outcomes`：恢复后的 Run 用自己的 claim 记录 Action outcome。
- `POST /v1/actions/:actionId/reconcile`：owner 人工核对 `failed`/`unknown` outcome。请求体为 `{userId, commandId, resolution, note}`；`resolution` 只能是 `succeeded` 或 `failed`，`note` 必填且不超过 2000 字符。

### 人工核对（reconciliation）

`failed` 或 `unknown` outcome 会阻塞 continuation、retry、Goal revision、协作与新 Approval。用户在外部系统核实真实结果后，通过 reconcile API 提交一次性结论：

- 核对记录 append-only：`action_reconciliations` 保存 resolution、note、核对前的 status 与 result 快照、核对人和时间；数据库 trigger 拒绝改写或删除。每个 Action 只允许一条核对记录，重复提交返回 `409 action_reconciliation_conflict`。
- 相同 `commandId` 加相同 payload 幂等重放当前 Action 投影；不同 payload 复用 command 返回 409。不存在和跨 owner 一律 `404 not_found`。
- Action 状态变为 `reconciled`，`result` 保存 `{resolution, note, previousStatus, previousResult?}`；原始 outcome 在核对记录中保持可审计。
- `resolution=succeeded`：解除该 Action 的阻塞，唤醒停放的 continuation，Task 等待原因更新为 `action_reconciled`；failed Run 可以 retry；Review Pack 把该 side effect 视为已满足并附带核对信息。
- `resolution=failed`：外部失败成为人工确认的事实。Task 保持开放并显示 `action_failed`，但 retry、Goal revision、协作与新 Approval 仍被拒绝——确认失败不等于问题已解决，后续处理需要用户显式停止或新的产品级恢复路径。Review Pack 不会把该 side effect 计为成功。
- Task 停止后仍允许核对已 `unknown` 的 Action（外部副作用审计不随 Task 结束消失），但不再改写 ended Task 的状态。
- 写入核对记录、Action 状态、Task 原因、唤醒事件与 `action.reconciled` Outbox 在同一事务提交。

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

除执行合同中由 Executor 主动发起的 Approval 外，Worker 现在以 `--approval-policy ask` 运行 DSH，并通过 `--patch` 注入进程内桥接插件 `src/executor/dsh-approval-bridge.mjs`。插件挂接 DSH 的 `approval/request` seam：工具在沙箱内被直接允许的调用不经审批；一旦工具请求越权（例如 bash/fs 的 `sandbox_permissions` 升级），DSH 会发起审批请求，由桥接插件接管：

1. **停放**：插件用当前 Run 的 claim capability 调 `POST /v1/runs/:runId/approvals` 创建持久 Approval。Action `kind` 为 `dsh.tool.<tool>`、risk 固定 `high`，`request` 保存 `tool`、`callId`、`reason` 与 `argumentsHash`（工具参数的稳定序列化 SHA-256），幂等键为 `dsh-tool:<runId>:<callId>`。创建成功后向 headless JSON 流写入 `approval_pending` 事件并对本次调用返回 `rejected`；Executor 识别该事件后按持久等待结算 Run（服务端已把 Run 置为 `waiting` 并清除 lease），不再提交 Report。创建失败时写入 `approval_bridge_error` 事件，Executor 将其作为执行失败处理，不放行工具。
2. **恢复**：用户批准后，successor Run 的输入是结构化 `approval.decision` 上下文。Worker 解析出 `actionId`，回查服务端 Action 确认 `status='authorized'` 且 `resumeRunId` 等于当前 Run，才构造一次性 `toolApprovalGrant {actionId, tool, argumentsHash}` 传给 Executor，并随桥接 patch 注入 DSH。
3. **一次性放行**：插件在 `tools/pre-execute` 记录每个 `callId` 的工具名与参数哈希；`approval/request` 到达时只有 `tool` 与 `argumentsHash` 都与 grant 完全一致才返回 `allowed-once`，且每个 DSH 进程只消费一次。模型改写参数后重试不会命中 grant，会重新走停放流程。
4. **记录结果**：被放行调用结束后，插件在 `tools/post-execute` 用 successor 的 claim 调 `POST /v1/actions/:actionId/outcomes`（`commandId` 为 `dsh-tool-outcome:<actionId>`）：工具报错或 post-execute 被 block 记 `failed`，否则记 `succeeded`。outcome 上报失败会发出 `approval_bridge_error` 事件并使该 Run 失败，Action 由既有 lease/完成 fence 转为 `unknown` 进入人工核对，不会静默丢失。

claim token 只经进程环境传给 DSH 主进程，DSH 自身的 subprocess 环境清洗会剥离 `*TOKEN*` 与 `DSH_*` 变量，因此不会进入 bash 等工具子进程。`PEGAS_TOOL_APPROVAL_GRANT` 与 `PEGAS_APPROVAL_BRIDGE` 也在 Worker 的父进程环境剥离清单内，防止残留串扰。

桥接的已知边界：

- 只覆盖走 DSH `approval/request` seam 的调用（沙箱越权类）；沙箱内直接允许的工具与未接入该 seam 的工具不产生 Approval。
- 同一 DSH 进程只停放第一个越权调用；并行的其余审批请求 fall through 到 DSH 默认 `unavailable`，fail closed。
- 批准后恢复的是同一 DSH session，但模型需要重新发起同参数调用才能命中一次性 grant；grant 不预执行任何工具。
- 拒绝或要求修改时不注入 grant，Action 走既有 `rejected`/修订路径。

## 当前限制

持久对象、策略边界、API、Web 决策、恢复协议与人工核对闭环已可用，DSH 沙箱越权类工具调用已经由桥接插件自动接入 Action/Approval。仍标记为 `Partial`：沙箱内直接允许的工具调用不经过 Action Policy，自动 risk 分级（当前桥接一律 `high`）与由验证器主动探测外部状态的自动对账属于后续 Feature。组织级 RBAC、多人会签、超时策略与可配置风险阈值同样不在当前范围内。

## 回滚

schema v23 只新增 `action_reconciliations` 表与 trigger。存在 `status='reconciled'` 的 Action 时，回滚到不支持 v23 的 Release 会被 Rollback Guard 以 `rollback_incompatible` 拒绝：旧版本不认识该状态，会把人工确认过的外部事实误判为仍在等待或允许绕过。未核对的 `failed`/`unknown` Action 在旧版本中仍被原有 fence 阻塞，可以安全回滚。
