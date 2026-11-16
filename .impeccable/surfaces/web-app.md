# Pegas Web App

## Scope

- Mode: Operate
- Primary target: `web/src/App.tsx`
- Audience: Pegas 的单个长期用户
- Job: 通过一条自然对话流交付意图，快速理解任务状态，并在需要时深入检查具体执行
- Primary action: 向 Pegas 发送消息
- Important states: 空闲、规划、运行、等待用户、完成、失败、离线与加载失败
- Constraints: React；服务端持有真实状态；桌面与移动端共享信息架构；不要求用户先进入任务管理

## Chosen direction

用户确认采用“任务脉冲流 + 个人指挥中心”的组合：入口沿用自然对话和内嵌任务卡，需要查看具体任务或进程时再展开任务工作台。

## Direction contract

**THESIS:** 同一件事情从一句话自然长成一条可检查的执行脉冲；拒绝先选项目、再建任务、最后才开始对话的管理软件结构。

**OWN-WORLD:** 冷静的浅灰工作表面、墨黑文本与单一钴蓝执行色；任务以有左侧状态轨道的平面信息块出现，细线、紧凑状态标签和一致的圆角构成语言，不使用发光、玻璃或装饰性渐变。

**STORY:** 用户先看到自己和 Pegas 的连续对话，任务计划、运行和结果就地出现；点击任一任务卡，桌面端展开右侧任务工作台，移动端进入完整任务详情，从概览逐层看到 Run、时间、输出与错误。

**FIRST VIEWPORT:** 桌面端左侧是窄导航，中央对话占主要宽度，右侧默认显示“正在进行”摘要；底部输入器固定在对话列内。首屏必须直接展示一段真实比例的对话和一张正在执行的任务卡，而不是欢迎页或数据看板。移动端只保留顶部身份、对话流和底部输入器，任务详情按需覆盖进入。

**FORM:** seed: none (pinned)。“入口是 2 这种自然展示，要查看具体任务/进程等等用 3”。签名交互是任务卡到任务工作台的渐进展开：不离开对话上下文，只增加信息深度。

**FINISH:** unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
