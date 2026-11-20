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

## 当前限制

第一版已经提供持久对象、策略边界、API、Web 决策与恢复协议，但仍标记为 `Partial`：DSH 的通用 tool-call 代理尚未把所有真实工具自动接入 Action Policy；当前只有接入本协议的 Executor/工具适配器会被强制拦截。组织级 RBAC、多人会签、超时策略、可配置风险阈值和 unknown outcome 对账属于后续 Feature。
