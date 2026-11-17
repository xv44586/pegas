# Pegas Engineering TODO

> 状态：Living Document
>
> 更新日期：2026-11-17

这里记录值得逐步采用、但尚未被 Pegas 自身事故证明为强制标准的工程规则。它们不是完成声明；开始实现时必须回到 Feature Intake，确认归属、验收条件和隔离 worktree。

## P0：近期安排

| 规则                                                                 | 归属           | 采用触发点                | 预期验证                                            |
| -------------------------------------------------------------------- | -------------- | ------------------------- | --------------------------------------------------- |
| 每个 Candidate 的证据绑定精确 Git SHA、产物校验值和已完成 CI run     | `SELF-001`     | SelfChange / Release 实现 | manifest 校验拒绝 SHA 不一致、失败或取消的检查      |
| lease、重试和超时统一使用可注入 Clock，测试不依赖短 sleep            | `EXEC-003`     | Worker 恢复加固           | 到期前、到期点、到期后均为确定性测试                |
| Supervisor 状态读取失败建模为 unknown/degraded，保留 last-known-good | `RECOVERY-001` | Recovery Plane 加固       | 截断、损坏、旧版本和写入中断故障测试                |
| 所有模型出口和安全豁免有结构化清单与旁路 Guard Test                  | `PRIVACY-001`  | 隐私网关实现前            | Router、DSH、tool arguments、嵌套字段和流式边界测试 |

## P1：相关 Feature 开始时采用

| 规则                                                                       | 归属 / 触发点             | 预期验证                        |
| -------------------------------------------------------------------------- | ------------------------- | ------------------------------- |
| Bug fixture 使用报告者的原始 bytes、渠道和环境，验收用户结果而不是中间步骤 | 所有 Bug                  | 回归测试在旧实现上稳定失败      |
| 修复前搜索所有 sibling；暂不修的 sibling 同步建 Issue                      | 所有 Bug                  | PR 列出搜索范围和未覆盖项       |
| 默认值不覆盖用户显式设置；用户可编辑副本测试“编辑后再同步”                 | 配置、Memory、DSH profile | round-trip 与升级测试           |
| 只对新数据生效的修复必须提供旧数据迁移或兼容说明                           | schema / 持久化变更       | 旧版本 fixture 升级测试         |
| 新 route 声明认证、body 上限、幂等性和副作用等级                           | Control Plane 扩展        | route inventory Guard Test      |
| Provider 拒绝先区分账号、模型、请求内容和 endpoint，再决定重试或熔断       | Model / ASR provider      | 分类错误与第二账号/模型对照测试 |
| 高频路径按最大输入和真实调用频率做性能预算                                 | polling、stream、恢复扫描 | 基线与上界测试                  |

## P2：发布与平台成熟后采用

| 规则                                                            | 触发点                  | 预期验证                                    |
| --------------------------------------------------------------- | ----------------------- | ------------------------------------------- |
| Node 22/24 和 macOS 的进程、signal、路径、SQLite 门禁           | 开始支持长期 Mac 节点   | 跨版本/平台 CI matrix                       |
| hermetic smoke 与真实 DSH Candidate canary 分层                 | SelfChange 可运行       | fake child 故障测试 + 隔离真实 session 恢复 |
| 取消的 CI 不算证据，Release 等待目标 workflow 在准确 SHA 上完成 | 自动发布上线            | release gate 集成测试                       |
| 真实外部服务变更在受控 sandbox 做一次不可逆路径演练             | 新 provider / migration | canary 记录与回滚演练                       |

## 提醒约定

每周工程复盘或开始上述 Feature 时检查本文件。只有规则在 Pegas 中被真实观察到，才移入 `docs/lessons.md`；满足晋升条件后再进入强制标准或自动化门禁。
