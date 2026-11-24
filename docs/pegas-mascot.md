# Pegas 形象

> Feature：BRAND-002
>
> 状态：Usable（独立提交与本地桌面包已验证）
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
- 完整 `pnpm check` 在 Node 22.22.2 下通过 135 个测试文件、1397 个测试。
  覆盖率为语句 85.60%、分支 78.45%、函数 89.93%、行 88.69%。
- `pnpm smoke` 验证 Task、Run、Outbox、webhook 和 Scheduler。
  Chrome 构建实测验证桌面与 390px 首页、30px 执行动效及运行时切换减少动态效果。
- macOS arm64 打包产物的 ICNS 与三个 SVG 和仓库字节一致。
  `pnpm smoke:desktop:packaged` 在 Node 22.22.2 通过，覆盖应用启动、
  完成 Run、Dock 未读计数和服务故障退出回收。

## 下一缺口

VOICE-002 接入真实语音播放后，播报开始和结束将驱动 `speaking`，包括
失败和打断后的结束。侧栏和客户端保留服务端事实及现有状态文字。
