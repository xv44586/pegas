# 结构化日志、指标与错误追踪

> Feature：`OBS-001`
>
> 状态：Usable
>
> 更新日期：2026-11-21

## 用户结果

运维者（单用户 MVP 中即用户本人）可以从各服务进程的 stdout 读到每行一个 JSON 对象的结构化日志，按 `service`/`event`/`level` 过滤定位问题；从 Control Plane `GET /metrics` 抓取 Prometheus 文本指标观察请求量、延迟分布、Run/事件/投递结果与错误计数；错误记录携带 durable 标识（runId/taskId/eventId/messageId）与序列化的 name/message/stack，可直接关联数据库事实。

## 合同

- **日志**（`src/observability/logger.ts`）：`{ts, level, service, event, message?, error?: {name, message, stack?}, fields?}`，每行一个 JSON。`PEGAS_LOG_LEVEL=debug|info|warn|error`（默认 info）。`message` 字段保留人类可读启动/停止文案；`child()` 绑定固定字段。已接线服务：control-plane、worker、scheduler、notification、supervisor（含 Recovery API）。
- **隐私边界**：用户消息正文、prompt、凭证不得进入日志字段；调用方只记录 durable 标识与结果。回归测试断言失败日志不包含用户输入文本。
- **指标**（`src/observability/metrics.ts`）：进程内 Prometheus 风格注册表，counter + histogram。`GET /metrics` 与主 API 同一 bearer 鉴权；未配置注册表时 404 `metrics_unavailable`。指标是进程本地运维遥测，重启清零，不是产品事实来源；durable 事实仍在 SQLite。
- **指标清单**：
  - `pegas_http_requests_total{method,route,status}`、`pegas_http_request_duration_seconds{method,route}`（route 归一化动态段为 `:id`，排除 /metrics、/healthz 与静态资源）；
  - `pegas_events_processed_total{outcome=processed|failed|parked|claim_lost}`；
  - `pegas_runs_total{outcome=completed|failed|steered}`、`pegas_run_duration_seconds{outcome}`；
  - `pegas_outbox_deliveries_total{outcome=sent|retry|unknown}`；
  - `pegas_automations_fired_total`；
  - `pegas_errors_total{component,kind}`：request_error、http_5xx、speech_provider、event_processing、event_lease_renew、run_execution、run_lease_renew、run_persistence、node_heartbeat、scheduler iteration、delivery_unknown。
- **错误追踪**：所有既有 `console.error` 运维路径改为结构化 error/warn 记录并同步 `pegas_errors_total`；Supervisor 回滚/重启/迁移审批缺失等生命线事件均有结构化记录（`release.rolling_back`、`release.rollback_blocked`、`release.migration_approval_missing` 等）。

## 主机级外部健康检查（独立 Watchdog）

`src/observability/external-healthcheck.ts` + `src/observability/healthcheck-main.ts` 提供独立于被监测 Pegas 进程的看门狗，可由 launchd/cron 或另一台主机运行：

- **配置**：`PEGAS_HEALTHCHECK_TARGETS=name=http://host:port/healthz,...`（必填，仅 http/https，名称唯一）；`PEGAS_HEALTHCHECK_INTERVAL_MS`（默认 30000）、`PEGAS_HEALTHCHECK_TIMEOUT_MS`（默认 5000）、`PEGAS_HEALTHCHECK_FAILURE_THRESHOLD`（默认连续 3 次失败判定掉线）；`PEGAS_HEALTHCHECK_ALERT_WEBHOOK_URL`/`PEGAS_HEALTHCHECK_ALERT_WEBHOOK_TOKEN` 配置告警 Webhook。非法配置启动即失败（fail closed）。
- **语义**：每个目标独立状态机；连续失败达到阈值发一次 `offline` 告警并保持 latch（持续掉线不重复告警），首次恢复发一次 `recovered`；再次掉线重新告警。HTTP 非预期状态、连接失败与超时都计为失败。
- **告警载荷**：`{type: healthcheck.alert, target, status: offline|recovered, consecutiveFailures, detail?, observedAt}`，POST JSON，带 `idempotency-key: healthcheck:<target>:<status>:<observedAt>` 与可选 bearer。告警传输失败只记结构化错误并保持 latch，不重试刷屏。
- **遥测**：`pegas_healthcheck_probes_total{target,outcome=up|down}`、`pegas_healthcheck_alerts_total{target,status,outcome=sent|failed}`；日志 `healthcheck.probe_failed/offline/recovered/alert_failed`。
- **边界**：Watchdog 只读健康端点，不写产品状态、不自动重启或回滚（Supervisor 职责）；被监测方全部宕机时仍可发出告警。
- **运行**：`pnpm dev:healthcheck` / `pnpm start:healthcheck`（构建后）；`pnpm smoke:healthcheck` 以真实进程验证 healthy→掉线（latch 单次 offline 告警）→恢复（单次 recovered 告警）→SIGTERM 停止。

## 交付可靠性对账（NOTIFY-006）

`src/observability/delivery-reconciliation.ts` + `src/observability/reconciliation-main.ts` 提供 Run 终态与用户可见通知之间的第二道安全网（第一道是 durable lease/retry 恢复链）：

- **欠账视图**：`store.listOwedDeliveries(userId?)` 列出终态 Run（completed/failed）中通知仍 pending/sending/failed/unknown（含 merged 到未 sent 消息）的清单；只有 sent 确认或人工 `resolveOutboxMessage` 清算欠账，投递失败 ≠ 结清。
- **四类 finding**（`store.listReconciliationFindings`）：`unreported`（终态超过阈值无 sent 确认，排除已被 retry/steering 后继接管的 Run）、`never_started`（开放 work Task 无 Run）、`stranded`（queued 超窗且匹配执行节点在线）、`stale_waiting`（审批已决/委派已结/用户输入已到但 waiting Run 未唤醒）。
- **边界（沿用 OBS-001 Watchdog 约束）**：只读，不写任何产品状态，不自动修复；finding 只产生 `pegas_reconciliation_findings_total{kind}`、`pegas_owed_deliveries` 指标与 `reconciliation.finding` 结构化日志（仅 durable 标识）。修复走既有 lease 过期、retry、人工核对路径。
- **运行**：独立进程 `pnpm dev:reconciliation` / `pnpm start:reconciliation`（Supervisor 自 2026-11-24 起随 Release 一并拉起）；`PEGAS_RECONCILE_INTERVAL_MS`（默认 60000）、`PEGAS_RECONCILE_UNREPORTED_AFTER_MS`/`NEVER_STARTED_AFTER_MS`/`STALE_WAITING_AFTER_MS`（默认 300000）、`PEGAS_RECONCILE_STRANDED_AFTER_MS`（默认 120000）；非法配置启动即失败。对账进程崩溃不影响主链路（独立 SQLite 连接，回归验证）。
- **API**：`GET /v1/reconciliation?userId=`（与主 API 同一 bearer 鉴权）返回 `{owed, findings}` 只读投影。
- **证据**：`test/delivery-reconciliation.test.ts` 14 个测试（四类 finding 故障注入、欠账清算语义、只读与崩溃隔离边界、配置 fail-closed、API 鉴权）。

## 未知写副作用自动对账（EXEC-003）

`src/observability/action-reconciliation.ts` 在同一对账进程内提供第二职责：主动探测 `unknown` 状态的文件写 Action 的外部事实，并通过既有人工核对同一事务链路结算（`system:auto-reconciliation` 身份）。它与上面的只读交付对账边界不同——**允许写**，但只写既有 append-only reconciliation 通道，从不重试副作用本身：

- **可探测范围**：`kind` 为 `dsh.tool.*`、tool ∈ {write, edit, apply_patch, bash}、category ∈ {out-of-workspace-write, workspace-write} 且 `request.targets` 为字符串数组（Delete 类补丁 targets 为空、由 `effect.absent` 承担）。全部目标存在（记录过指纹时还要求 sha256 一致：单目标 `request.effect.contentHash` 或逐目标 `request.effect.targets` 映射）且全部 `effect.absent` 目标确已消失 → `succeeded`；目标缺失、指纹不符或应删除的文件仍存在 → `failed`（绝不判成功）。bash 必须有逐目标指纹才探测（不做存在性判定）；无法静态推导指纹的增量写、非文件类或无 targets 且无 absent 的动作保持 `unknown` 留人工核对。
- **模型辅助对账（2026-11-24 第五环）**：无静态指纹的复杂 bash 写（管道/复合命令/替换/变量）不再一律留人工——`src/observability/model-reconciliation.ts` 以证据（任务目标 + 命令原文 + 逐目标现状：存在性/大小/修改时间/≤8KB 全文）调用配置的控制面模型做严格 JSON 判定（`succeeded`/`failed`/`inconclusive` + 中文理由），判定走同一 `system:auto-reconciliation` 结算事务，note 标注「模型判定（依据命令原文与目标现状，无静态指纹）」。fail closed：命令 >16384 字符、目标 >8KB/不可读/非普通文件、无 command/targets、模型失败/超时/输出形状不符/inconclusive 一律留 `unknown` 人工；模型绝不建议或触发重试，只判定。有指纹的 bash 仍走确定性探测，模型只补无指纹缺口；非文件类不判定。
- **指纹来源（2026-11-24 四环补齐）**：审批桥在 `tools/pre-execute` 经 `src/executor/write-effect.mjs` 推导预期落盘字节——`write` 直接哈希完整 `content`；`edit` 读原文件（LF 归一 + 行尾风格检测）按执行器同款字面替换语义（唯一命中或 replace_all）推导最终内容并还原行尾；`apply_patch` 以 Codex 风格 hunk 解析与 seek 语义重放**任意操作数**的补丁：Add/Update 推导逐目标最终字节，Delete 记 `effect.absent`（要求消失），Move 推导目标字节 + 源路径 absent，同一 canonical 路径被两个操作触碰时放弃；`bash` 仅**单条 echo/printf 字面参数 + 单个 `>`/`>>` 重定向**可推导（`>>` 读原文件拼接；拒绝管道/复合命令/替换/变量/通配符/多重定向//dev/ 目标/printf 格式符）。推导只读文件系统、10MB 上限、二进制/非 UTF-8/不唯一命中/hunk 不匹配一律放弃指纹（fail closed 退回存在性或人工）。人工审批与自动审阅放行两条路径都带。真实 DSH write/edit/bash append 落盘字节与推导一致由 `test/policy-gate-integration.test.ts` 探针断言。
- **结算幂等**：commandId `auto-reconcile:<actionId>`，复用 `reconcileAction` 事务（核对记录 + Action reconciled + Task 原因 + 唤醒 + `action.reconciled` Outbox，payload 带 `reconciledBy` 与自动核对文案）。核对记录带 `automatic=1` 标记（schema v44）。
- **观测**：`pegas_action_auto_reconciliations_total{resolution}` 指标与 `action.auto_reconciled` / `action.auto_reconcile_failed` 结构化日志（仅 durable 标识与探测结论）。
- **配置**：`PEGAS_AUTO_RECONCILE`（默认 enabled；`disabled` 关闭探测只保留只读交付对账；其他值启动即失败）；`PEGAS_MODEL_RECONCILE`（默认 enabled；`disabled` 关闭模型判定只保留静态探测；其他值启动即失败）。模型判定复用运行时设置的控制面模型连接（凭证经 vault 解密），privacyMode=mask 时经 PrivacyMaskingProvider 脱敏出边界。
- **回滚**：存在 `automatic=1` 核对记录时，Rollback Guard 拒绝回滚到 schema < 44 的 Release；人工核对记录不触发该 Guard（沿用 v23 语义）。
- **证据**：`test/action-auto-reconciliation.test.ts` 11 个测试（指纹命中/不符、逐目标哈希命中/不符、absent 全部消失/有残留、present+absent 组合、缺失判失败、Delete Action 自动结算、非文件类留人工、幂等重跑、Outbox、Guard 区分人工/自动）；推导单测 `test/write-effect-fingerprint.test.ts` 19 个（write/edit/CRLF/replace_all/patch Add/Update/EOF 锚定/多文件/Delete→absent/Move→目标+源 absent/同路径两操作拒绝/bash echo 覆写与 append/printf 转义/复杂 bash 七形式拒绝/相对路径）；桥采集回归 `test/policy-gate.test.ts`（edit、apply_patch、多文件/Delete/Move/bash park 路径精确值与 Gate targets 键一致性）与 `test/auto-review-bridge.test.ts`（审阅放行路径）；真实 DSH 四探针（write park/审阅 + edit 落盘一致 + bash append 落盘一致）。
- **模型判定证据（第五环）**：`test/action-model-reconciliation.test.ts` 6 个测试（严格判定 succeeded 结算+幂等、failed 结算+action_failed、inconclusive 留人工、模型失败/形状不符留人工、非 bash 写类别与非 bash 工具不判定且有指纹 write 仍走探测、无 judge 不判定）；`test/model-reconciliation-judge.test.ts` 5 个（policy+完整证据出参、形状不符降级 inconclusive、供应商失败上抛留人工、证据预算拒绝、严格 verdict 解析边界）。观测：`pegas_action_model_reconciliations_total{resolution}` 与 `action.model_reconcile_skipped/failed/inconclusive/malformed` 日志。

## 非目标

- 不做外部日志聚合/远端 error tracking（Sentry 等）、不做指标持久化与跨进程聚合、不做产品级告警规则；主机级外部健康检查见下文独立 Watchdog。
- 不改变任何产品语义：telemetry 参数全部可选，既有调用方与测试不受影响。
- backup CLI 与 desktop 主进程保留人类可读输出（面向终端用户，非服务遥测）。

## 失败与恢复

- 日志/指标路径不抛错、不阻塞请求或 Run；sink 默认写 stdout，进程管理器负责收集。
- 回滚代码即回到 console 输出；无 schema 变更、无数据迁移。

## 自动化证据

`test/observability.test.ts` 8 个测试：日志 JSON 形状/child 字段/级别过滤与默认、counter/histogram Prometheus 渲染与空注册表、`/metrics` 鉴权与请求计数/延迟/错误计数、动态路由归一化低基数、事件与 Run 结果计数、Run 失败错误记录（含用户文本排除断言）、Outbox unknown/sent 投递计数。

`test/external-healthcheck.test.ts` 7 个测试：阈值触发/latch/恢复/再次掉线的告警边沿与 probe/alert 指标、连接失败与超时判定、告警传输失败保持 latch、目标/阈值 fail-closed 校验、配置解析默认与非法拒绝、Webhook 告警载荷/idempotency-key/bearer 与非 2xx 拒绝。

## 从 Web 输入到浏览器结果的调用链

基线为 `41063c9`。从一条 Web 对话输入或事情详情打开同一服务端调用链。验收覆盖入队、归类输入与结构化结果、规则兜底、关联 Run 和重试、执行活动、审批、结果投影，以及浏览器首次渲染与进入视口的回执。旧记录仍可查询既有事实，缺失阶段明确标记。

通用运行日志仍按原合同。新增链路采集只保存有限字段和经脱敏的有界摘要，复用既有工具输出、审批、投影和身份校验。客户端回执仅是观测事实，不参与任务、权限、投递或读状态。接收失败可以重试，重复回执幂等。生产替换、外部日志服务、模型私有推理和供应商内部链路不在范围。新增表和索引是增量迁移，旧代码可忽略。

- `GET /v1/events/:id/trace?userId=` 以输入事件为入口，用现有 Inbox、Routing Decision、Run、Action、Policy Audit 和 Outbox 还原链路。响应禁止缓存。路由候选只保存 ID，模型输出只取结构化字段，预览每字段最多 2,000 字符。过长文本只显示长度。工具详情走已有 owner 授权档案和输出分页。
- `POST /v1/observability/browser-receipts` 校验事件或结果归属。发送用时按浏览器单调时钟计算，结果阶段记录服务端收到首次回执的时间。浏览器从 DOM 提交报告渲染，前台标签中与视口相交时报告进入视口。初次载入的历史结果保留原采集状态。回执不影响已读和交付状态。
- 本地验证运行 `pnpm check`、`pnpm smoke` 和构建后的 `node scripts/smoke-message-trace.mjs`。schema v57–v58 保留增量表和索引。回滚目标为上一版（支持 schema v56、Task workflow v1）。Supervisor 仍会执行回滚兼容性检查，数据库保留 v57–v58 的增量表和索引，v58 对旧模型摘要完成的脱敏继续生效。

### 审核修复验收

本轮以 `46c725f` 为基线。验证失败合批成员重试、排队补充与多次插话接续、常见凭证载体脱敏，以及超过旧缓存上限时已确认回执保持幂等。沿用既有 Task/Run、审批和浏览器权限边界。旧数据仅回填能够从持久事实确认的关系。

成功批次与归类或澄清同事务记录归属。失败或挂起的批次用当前有效领取记录诊断归属，独立重试成功后优先使用该消息自己的归类决定或澄清结果。排队补充和运行中插话的事件与受影响 Run 同事务写入。调用链沿纠正、重试和审批恢复关系追到后续 Run。迁移 v58 只回填仍有持久证据的旧插话关系。更早的排队纠正如果没有持久 Run 关联，只显示已有的消息和归类事实。

显式授权头、Cookie 和本地化凭证字段在写入诊断摘要之前遮盖。v58 在迁移事务中清理已保存的模型摘要。页面保留当前会话内的已确认回执，重复快照不重新发送。未确认的回执仍可随下一次观察重试。
