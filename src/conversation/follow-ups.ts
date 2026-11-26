const BEGIN = 'PEGAS_QUESTIONS_BEGIN'
const END = 'PEGAS_QUESTIONS_END'

/** Optional answer metadata, never an action or an authorization. */
export const answerFollowUpsContract = `在最终答案后，仅当有值得用户进一步深入的具体方向时，可附 1–3 条简短追问；以用户口吻表达，与本次内容直接相关，不重复已回答的问题，不用“还有什么需要帮助”等通用套话。不必每轮给建议，简单答复、任务升级、等待审批或澄清时省略。追问限只读分析、比较、解释，不建议发送消息、修改文件、发布等外部操作，不承诺执行。每条最多 160 字、单行。用以下独立行作为答案末尾元数据（不是正文，不要放进代码围栏）：
${BEGIN}
["具体的深入问题"]
${END}
这些追问只是供用户选择的草稿，必须等用户明确发送后才回答；它们不是定时 Follow-up，不得调用调度 API。没有建议时完全省略这段。`

function questions(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 3) return []
  if (
    value.some(
      item =>
        typeof item !== 'string' ||
        !item.trim() ||
        item.trim().length > 160 ||
        /[\r\n]/.test(item),
    )
  )
    return []
  return [...new Set((value as string[]).map(item => item.trim()))]
}

export function answerFollowUps(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    return []
  const record = payload as Record<string, unknown>
  return record.streaming === true ? [] : questions(record.followUps)
}

/** Hide protocol data (including incomplete streaming prefixes) from the body. */
export function splitAnswerFollowUps(
  text: string,
  streaming = false,
): { text: string; followUps: string[] } {
  const match = /(?:^|\n)PEGAS_QUESTIONS_BEGIN(?:\r?\n|$)/.exec(text)
  if (match) {
    const body = text.slice(0, match.index).trimEnd()
    if (streaming) return { text: body, followUps: [] }
    const tail = text.slice(match.index + match[0].length)
    const end = tail.lastIndexOf('\n' + END)
    if (end < 0 || tail.slice(end).trim() !== END)
      return { text: body, followUps: [] }
    try {
      return {
        text: body,
        followUps: body.trim() ? questions(JSON.parse(tail.slice(0, end))) : [],
      }
    } catch {
      return { text: body, followUps: [] }
    }
  }
  if (streaming) {
    const line = text.slice(text.lastIndexOf('\n') + 1)
    if (line && BEGIN.startsWith(line))
      return {
        text: text.slice(0, text.length - line.length).trimEnd(),
        followUps: [],
      }
  }
  return { text, followUps: [] }
}
