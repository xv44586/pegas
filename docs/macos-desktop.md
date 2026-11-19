# Pegas macOS Electron 客户端

> Feature: DESKTOP-001
>
> 状态：Usable
> 日期：2026-11-20

## 架构决定

macOS 第一版是封板 Web UI 的安全桌面适配层，不是第二套产品。Electron 主进程启动现有 Control Plane 与 Worker；Renderer 通过本机 HTTP 使用相同 Conversation、Task、Run、Outbox、设置和恢复事实。桌面端不复制 Router、Executor 或数据库实现。

```text
Electron main
├── BrowserWindow ── http://127.0.0.1:<ephemeral-port> ── sealed Web UI
├── Control Plane ── SQLite under app.getPath('userData')
└── Worker ───────── same data directory and existing executor boundary
```

## 安全与权限

- Renderer 开启 `contextIsolation` 与 `sandbox`，关闭 `nodeIntegration`，不提供 preload bridge。
- 导航只允许启动时确定的本机 Pegas origin；外部 `http`/`https` URL 交给 macOS 默认浏览器。
- 权限默认拒绝；仅允许受信本机 origin 的 audio media 请求，用于封板语音输入。
- 服务监听 `127.0.0.1` 并使用运行时选择的空闲端口。数据目录不放在应用包内。

## 运行与打包

- `pnpm build:desktop`：编译 Electron 主进程。
- `pnpm desktop:run`：构建后在本机启动开发版 macOS 窗口。
- `pnpm smoke:desktop`：启动真实 Electron、确认封板主界面和安全窗口配置，并保存审查截图。
- `pnpm smoke:desktop:packaged`：启动已经生成的 `.app`，从封板输入器提交 Task、等待 Worker 完成 Run，再终止 Worker 并确认产品页撤下，以验证 ASAR 封装后的真实监督闭环。
- `pnpm package:mac`：生成未签名的 macOS 本地候选包；签名、公证和自动更新另属发布 Feature。

生成的本地 Candidate 位于 `releases/desktop/mac-arm64/Pegas.app`。它带封板蓝色 Pegas 图标，但不会自动签名或公证；首次分发前必须新增发布 Feature 处理 Developer ID、notary、DMG 与更新通道。

## 验证证据

- 9 个桌面运行时自动化测试覆盖隔离环境、可信回环 origin、回环端口、就绪等待、ASAR 服务路径、优雅退出、SIGKILL 升级、macOS 进程组信号和异常 leader 的残留执行器清理。
- 开发态与打包态 Electron smoke 均通过 UI 提交 Task 并等待 Worker 完成 Run；随后终止 Worker，确认产品页立即撤下且不再接受输入，并在故障页出现后立刻退出，断言 Control Plane 与 Worker 进程组均已消失。
- 两类 Electron smoke 同时验证窗口标题、无控制台错误，以及 `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`。
- `pnpm check` 通过 30 个测试文件、168 个测试；独立 `pnpm smoke` 通过真实 Task→Run 闭环。
- 主界面和服务失败截图分别保存为 `output/feature-review/media/desktop-electron-macos.png` 与 `output/feature-review/media/desktop-electron-service-failure.png`，均不提交到仓库。

## 失败与回滚

主进程在 Control Plane 健康检查通过前不加载产品页。启动超时或子进程提前退出时展示本机错误页，不伪装为在线。Control Plane 与 Worker 分别运行在独立进程组中；应用退出时对整个组先发 SIGTERM，等待 7 秒（覆盖 DSH 内部 5 秒清理窗口）后再发 SIGKILL，服务主进程已经异常退出时也会清理组内残留执行器。删除 DESKTOP-001 提交即可回到纯 Web 构建；用户数据目录不随代码回滚删除。
