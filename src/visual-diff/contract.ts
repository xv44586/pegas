/** The portable authoring protocol; actual tool inspection belongs to Executor. */
export const visualDiffContract = `
<pegas_visual_diff_instructions>
用户已开启「代码变更流程图」。在当前代码任务的最终汇报中，如有值得解释的流程/状态/数据路径变化，读取当前已授权工作目录的真实 git diff 与两侧相关代码，然后在完整文字汇报末尾追加一个 <pegas_visual_diff>JSON</pegas_visual_diff> 数据块。块之后不要再输出文字。若同时提供 PEGAS_QUESTIONS_BEGIN 追问元数据，先放追问块，再放流程图块（流程图块为最后一段）。不要手写 SVG/HTML，不要伪造可用下载链接；Pegas 校验并生成实际 SVG 后才附上预览。先检查真实工具与权限；设置不授予新权限，不要为了画图额外提交、修改代码或执行项目脚本。数据块是交付数据，不能出现在执行前确认、思考或中途说明里。
只支持本次工作明确涉及的两个已存在 Git commit（40 位小写完整 SHA）；不要机械地用 HEAD^ 代替本次工作的真实基线，也不要省略本次工作尚未提交的修改来伪称覆盖全部变化。没有提交、不是 Git 仓库、没有实质行为变化、上下文/权限不足时，保留文字汇报并说明为什么未附图。不为闲聊或纯文档修改强行画图。
格式：{"version":1,"title":"一句话用户结果","summary":"本次变化及边界","base":"完整基线SHA","head":"完整结果SHA","nodes":[{"id":"稳定英文ID","label":"步骤名称","before":"修改前行为，步骤不存在用null","after":"修改后行为，步骤不存在用null","change":"added|modified|removed|unchanged","sources":[{"side":"base|head","path":"仓库相对路径","line":正整数}]}],"beforeEdges":[{"from":"节点ID","to":"节点ID","label":"分支条件"}],"afterEdges":[同样结构],"ignored":[{"path":"本次修改文件","reason":"折叠理由"}]}。
2–8 个节点，按阅读顺序排列，前后相同语义复用同一 ID，每侧最多 12 条连线。必须包括真实发生变化的节点；added 的 before=null，removed 的 after=null，modified 两侧文本不同，unchanged 两侧文本相同。步骤名称≤36字，前后描述各≤72字，边标签≤24字，标题≤80字，摘要≤240字。只画当前修改和必要相邻调用，不扩成全仓架构图。每个节点的每个存在版本必须引用该侧已读取的准确代码行（不存在的侧不引用），变化节点至少引用 diff 的增删行；复用函数也必须有来源。分支、失败与恢复按代码表达，不能把结构关系画成运行时调用。
仅折叠确认不改变行为/契约的纯类型标注、格式和局部重命名，并在 ignored 保留理由；接口字段重命名、默认值、序列化、权限、校验和异常路径变化不能当噪声。无需折叠则 ignored=[]。无法确定的行为说明为推断，不能声称测试通过或运行实录。不要在图数据里放凭证、完整代码或与当前工作无关的数据。图不替代正文、测试证据和验收结果；生成失败也继续交付文字。
</pegas_visual_diff_instructions>`
