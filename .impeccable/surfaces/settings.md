# Pegas Settings

## Scope

- Mode: Operate
- Primary target: `web/src/App.tsx`
- Related target: `web/src/styles.css`
- Audience: Pegas 的单个长期用户
- Job: 快速确认并配置模型入口、路由、隐私与输入处理
- Primary action: 保存一组可立即生效的服务端设置
- Important states: 未配置、已配置、保存中、保存成功、冲突、校验失败

## Direction contract

**THESIS:** 设置应该像熟悉的系统偏好面板：先选区域，再在一个安静的内容面板里完成配置；拒绝把所有选项堆成一条冗长表单。

**OWN-WORLD:** 冷灰窗口、白色内容面、墨黑文本与克制钴蓝选择色；使用 Apple 平台熟悉的分组侧栏、细分隔线、紧凑行和 12–14px 圆角，不使用玻璃、渐变或装饰性阴影。

**STORY:** 用户进入设置后先看到模型服务，扫描常用供应商并选择一个；选中项就地展开连接与模型字段，保存状态始终固定可见。路由、隐私和输入处理留在侧栏中的独立区域，不与 Provider 配置争抢注意力。

**FIRST VIEWPORT:** 桌面端左侧是约 180px 的设置分区栏，右侧顶部为“模型服务”标题和一句解释，中部先显示常用供应商的紧凑选择网格，再显示当前连接表单；底部固定状态与“保存更改”。移动端分区栏收成横向分段导航，内容保持单列和 48px 触控目标。

**FORM:** seed: none (pinned). 用户明确要求“现代的 Apple 风格”；签名交互是选择 Provider 后在同一内容面更新连接详情，不打开第二层弹窗。

**FINISH:** unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
