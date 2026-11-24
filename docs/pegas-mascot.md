# Pegas 形象

> Feature：BRAND-002
>
> 状态：Usable（已合并最新 BUI 基线并完成本地桌面包验证）
>
> 更新日期：2026-11-24

## 用户结果

Pegas 使用确认版圆肚机器人作为自己的视觉身份。奶白机身、短手短脚和蓝灰
天线适用于对话首页、关于页和桌面图标。客户端执行状态可以显示直立起飞。
说话表情作为独立资源，供 VOICE-002 的播放状态接入。

## 验收条件

1. 对话欢迎区、关于页、主入口与桌面图标使用同一圆肚机器人。主页编排继续
   使用显式宽高，静态和动态 SVG 共用方形画布，语义文案保留。
2. 桌面 ICNS 与 favicon、触屏图标以确认版圆角底板导出；桌面图标包含 16–1024px
   资源。应用内头像为透明底，在明暗界面都可识别。
3. 对话 Run 摘要在服务端状态为 `running` 时展示竖直起飞；排队、等待、审批
   和终态仍通过现有状态文字或图标说明。消息发送中的「正在整理」为静态。
4. 说话 SVG 只动嘴型和眼睛，并能由 `PegasMascot` 的 `speaking` 姿态渲染。
   当前应用等待 VOICE-002 的真实播放事件，收到文本消息不会启动该动画。
5. 开启减少动态效果时，起飞和说话在同一画布显示静态角色。图像默认作为装饰，
   独立需要说明时由调用方提供可访问名称。
6. 现有 Worker 身份的分配、产品状态和权限边界保持既有契约。

## 非目标

- 本次涵盖品牌资源和客户端呈现。语音合成、播放队列、数据层、权限和路由调整
  由各自 Feature 管理。
- 四种 Worker 专属插画继续由 BRAND-001 管理。

## 数据、权限与恢复

形象与动效为同源静态资源，SVG 自包含。运行状态来自既有 Run 快照，品牌
资源不参与状态判定。资源更新无迁移、外部请求或权限变化。发生渲染异常时
可回滚 BRAND-002 提交；候选版本使用 Supervisor 已有的 previous Release
恢复。应用图标由新版桌面包提供。

## 权威实现与产物

- `web/src/sealed/PegasMascot.tsx` 负责静态、起飞和说话资源及可访问性。
  `web/src/sealed/MainPages.tsx` 将起飞限定在执行中的 Run 摘要。
  减少动态效果使用 `picture` 选择静态资源，支持界面打开时切换偏好。
- `web/public/brand/pegas-home.svg`、`pegas-flight.svg`、`pegas-speaking.svg`
  是确认版图像。三者内嵌同一透明 WebP，动效直接嵌在 SVG 内。
- `web/public/brand/pegas-mascot.png` 是透明 PNG 母版，生成
  `agent-bot.webp` 供 `PegasMark` 与身份头像使用。
  Web 图标 URL 使用版本参数刷新不可变缓存。
- `desktop/icon.svg` 和 `desktop/icon.png` 是确认版桌面图标源文件。
  `scripts/generate-brand-icons.mjs` 从 PNG 派生 `Pegas.icns`、favicon
  和触屏图标，并记录确认版资源与生成产物的 SHA-256。
- 使用 `pnpm brand:generate` 重新派生（Python 3 + Pillow）。
  `pnpm brand:check` 不需要 Pillow，随 `pnpm check` 验证漂移。

## 验证证据

- `test/pegas-mascot-assets.test.ts` 覆盖同源位图、方形画布、尺寸边界与
  减少动态效果回退。
- `test/brand-icons.test.ts` 覆盖桌面容器尺寸、浏览器图标和资源 manifest。
- `web/src/sealed/PegasMascot.test.tsx` 与对话、审批测试覆盖显示和状态契约。
- 合并 DESIGN-009 BUI 基线后，执行中卡片保留 BUI 的状态结构和 RunTrace，
  仅在真实 `running` 状态把状态胶囊替换为 30px 起飞机器人；定向 6 个测试文件、
  59 个测试通过。
- 完整 `pnpm check` 在 Node 24.22.1 下通过 140 个测试文件、1440 个测试。
  覆盖率为语句 77.75%、分支 71.50%、函数 74.81%、行 80.94%。
- `pnpm smoke` 验证 Task、Run、Outbox、webhook 和 Scheduler。
  最新 BUI 合并态的 `pnpm review:ui -- --force` 通过桌面、暗色与 390px
  几何检查；`pnpm a11y:review` 在 19 个界面场景均为 0 违例。
  Chrome 构建实测验证桌面与 390px 首页、30px 执行动效及运行时切换减少动态效果。
- macOS arm64 打包产物的 ICNS 与三个 SVG 和仓库字节一致。
  最新代码经 `pnpm package:mac` 重建后，`pnpm smoke:desktop:packaged` 在
  Node 22.22.2 通过，覆盖应用启动、
  完成 Run、Dock 未读计数和服务故障退出回收。

## 合并与上线（2026-11-24）

- PR #96 经 CI run `45433842847` 全绿后合入 main，merge commit 为
  `f2c4031941f6a5ca77f6f80d1a1a0d678b7435d3`；main CI run
  `45434985863` 的 `pnpm check` 与 `pnpm smoke` 同样成功。
- 隔离 release worktree 在 exact merge commit 上通过 `pnpm smoke:self-change`，
  再由 `buildSelfChangeCandidate` 重跑 140 个测试文件、1440 个测试与 smoke，
  生成 `main-f2c4031-r1`。Candidate 兼容 schema 31–48，无迁移；CI、测试、
  Review Report 和人工审核均绑定同一 commit。
- `node_modules` 使用 APFS clonefile 实体化，1901 个内部符号链接均验证为
  tree-relative；重算 artifact attestation 与 manifest 后再次通过完整性校验。
  Recovery API staging 从 verifying 自动确认 stable，随后更新并重启 launchd
  Supervisor；删除 release worktree 后再次通过 Recovery restart。
- 运行实例 active=`main-f2c4031-r1`，previous=`main-a9dca1e-r1`，恢复状态
  integrity=`ok`。线上 favicon、32px 图标、Apple touch icon、应用内头像与
  home/flight/speaking 三个 SVG 共 7 个资源均与 Candidate SHA-256 一致；
  `/readyz`、events、channels、runs、outbox 均为 200。真实 Chromium 验证
  BUI 对话页标题、侧栏机器人、favicon、flight SVG MIME 与 1440px 零横溢。
- `releases/desktop/mac-arm64/Pegas.app` 已从最新 main 重建，包内 ICNS 与
  `desktop/Pegas.icns` 字节一致，打包态 Electron smoke 通过。当前机器没有
  已安装的 `/Applications/Pegas.app`，因此未替换系统应用；产物仍未签名或公证，
  与 DESKTOP-001 的既有非目标一致。
- 运行时回滚使用 Recovery API 切回 previous；代码回滚 revert merge
  `f2c4031`。本次没有 schema 或数据变化，旧 Release 可直接读取现有数据。

## 下一缺口

VOICE-002 接入真实语音播放后，播报开始和结束将驱动 `speaking`，包括
失败和打断后的结束。侧栏和客户端保留服务端事实及现有状态文字。
