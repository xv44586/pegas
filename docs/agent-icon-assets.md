# Pegas Agent 图标资产

> Feature：BRAND-001
>
> 状态：Usable
> 更新日期：2026-11-18

## 用户结果

Pegas 提供一组可直接用于网页头像、选择器和占位状态的统一 SVG 图标：默认机器人，以及汽车、相机、电脑和手机四个备用形象。

## 验收条件

1. 五个图标均为独立、可缓存的 `64 × 64` SVG，缩放到 `16px` 和 `32px` 时仍能识别。
2. 所有图标共享蓝色圆角底、白色线性符号、`4px` 线宽和一致留白。
3. 页面可通过 `--pegas-icon-background` 与 `--pegas-icon-foreground` 覆盖颜色。
4. 每个 SVG 包含 `role="img"`、`title`、`desc` 和关联的 `aria-labelledby`；作为已命名按钮内的装饰图标使用时，由调用方设置 `aria-hidden="true"`。
5. 生成脚本是图形路径、文件名和默认配色的唯一事实来源；提交的 SVG 必须与脚本输出完全一致。

## 非目标

- 本 Feature 不把图标接入现有导航、对话头像或设置页。
- 不提供动画、图标选择状态或服务端持久化配置。
- 不提交设计过程中的 PNG 预览、中间版本或第三方参考图片。

## 权威实现与产物

- 生成器：`scripts/generate-agent-icons.mjs`
- 静态产物：`web/public/icons/agents/pegas-{bot,car,camera,computer,phone}.svg`

图标路径由生成器中的 `iconDefinitions` 定义。每个图标只声明自身的白色符号；背景、可访问名称和主题变量由统一模板生成。

## 生成与检查

重新生成全部图标：

```bash
pnpm icons:generate
```

只读检查已提交产物是否缺失或与生成器漂移：

```bash
pnpm icons:check
```

`pnpm check` 会自动执行漂移检查。添加新图标时，在 `iconDefinitions` 增加唯一 `name`、可访问名称、描述和几何内容，然后重新生成并检查小尺寸渲染。

## 数据、权限与恢复边界

图标是无外部依赖的静态文件，不读取用户数据，也不产生网络、数据库或权限副作用。生成命令只写入 `web/public/icons/agents/` 下由固定定义列出的文件；检查模式不写文件。

生成失败时保留已有文件，修复脚本后重新运行即可。回滚本 Feature 只需撤销生成器、五个 SVG、文档和质量门禁配置，不涉及迁移或运行时状态恢复。

## 验证证据

- `pnpm icons:check`：5 个提交的 SVG 与生成器输出完全一致。
- XML 解析：5 个 SVG 均可由 `xmllint` 解析。
- 小尺寸渲染：机器人、汽车、相机、电脑和手机均在 `16px`、`32px` 下人工核对可识别。
- 完整门禁：`pnpm check`。

## 剩余风险与下一缺口

尚未在真实产品界面中验证不同背景、强制颜色模式和屏幕阅读器行为。后续接入 UI 时，应由实际控件提供操作名称，并根据语义决定 SVG 是信息图像还是装饰内容。
