# Pegas Engineering TODO

> 状态：Living Document
>
> 更新日期：2026-11-24

这里记录值得逐步采用、但尚未被 Pegas 自身事故证明为强制标准的工程规则。它们不是完成声明；开始实现时必须回到 Feature Intake，确认归属、验收条件和隔离 worktree。

## P0：近期安排

| 规则                                                                 | 归属           | 采用触发点                | 预期验证                                            |
| -------------------------------------------------------------------- | -------------- | ------------------------- | --------------------------------------------------- |
| 每个 Candidate 的证据绑定精确 Git SHA、产物校验值和已完成 CI run     | `SELF-001`     | SelfChange / Release 实现 | manifest 校验拒绝 SHA 不一致、失败或取消的检查      |
| lease、重试和超时统一使用可注入 Clock，测试不依赖短 sleep            | `EXEC-003`     | Worker 恢复加固           | 到期前、到期点、到期后均为确定性测试                |
| Supervisor 状态读取失败建模为 unknown/degraded，保留 last-known-good | `RECOVERY-001` | Recovery Plane 加固       | 截断、损坏、旧版本和写入中断故障测试                |
| 所有模型出口和安全豁免有结构化清单与旁路 Guard Test                  | `PRIVACY-001`  | 隐私网关实现前            | Router、DSH、tool arguments、嵌套字段和流式边界测试 |

## P1：相关 Feature 开始时采用

| 规则                                                                                                                                                       | 归属 / 触发点                                | 预期验证                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------- |
| Bug fixture 使用报告者的原始 bytes、渠道和环境，验收用户结果而不是中间步骤                                                                                 | 所有 Bug                                     | 回归测试在旧实现上稳定失败                                                      |
| 修复前搜索所有 sibling；暂不修的 sibling 同步建 Issue                                                                                                      | 所有 Bug                                     | PR 列出搜索范围和未覆盖项                                                       |
| 默认值不覆盖用户显式设置；用户可编辑副本测试“编辑后再同步”                                                                                                 | 配置、Memory、DSH profile                    | round-trip 与升级测试                                                           |
| 只对新数据生效的修复必须提供旧数据迁移或兼容说明                                                                                                           | schema / 持久化变更                          | 旧版本 fixture 升级测试                                                         |
| 新 route 声明认证、body 上限、幂等性和副作用等级                                                                                                           | Control Plane 扩展                           | route inventory Guard Test                                                      |
| Provider 拒绝先区分账号、模型、请求内容和 endpoint，再决定重试或熔断                                                                                       | Model / ASR provider                         | 分类错误与第二账号/模型对照测试                                                 |
| 高频路径按最大输入和真实调用频率做性能预算                                                                                                                 | polling、stream、恢复扫描                    | 基线与上界测试                                                                  |
| 外部副作用调用前先持久化 effect intent；恢复按三态处理：已提交且身份匹配只补 checkpoint、不存在执行同一 intent、unknown 一律 hold 后续 effect 并转人工核对 | `APPROVAL-001` 自动对账 / DSH tool-call 代理 | 丢失响应不重放副作用、unknown 不自动放行、同一 intent 幂等重放与身份 fence 回归 |
| 完成事实要求验证、持久写回、用量记账三段 receipt 在同一 effect 身份下全部 committed；缺失或矛盾一律拒绝而非推断                                            | `GOAL-001` 完成门禁加固                      | 三段中任意一步崩溃后的确定性恢复回归、缺失/矛盾 receipt 拒绝、不重复记账        |

上表末两条为外部调研候选（LoopX，2026-11-22），设计参考见本地研究笔记 `research/loopx/LOOPX-ANALYSIS.md`；采用前需按 Pegas 自身合同重新设计并以自有测试验证，不直接复制第三方实现。

## Feature 待办：OpenDuet 调研提炼候选（2026-11-24）

来源为本地研究笔记 `research/openduet/notes.md`（OpenDuet @ b32ec10，MIT © CopilotKit，获取 2026-11-24，未实际运行）。以下候选已逐条对照 Pegas 代码核实缺口后，以 Pegas 自有语言登记；开始实现时回到各自 Feature Intake，另建隔离 worktree。以下方向经对照已覆盖或更强，不登记：路由失败兜底（`src/router/router.ts` fallback 不 throw 必落默认）、auto-review fail-closed、只读最小工具面（`src/executor/dsh-readonly-surface.mjs` 三层强制）、结构化任务投影、单写者 lease 队列（SQLite `BEGIN IMMEDIATE`）、Lesson 晋升机制、自托管权威态。明确不采纳（与长期约束冲突或语义不同）：reaches 作为路由 hint（违反「Router 不判断 Executor 工具能力」）、fail-open 工具收窄（Pegas 只读面 fail-closed 且边界在沙箱+guard）、云端会话/记忆权威态。

| 待办                                                                      | 归属                         | 说明与验收                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 「我自己来（handled）」第四种审批决策                                     | `APPROVAL-001`               | 现决策枚举仅 approve/approve_rule/reject/revise（`src/approval/approval.ts`），用户自行完成动作只能按「拒绝」记录，语义错位；新增 handled 终态：不代执行、不产生拒绝语义、时间线与审计如实记录，回归覆盖幂等与恢复                                                               |
| 同 Task 已拒等价动作不再重复询问                                          | `APPROVAL-001`               | 拒绝后模型重试等价动作会再次弹审批（现仅 approve_rule 有正向指纹匹配）；以既有 argumentsHash/规则指纹机制推导拒绝指纹，同 Task 等价请求直接拒并引用原决策；跨 Task 不误伤、指纹碰撞回归                                                                                          |
| ~~对外副作用不可被规则永久放行且展示服务端事实预览~~（已完成 2026-11-24） | `APPROVAL-001`               | P8 落地：Intake 核实规则放行原为潜在缺口（egress targets 恒空），真实缺口是自动审阅可放行外发与载荷不可见；egress 三层拒绝持久规则、排除自动审阅，审批卡新增服务端事实载荷预览，见 `docs/approval-policy-gate.md` P8 实现记录                                                    |
| 安全语义分类强制转人工                                                    | `APPROVAL-001`               | policy-gate 为工具静态分类，无 credentials/payments/security_settings 语义类别；候选：此类语义动作不进自动审阅 allow 路径，一律人工确认；分类失败 fail-closed 按最高敏处理；对抗样本回归                                                                                         |
| 审计 initiator 维度与「无人监督」过滤                                     | `OBS-001` / `APPROVAL-001`   | `policy_call_audit` 无 initiator_kind；`inbox_events.source` 与 `system:auto-reconciliation` 身份未贯通到审计行；候选：审计行区分 person/schedule/collaboration/system 发起者与 actor，提供「我不在时以我名义执行了什么」过滤；发起者标签由服务端事实来源写入，Executor 不可自报 |
| 判据回归 eval 集（带对抗样本）                                            | `ROUTE-005` / `APPROVAL-001` | 真实模型规则/clarify 遵守度与自动审阅误判无系统评测（feature map 已登记同类缺口）；候选：虚构标注集含对抗样本（看着急的营销、说不急的真请求、机器输入伪装授权），作为回归检查而非准确率证明，诚实声明集小自标注                                                                  |
| 自动化运行诚实上报「检查不了什么」                                        | `EXEC-003` / `SCHEDULE-001`  | 自动化/对账运行的结果投影应包含未能检查/未能完成的范围（could-not-check），由代码生成而非模型自述，模型无法粉饰；先确认与 EXEC-003 reconciliation 投影的重叠再定增量                                                                                                             |

## P2：发布与平台成熟后采用

| 规则                                                            | 触发点                  | 预期验证                                    |
| --------------------------------------------------------------- | ----------------------- | ------------------------------------------- |
| Node 22/24 和 macOS 的进程、signal、路径、SQLite 门禁           | 开始支持长期 Mac 节点   | 跨版本/平台 CI matrix                       |
| hermetic smoke 与真实 DSH Candidate canary 分层                 | SelfChange 可运行       | fake child 故障测试 + 隔离真实 session 恢复 |
| 取消的 CI 不算证据，Release 等待目标 workflow 在准确 SHA 上完成 | 自动发布上线            | release gate 集成测试                       |
| 真实外部服务变更在受控 sandbox 做一次不可逆路径演练             | 新 provider / migration | canary 记录与回滚演练                       |

## Feature 待办：DESIGN-002 待处理收件箱后续（2026-11-22）

本轮收件箱 refinement 已合并的边界之外的缺口，开始实现时回到各自 Feature Intake，另建隔离 worktree：

| 待办                                              | 归属           | 说明与验收                                                                                                                                                                                                                    |
| ------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 待处理服务端全文搜索                              | `NOTIFY-003`   | 当前 Web 搜索只过滤已加载快照；需服务端查询合同 + owner 隔离与上限回归                                                                                                                                                        |
| 待处理游标分页 / 虚拟列表                         | `NOTIFY-003`   | 大量消息时保持稳定游标续页与滚动位置；分页合同、去重与恢复回归                                                                                                                                                                |
| 待处理批量处理与通知优先级                        | `NOTIFY-003`   | 需服务端幂等批量合同与优先级事实来源，不得由 Web 从自由文本推断                                                                                                                                                               |
| 待处理页 VoiceOver / NVDA 实机验证                | `DESIGN-002`   | axe 已 0 违例；补真实读屏的列表导航、操作名称与焦点恢复记录                                                                                                                                                                   |
| 桌面服务改由 Supervisor 统一守护                  | `DESKTOP-001`  | Electron 只 spawn Supervisor，业务进程健康门禁/备份/切换/回滚复用 SELF-001；先决策窗口关闭后是否常驻（launchd LoginItem vs App 生命周期）；同一数据目录单实例互斥；见 Feature Map「Supervisor 接管桌面服务与常驻守护 Intake」 |
| 临时 launchd 托管的退役                           | `DESKTOP-001`  | 本机 `com.pegas.supervisor.plist` 是 Intake 期临时措施；桌面端接管后移除，避免双重守护                                                                                                                                        |
| Web bundle 超过 500 kB 的分包评估                 | `DESIGN-002`   | Vite 构建提示主 chunk 587 kB；评估路由级 code splitting 与加载预算                                                                                                                                                            |
| Approval 决定保存回执的低概率竞态                 | `DESIGN-002`   | 2026-11-22 全量 coverage 下偶发一次「决定已保存」文案未出现（随后 10+ 次全绿未复现）；复现时插桩 ApprovalDetail 的 key 重挂载与决定/轮询时序，确认是否同类 key-reset 竞态                                                     |
| ~~通用异步选项目录组件抽取~~（已完成 2026-11-23） | `SETTINGS-001` | 已抽取 `web/src/sealed/ModelPicker.tsx` 统一 composer/执行模型/执行池/归类模型/事情级指定模型 6 处入口（搜索 + 30/页分页 + 键盘导航 + 置顶特殊值）；合同测试见 `test/workspace-theme.test.ts` 与 `web/src/App.test.tsx`       |

## 提醒约定

每周工程复盘或开始上述 Feature 时检查本文件。只有规则在 Pegas 中被真实观察到，才移入 `docs/lessons.md`；满足晋升条件后再进入强制标准或自动化门禁。
