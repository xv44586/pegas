# Pegas macOS Electron 客户端

> Feature: DESKTOP-001
>
> 状态：Usable
> 日期：2026-11-20

## 架构决定

macOS 第一版是封板 Web UI 的安全桌面适配层，不是第二套产品。Electron 主进程只启动一个 Supervisor；Control Plane、Worker、Scheduler 等业务进程全部由 Supervisor 作为子进程守护（两层守护单一归属）。Renderer 通过本机 HTTP 使用相同 Conversation、Task、Run、Outbox、设置、Automation 和恢复事实。桌面端不复制 Router、Executor 或数据库实现。

```text
Electron main
├── BrowserWindow ── http://127.0.0.1:<ephemeral-port> ── sealed Web UI
├── residency API ── 127.0.0.1:<ephemeral-port>（本机常驻偏好，bearer 鉴权）
└── Supervisor ──── data/supervisor.lock 单实例互斥 + recovery API
    ├── Control Plane ── SQLite under app.getPath('userData')
    ├── Worker ───────── same data directory and existing executor boundary
    └── Scheduler ────── same SQLite and durable Event Inbox
```

App 生命周期模式下 Supervisor 以 `PEGAS_SUPERVISOR_RESTART=disabled` 运行：业务进程意外死亡时 Supervisor 不静默复活服务，而是记录失败并退出，窗口诚实展示故障页。版本切换、回滚与迁移审批仍由同一 Supervisor 的 recovery API 提供。业务进程各自领导进程组（`detached`），Supervisor 停止时对组发信号，执行器后代不会成为孤儿。

## 安全与权限

- Renderer 开启 `contextIsolation` 与 `sandbox`，关闭 `nodeIntegration`，不提供 preload bridge。
- 导航只允许启动时确定的本机 Pegas origin；外部 `http`/`https` URL 交给 macOS 默认浏览器。
- 权限默认拒绝；仅允许受信本机 origin 的 audio media 请求，用于封板语音输入。
- 服务监听 `127.0.0.1` 并使用运行时选择的空闲端口。数据目录不放在应用包内。
- 内置服务显式注入 `PEGAS_WORKSPACE_ROOT=~/.pegas/workspaces/<dataDir 路径哈希>`
  （与服务端同一派生函数），Agent 执行工作区永不落在应用 checkout 或任何仓库树
  内；从终端带出的同名环境变量会被覆盖，避免开发仓库的 AGENTS.md/docs 被 DSH
  误加载为 Agent 指令。
- 内置服务首次启动生成随机实例 bearer 并保存到数据目录下的 `api-token`（0600），后续启动复用，并通过环境变量传给 Supervisor 和子进程。Electron session 只向受信本机 origin 注入认证头，用户可直接进入。连接已有的回环 Control Plane 时可通过本机 Web 自动认证，也可通过显式 `PEGAS_API_TOKEN` 使用原生请求头注入。

## 运行与打包

- `pnpm build:desktop`：编译 Electron 主进程。
- `pnpm desktop:run`：构建后在本机启动开发版 macOS 窗口。
- `pnpm smoke:desktop`：启动真实 Electron、确认封板主界面和安全窗口配置，并保存审查截图。
- `pnpm smoke:desktop:packaged`：启动已经生成的 `.app`，从封板输入器提交 Task、等待 Worker 完成 Run，再终止 Worker 并确认产品页撤下，以验证 ASAR 封装后的真实监督闭环。
- `pnpm package:mac`：生成未签名的 macOS 本地候选包；签名、公证和自动更新另属发布 Feature。

生成的本地 Candidate 位于 `releases/desktop/mac-arm64/Pegas.app`。它带封板蓝色 Pegas 图标，但不会自动签名或公证；首次分发前必须新增发布 Feature 处理 Developer ID、notary、DMG 与更新通道。

## 后台运行与常驻（2026-11-24 实现）

- **默认不常驻**：退出 App 即停止内置服务；定时自动化仅在 App 运行期间执行。设置页如实告知这一限制。
- **常驻是设置开关，不是默认**：封板设置「Pegas」分类的「后台运行」区块提供「关闭窗口后继续运行」开关（默认关）。开启后关闭窗口只结束窗口，App 与 Supervisor 继续运行（`window-all-closed` 不退出，Dock 点击 activate 重开窗口），并经 `app.setLoginItemSettings({ openAtLogin, openAsHidden })` 注册 launchd LoginItem 开机自启；关闭后注销 LoginItem，回到 App 生命周期守护。
- **本机偏好，不进服务端**：开关权威保存在桌面主进程 userData 下 `desktop.json`（原子写入，损坏时回落默认关），不进入服务端 runtime_settings。主进程在本机回环端口提供 bearer 鉴权的 `GET/PUT /desktop/residency`；Control Plane 以服务端持有的 token 同源代理 `/v1/desktop/residency`，Renderer 不接触桌面 token。
- **切换幂等、失败保留原状态**：LoginItem 注册成功才持久化偏好；失败返回 `residency_switch_failed` 并保留原状态，不静默半切换。
- **外部实例只读**：Web/桌面壳连接外部实例（未配置 `PEGAS_DESKTOP_RESIDENCY_URL`）时，代理返回 `managed:false` 与「由该实例的部署方式决定」说明，设置页显示只读态，不提供假开关。
- 验收条件见 `docs/feature-map.md`「Supervisor 接管桌面服务与常驻守护 Intake」的常驻决策定稿节。
- **已知限制**：开发态 `setLoginItemSettings` 指向 Electron 开发二进制，LoginItem 的实际开机自启效果需在打包态人工验收；常驻开时 Cmd+Q 仍显式退出并停止服务（只有关闭窗口才保活）。

## 验证证据

- 桌面运行时自动化测试覆盖隔离环境、可信回环 origin 与 bearer 注入、回环端口、Supervisor 单一入口接线（`PEGAS_SUPERVISOR_RESTART=disabled`、residency URL 注入）、ASAR 服务路径、优雅退出、SIGKILL 升级、macOS 进程组信号、异常 leader 的残留执行器清理，以及首次设置遮罩下的 smoke 恢复路径。
- 常驻链路测试：`test/desktop-residency.test.ts`（偏好读写原子性/损坏回落、LoginItem 成功才持久化、失败保留原状态、幂等）、`test/desktop-residency-proxy.test.ts`（只读投影、bearer/方法约束、同源代理读写、上游失败诚实透传）、`test/supervisor-instance-lock.test.ts`（单实例互斥、stale 回收、release 幂等）、`test/supervisor-child-lifecycle.test.ts`（信号退出判定、SIGTERM→SIGKILL 升级不挂起、进程组信号回退）。
- 开发态 Electron smoke 通过 UI 提交 Task 并等待 Worker 完成 Run；断言业务进程 ppid=Supervisor、`supervisor.lock` 内容=Supervisor pid、residency 代理 `managed:true` 默认不常驻；开常驻→真实关窗→服务 `/readyz` 仍存活→关回常驻→activate 重开窗；随后 SIGTERM 终止 Supervisor，确认窗口诚实展示故障（故障页或封板离线态）且不再接受输入，Supervisor 与全部业务进程组清零。
- 两类 Electron smoke 同时验证窗口标题、无控制台错误，以及 `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`。
- `pnpm check` 通过 46 个测试文件、450 个测试；独立 `pnpm smoke` 与 `pnpm smoke:desktop` 通过真实 Task→Run 闭环，后者还监督 Worker 与 Scheduler。
- 主界面和服务失败截图分别保存为 `output/feature-review/media/desktop-electron-macos.png` 与 `output/feature-review/media/desktop-electron-service-failure.png`，均不提交到仓库。

## 失败与回滚

Supervisor 在 Control Plane 健康检查通过前不启动数据库写入进程，避免冷启动时多个进程同时迁移新数据库；主进程在 Control Plane ready 前不加载产品页。启动超时或 Supervisor 提前退出时展示本机错误页，不伪装为在线。业务进程分别运行在独立进程组中；Supervisor 停止时对整个组先发 SIGTERM，宽限后再发 SIGKILL（退出判定同时看 `exitCode` 与 `signalCode`，信号杀死的子进程不会让停止链路挂起），服务主进程已经异常退出时也会清理组内残留执行器。删除 DESKTOP-001 提交即可回到纯 Web 构建；用户数据目录不随代码回滚删除。

## 原生提醒（2026-11-24）

> 状态：已实现。复用 Feature ID `DESKTOP-001`；本节把原「原生通知不在范围内」的边界收敛为「macOS 原生提醒在本节范围内，签名/公证/自动更新仍属后续发布 Feature」。

### 用户结果

桌面 App 在后台或最小化时，用户也能从 macOS 系统通知感知「需要你处理」的新事项（审批、澄清、交付审查、失败核对），点击通知直达对应事项；Dock 图标显示未读角标，回到前台处理完后角标消除。不再依赖用户主动切回窗口查看。

### 方案与边界

- **提醒面 = Outbox 未读事实，不是新事实来源**。Electron 主进程周期轮询既有 `GET /v1/outbox?userId=owner`（实例 bearer 仅存在于主进程），对「新出现且未读」的消息发一条 Electron `Notification`；点击通知聚焦主窗口并导航既有深链 `/?view=outbox&outbox=<messageId>`（复用 Web 恢复机制，不新增路由）。
- **Dock 角标** = 未读 Outbox 条数（`readAt == null`），经 `app.dock.setBadge` 展示；全部已读或未连接时清除。产品已读与外部投递状态语义不变：桌面提醒不写 `readAt`、不改 `status`、不调用 resolve。
- **不新增通知信道与进程**：不改 `src/notification/*` dispatcher、不引入 APNs/Web Push、不启动 webhook 服务；桌面内置服务 `PEGAS_PUSH_MODE=disabled` 不变。桌面提醒是纯客户端适配（长期约束：权威状态在服务端）。
- **去重与安静**：主进程按消息 id 去重（进程生命周期内），重启后只提醒「上次可见最大 createdAt 之后」的新消息，不对历史未读补发轰炸；沿用服务端静默时段结果（Outbox 消息本身已被 quiet hours 延迟产生，客户端不复制 quiet 逻辑）。系统通知权限被拒时静默降级为仅 Dock 角标，不报错不重试。
- **数据与权限边界**：轮询只读、owner 隔离由既有 API 保证；bearer 不进入 renderer；通知正文只用消息既有 title/摘要投影，不展示敏感 evidence 内容。
- **失败与恢复**：轮询失败（服务停止/网络错误）指数退避并清除角标为未知态（不显示假 0）；服务恢复后继续。窗口不存在时点击通知走既有 `activate` 重开路径。

### 验收条件与实现证据

1. 新 Outbox 未读消息触发一次系统通知（同 id 不重复）；点击聚焦窗口并打开对应 outbox 深链。
2. Dock 角标数与服务端未读数一致；已读后下一轮轮询消除；轮询失败不误报 0。
3. 通知权限拒绝时降级为角标，无错误弹窗；历史未读在 App 重启后不补发通知。
4. 不改 dispatcher/store/schema；`pnpm check` 与 `pnpm smoke:desktop` 通过，smoke 断言角标与通知调用（Electron 主进程 evaluate）。

- **权威实现**：`src/desktop/attention.ts`（纯逻辑：快照解析、基线去重、角标计数、通知文案投影、失败退避计数），`src/desktop/main.ts`（主进程接线：3s 轮询受信 origin `/v1/outbox?userId=owner`，bearer 只在主进程；`Notification` 点击聚焦窗口并加载既有 `/?view=outbox&outbox=<id>` 深链；`app.dock.setBadge`；退出时停轮询并清角标）。
- **自动化证据**：`test/desktop-attention.test.ts` 6 测试（解析拒绝坏形状、历史未读只计角标不补发通知、同 id 只通知一次、全部已读清除角标、失败不清假 0、通知不可用降级角标、深链编码、通知文案不泄漏工具参数）；`test/desktop-runtime.test.ts` +3（主进程接线合同、退出清理、smoke 角标生命周期断言存在）。
- **真实进程证据**：`pnpm smoke:desktop` 在真实 Electron 中完成 Task→Run 后断言 Dock 角标 > 0（`app.dock.getBadge()` 主进程 evaluate），经真实已读 API 标记一条已读后断言角标下降；服务终止与进程组清理断言不回归。

### 非目标

- APNs、Web Push、PWA（NOTIFY-002，本期押后）；通知优先级分级（NOTIFY-001）；菜单栏常驻与全局快捷键；签名/公证/自动更新（发布 Feature）。
- 不在桌面端复制静默时段、合并或投递重试逻辑；不新增服务端接口。
