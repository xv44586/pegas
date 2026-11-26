# Candidate Evidence Manifest

> Feature：`SELF-001`
>
> 状态：Usable（构建与 staging 闭环）；artifact 签名待实现
>
> 更新日期：2026-11-26

## 用户结果

Pegas 只有在 Candidate 的构建产物、Git commit 和验证证据属于同一个不可变版本时，才允许把它写入 Supervisor 的 verifying 状态。旧 commit 的测试、失败或取消的 CI、未通过的 smoke 和已被替换的 artifact 都不能作为发布证据。

## Manifest 内容

- Release ID、root、完整 Git commit 和创建时间；
- artifact 文件名、字节数和 SHA-256；
- 兼容的最小与最大数据库 schema；
- tested commit；
- 已完成且 conclusion 为 `success` 的 CI workflow、run ID、URL 和完成时间；
- 实际命令和测试数量；
- 通过的 smoke 命令与完成时间；
- 临时 Feature Review 报告的文件名、Feature ID、tested commit 与 SHA-256；
- 人工审核的 reviewed commit、审核人和时间；
- 明确记录的 `notTried`。

`ReleaseStateStore.stage` 接受 Candidate manifest、本地 artifact 路径和临时 Feature Review 报告路径，在状态变更前重新计算两份文件的 SHA-256，并确认 CI tested commit、报告 commit、人工 reviewed commit 与 Release commit 完全一致。

## 构建与 staging 实现（2026-11-21）

- `src/self-change/candidate-builder.ts` 从隔离 worktree 的 exact commit 构建 Candidate：复制 `dist/`、`package.json`、`pnpm-lock.yaml`，`node_modules` 以符号链接共享安装字节；写入目录级 SHA-256 attestation（跳过符号链接、按文件名排序），生成 Review Report 与 Manifest 后将全部文件冻结为只读。`verifyCandidateReleaseTree` 在 staging 前重新计算目录 digest，任何字节变化都会被拒绝。
- 本地自我修改使用 `local-self-change-gate` CI attestation：真实命令是在候选 worktree 内执行的 `pnpm check` 与 `pnpm smoke`；远程发布仍必须提供真实 GitHub Actions 证据。
- Recovery API `POST /v1/recovery/candidates` 是唯一的运行时 staging 入口：Bearer 鉴权、要求绝对路径、校验 manifest 与目录 attestation、检查候选 `minimumSchema` 不超过 active `maximumSchema`，与 restart/rollback 共用转换屏障；接受后返回 202 并进入 verifying。
- 自动化证据：`test/self-change.test.ts`（不可变构建、篡改拒绝、staging 校验、审批发布闭环）与 `pnpm smoke:self-change`（真实 Supervisor 进程的接管与自动回滚，MVP 场景 5/6）。

## 验收条件

1. exact commit、成功 CI、通过 smoke、测试数量和 schema 范围均为必填字段。
2. manifest 可以原子写入、读取和运行时校验。
3. commit 不一致、CI failure/cancelled、smoke failure 或 artifact 变化会阻止 stage。
4. 临时报告存在关键 `Not tried`、内容不完整或创建 Candidate 后发生变化会阻止 stage。
5. 完整质量门禁和 smoke test 通过。
6. stage 成功后临时报告可以按保留期删除；confirm 和 rollback 依赖 Candidate manifest，不依赖媒体继续存在。

## 非目标、权限与恢复

- worktree 创建、本地 CI 执行、Release 构建与进程切换已由 SELF-001 闭环实现（见上）；artifact 签名与远程 CI 强制仍是非目标。
- CI URL 和 run ID 是审计证据，不作为认证凭证；manifest 不得包含 token、环境变量或测试日志原文。
- manifest 校验失败时保持当前 active Release 不变。修复方式是重新运行准确 SHA 的验证和审核并产生新的 Candidate，不能编辑 hash、伪造 reviewed commit 或把失败结论改成 success。
- 当前 artifact 在 stage 时验证；未来还需要 Release Registry 在解包和启动前再次验证签名或内容清单。

## 发布后保留策略（SELF-001，2026-11-26）

- 基线：`5396aaa6`；独立 worktree `self-001-release-retention`，主目录既有未提交改动不纳入。
- 验收：成功上线且 Supervisor stable 后自动保留按 manifest 创建时间排序的最新 3 个 Candidate，额外保护所有已知实例的 active/previous、在运行进程、启动配置与保留版本引用的依赖；仅删除已识别的旧 Candidate 和对应不再引用的依赖。
- 接入：Supervisor 稳定确认后调用；release:hot 成功验证后补调，兼容仍运行旧 Supervisor 的桌面壳。重复调用幂等，构建、依赖物化、staging 与清理共用发布目录锁，避免引用检查之后有新版本被切换。旧 Supervisor 没有锁协议时保守跳过，不能以补调绕过。
- 权限边界：仅发布根下 candidates/dependencies 的已识别直接子目录；数据、备份、工作区和未完成构建不进入删除集合。目录符号链接、损坏 manifest、缺失/损坏实例状态、未知 Supervisor、处于验证或回滚阶段、保护事实变化时停止清理。
- 失败与恢复：清理失败仅记录诊断，不撤销已成功发布的版本；下次成功上线重试。删除前重新检查引用；失败删除不移除其 manifest，保留重试线索。删除不可恢复，因此所有运行、启动、回滚引用均为硬保护。
- 非目标：定时任务、清理工作区/数据库备份、停止其他实例、强制只剩 3 个目录或自动升级其他实例。

### 实现、恢复与验收

权威实现为 `src/self-change/release-retention.ts`、`release-directory-lock.ts` 与独立进程入口 `retention/main.ts`；Supervisor 仅在稳定确认后启动清理，`scripts/release-hot.mjs` 完成实机验证后补调。`PEGAS_RELEASE_ROOT` 可显式指定持久发布根，默认仍为调用脚本仓库下的 `releases`。

清理会核对主状态及 last-good、所有已登记 Supervisor PID、实际进程与打开文件、LaunchAgent/systemd 配置（包括符号链接）。保留树的符号链接逐跳解析，中间 Candidate 与最终依赖均受保护。无法读取、状态非 stable、旧协调进程、未知实例或引用变化均保留全部尚未删除的版本。最新诊断原子写入 `<发布根>/retention-last.json`；失败不影响健康版本。

`.release-directory.lock` 不自动抢占：进程异常退出留下锁时，维护者先检查记录中的 PID、所有构建/发布/清理进程及当前状态，确认没有持有者后才移除该锁并重试。正常解锁同时核对 inode 与唯一 owner，不能移除后来者的锁。升级现有实例时，必须让其 Supervisor 启动路径也使用支持锁协议的新 Candidate；未升级时保持 skipped，不能据此宣称自动清理已生效。

回滚继续使用 Supervisor 的 previous。清理不修改 schema；恢复旧协调器后自动清理会保守暂停。清理前检查与共享发布锁保护在役/回滚版本；删除旧历史不能撤销，不提供自动恢复已删除历史的承诺。

自动化：`test/release-retention.test.ts` 19 项覆盖最新三份、双实例、启动/运行引用、跨 Candidate 多跳依赖、不可读启动链接、冻结目录与外部链接、损坏状态、引用变化、锁冲突/残留及旧协调器；`scripts/smoke-self-change.mjs` 使用实际 Recovery API 验证清理锁阻止 staging 后正常切换与失败回滚。完整 `pnpm check` 通过：153 个测试文件、1708 项测试；`pnpm smoke` 与真实 Supervisor self-change smoke 通过。上线前生产 dry-run 按预期识别两个旧协调器并零删除；协调器升级与最终实机结果另存本次发布审计证据。
