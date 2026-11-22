# Pegas Engineering TODO

> 状态：Living Document
>
> 更新日期：2026-11-22

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

## P2：发布与平台成熟后采用

| 规则                                                            | 触发点                  | 预期验证                                    |
| --------------------------------------------------------------- | ----------------------- | ------------------------------------------- |
| Node 22/24 和 macOS 的进程、signal、路径、SQLite 门禁           | 开始支持长期 Mac 节点   | 跨版本/平台 CI matrix                       |
| hermetic smoke 与真实 DSH Candidate canary 分层                 | SelfChange 可运行       | fake child 故障测试 + 隔离真实 session 恢复 |
| 取消的 CI 不算证据，Release 等待目标 workflow 在准确 SHA 上完成 | 自动发布上线            | release gate 集成测试                       |
| 真实外部服务变更在受控 sandbox 做一次不可逆路径演练             | 新 provider / migration | canary 记录与回滚演练                       |

## Feature 待办：DESIGN-002 待处理收件箱后续（2026-11-22）

本轮收件箱 refinement 已合并的边界之外的缺口，开始实现时回到各自 Feature Intake，另建隔离 worktree：

| 待办                                       | 归属          | 说明与验收                                                                                                                                                                                                                    |
| ------------------------------------------ | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 待处理服务端全文搜索                       | `NOTIFY-003`  | 当前 Web 搜索只过滤已加载快照；需服务端查询合同 + owner 隔离与上限回归                                                                                                                                                        |
| 待处理游标分页 / 虚拟列表                  | `NOTIFY-003`  | 大量消息时保持稳定游标续页与滚动位置；分页合同、去重与恢复回归                                                                                                                                                                |
| 待处理批量处理与通知优先级                 | `NOTIFY-003`  | 需服务端幂等批量合同与优先级事实来源，不得由 Web 从自由文本推断                                                                                                                                                               |
| 待处理页 VoiceOver / NVDA 实机验证         | `DESIGN-002`  | axe 已 0 违例；补真实读屏的列表导航、操作名称与焦点恢复记录                                                                                                                                                                   |
| `smoke-desktop.mjs` 发送按钮选择器歧义修复 | `DESKTOP-001` | `getByRole('button', { name: '发送' })` 同时命中「说完直接发送」；先加复现回归再改精确匹配                                                                                                                                    |
| 桌面服务改由 Supervisor 统一守护           | `DESKTOP-001` | Electron 只 spawn Supervisor，业务进程健康门禁/备份/切换/回滚复用 SELF-001；先决策窗口关闭后是否常驻（launchd LoginItem vs App 生命周期）；同一数据目录单实例互斥；见 Feature Map「Supervisor 接管桌面服务与常驻守护 Intake」 |
| 临时 launchd 托管的退役                    | `DESKTOP-001` | 本机 `com.pegas.supervisor.plist` 是 Intake 期临时措施；桌面端接管后移除，避免双重守护                                                                                                                                        |
| Web bundle 超过 500 kB 的分包评估          | `DESIGN-002`  | Vite 构建提示主 chunk 587 kB；评估路由级 code splitting 与加载预算                                                                                                                                                            |
| Approval 决定保存回执的低概率竞态          | `DESIGN-002`  | 2026-11-22 全量 coverage 下偶发一次「决定已保存」文案未出现（随后 10+ 次全绿未复现）；复现时插桩 ApprovalDetail 的 key 重挂载与决定/轮询时序，确认是否同类 key-reset 竞态                                                     |

## 提醒约定

每周工程复盘或开始上述 Feature 时检查本文件。只有规则在 Pegas 中被真实观察到，才移入 `docs/lessons.md`；满足晋升条件后再进入强制标准或自动化门禁。
