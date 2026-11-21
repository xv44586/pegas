# Pegas 形象（Mascot）

> Feature：BRAND-002
>
> 状态：Usable
> 更新日期：2026-11-21

## 用户结果

Pegas 拥有自己的动漫风格形象：一个圆润、安静的白色支援机器人。它出现在
对话页空状态欢迎区和设置「关于」页，让用户面对的始终是这个长期搭档，
而不是通用的闪光图标或第三方角色。

形象拥有四个姿态（idle / waiting / celebrate / blocked），并统一派生为
favicon、apple-touch-icon 与 macOS 桌面图标，替换旧的抽象 P/翼形标志。
侧栏、接入页与设置页的 `PegasMark` 直接使用透明背景的 idle 插画；
「所有事情」里每个 Channel 的身份图标（car / camera / computer / phone）
也使用同一插画语汇的专属角色（详见 `docs/agent-icon-assets.md`）。

## 设计决策

- **原型**：致敬《宇宙骑士 BLADE》中支援机器人柏卡斯的角色定位——承接意图、
  提供能力、帮助用户完成「变身」。形象为完全原创设计，不复制该作品的造型、
  配色或任何受版权保护的元素（见 PRODUCT.md 品牌承诺）。
- **形态**：悬浮蛋形舱体、深色面罩上的两只发光眼睛与浅笑弧线、短天线、
  折叠小翼造型的侧推进器。传达「随时在场、 quietly capable」的支援感，
  而不是驾驶席上的复杂系统。
- **色彩**：白色壳体（#FFFFFF / #F7F7F5 阴影）、periwinkle 蓝点缀
  （#5267F8）、墨色面罩（#181818）、青色眼神光。与 DESIGN.md 的
  white-first + 蓝色信号色一致；白色机体在暗色主题画布上天然成立，
  无需主题特判。
- **气质**：现代动漫影响的柔和赛璐璐插画，克制、可靠、微微愉悦，
  不幼稚、不喧闹。缩小到 120px 仍可辨认。

## 资产与权威实现

- 组件：`web/src/sealed/PegasMascot.tsx`（默认装饰性 `aria-hidden`；
  传入 `label` 时成为具名 `role="img"`；显式宽高避免布局偏移）。
- 位图：`web/public/brand/pegas-mascot.webp`（640×449，约 31KB，运行时引用）
  与 `pegas-mascot.png`（同源无损版本，供后续图标/印刷派生）。
- 姿态位图：`pegas-mascot-{waiting,celebrate,blocked}.webp`（480 宽，
  各约 26–37KB）与同源 PNG；`PegasMascot` 通过 `pose` 属性选择资产并按
  各自宽高比占位。
- 身份插画：`web/public/brand/agent-{bot,car,camera,computer,phone}.webp`
  （256×256 透明无损 WebP，由 `scripts/generate-brand-icons.mjs` 从
  `pegas-mascot.png` 与 `worker-{car,camera,computer,phone}.png` 母版派生）。
  `bot` 即 idle 形象本体；car 是青色眼睛的白色小车、camera 是蓝圈镜头
  单眼相机、computer 是带笑脸的显示器、phone 是青色双眼的手机，全部
  白色陶瓷机体 + periwinkle 点缀 + 墨色面罩 + 青色眼神光，与形象同风格。
  UI 内不加底板，直接透明落在页面背景上。
- 出现位置：对话欢迎区（`MainPages.tsx`，148px）、关于页
  （`SettingsPage.tsx`，168px，具名图像）、发送中 composer 等待指示
  （waiting，30px + 「正在整理…」文字）、待你处理空状态（celebrate，
  104px）。blocked 姿态挂载于待确认审批卡头部（具名「Pegas 等待你的决定」，决定后移除）。
- 应用图标派生：`scripts/generate-brand-icons.mjs`（`pnpm brand:generate` /
  `pnpm brand:check`，已串入 `pnpm check`）。generate 需要 python3 + Pillow；
  check 只比对 `scripts/brand-icons-manifest.json` 的 sha256，纯 Node、
  CI 无需 Pillow。以 idle 姿态合成 1024 品牌蓝圆角底板（应用图标需要
  实底以适配桌面/主屏），派生 `web/public/favicon.svg`（内嵌 128px 插画
  位图的自包含 SVG）、`favicon-32.png`、`apple-touch-icon.png`、
  `desktop/icon.svg`（自包含 data URI）与 `desktop/Pegas.icns`（手写
  ICNS 容器，PNG payload，含 16–1024 全尺寸）；同脚本派生五个 256px
  透明身份插画。
- 原始生成图（1536×1024，含透明通道）保存在本地
  `research/pegas-mascot/`，不提交。

## 验收条件

1. 对话页空状态展示形象而非通用图标；标题与说明文案不变。
2. 关于页展示具名形象；版本信息布局不变。
3. 形象在已命名按钮外默认装饰性；独立展示时有可访问名称。
4. 位图带透明通道、显式宽高，加载不引起布局偏移；WebP 体积 < 200KB。
5. 三主题（light/warm/dark）下无需滤镜即可读。
6. 发送中显示 waiting 姿态与文字；待你处理空状态显示 celebrate 姿态。
7. favicon / touch icon / 桌面 icns 与形象同源；`pnpm brand:check` 防漂移。
8. 侧栏 `PegasMark` 与「所有事情」Channel 图标使用同风格透明插画，无蓝色底板；38px 列表尺寸下角色可辨认。

## 非目标

- 不引入动画或表情包。`PegasMark` 已统一为透明 idle 插画（侧栏/设置/接入页共用）；UI 内不使用应用图标的蓝底板。
- 不让形象承担状态表达；Channel 状态仍由徽记与文字表达（BRAND-001）。

## 数据、权限与恢复边界

纯静态前端资产，无外部请求、无用户数据。回滚本 commit 即恢复原
Sparkles 欢迎图标与关于页标志；无 schema 或 API 变化。
应用图标回滚即恢复旧 favicon/icns；`brand:check` 保证产物可重建。

## 验证证据

- `web/src/sealed/PegasMascot.test.tsx`：装饰/具名可访问性、宽高占位
  （160→112）、运行时引用路径与三姿态资产/宽高比。
- `web/src/sealed/ConversationWelcome.test.tsx`：空状态欢迎区渲染形象、
  不再渲染通用 SVG 图标，标题文案保持不变；发送中 waiting 姿态出现与
  消失；待你处理空状态 celebrate 姿态。
- `test/pegas-mascot-assets.test.ts`：WebP/PNG 资产存在，WebP 体积在
  10KB–200KB 区间（含三姿态）。
- `test/brand-icons.test.ts`：ICNS 容器完整性与全尺寸、favicon/touch
  icon 链接与产物、desktop/icon.svg 自包含。
- `web/src/sealed/ApprovalMascot.test.tsx`：pending 审批显示具名 blocked
  姿态，resolved 后移除。
- `web/src/sealed/PegasMark.test.tsx`：lockup 标志为透明 idle 插画（`/brand/agent-bot.webp`）而非矢量脸或旧抽象翼形。
- `test/agent-icon-assets.test.ts`：五个身份插画 256×256 透明 WebP、母版齐全、manifest 覆盖。
- `pnpm brand:check`：十个品牌位图产物与生成器一致。
- 浏览器截图：light/dark 欢迎区与关于页（`output/feature-review/media/
desktop-settings-about.png` 及本地探针截图）。
- 完整门禁：`pnpm check`、`pnpm smoke`（见 Feature Map 与提交说明）。

## 剩余风险与下一缺口

- 暗色主题与移动端实机截图待补（沿用 DESIGN-002 截图流程）；白色机体
  在暗色画布上依赖自身阴影成立，若未来出现低对比场景再考虑描边版本。
- 生成式位图的版权归属按生成平台条款处理；造型为原创 prompt 设计，
  未引用参考图。
