import { describe, expect, it } from 'vitest'
import {
  answerFollowUps,
  splitAnswerFollowUps,
} from '../src/conversation/follow-ups.js'

const suffix =
  '\nPEGAS_QUESTIONS_BEGIN\n["冬季哪些口味销量最好？", "比较两种产品的毛利率"]\nPEGAS_QUESTIONS_END'

describe('DESIGN-009 contextual follow-ups', () => {
  it('extracts optional questions without changing an ordinary answer', () => {
    expect(splitAnswerFollowUps('销售分析。' + suffix)).toEqual({
      text: '销售分析。',
      followUps: ['冬季哪些口味销量最好？', '比较两种产品的毛利率'],
    })
    expect(splitAnswerFollowUps('已经完成。')).toEqual({
      text: '已经完成。',
      followUps: [],
    })
    expect(splitAnswerFollowUps('引用 PEGAS_QUESTIONS_BEGIN 这个名字')).toEqual(
      { text: '引用 PEGAS_QUESTIONS_BEGIN 这个名字', followUps: [] },
    )
  })
  it('fails open for the answer and closed for malformed or excessive suggestions', () => {
    for (const data of [
      'not json',
      '{}',
      '[1]',
      '[" "]',
      JSON.stringify(['a'.repeat(161)]),
      JSON.stringify(['a', 'b', 'c', 'd']),
      '[]',
    ]) {
      expect(
        splitAnswerFollowUps(
          `正文\nPEGAS_QUESTIONS_BEGIN\n${data}\nPEGAS_QUESTIONS_END`,
        ),
      ).toEqual({ text: '正文', followUps: [] })
    }
    expect(
      splitAnswerFollowUps('正文\nPEGAS_QUESTIONS_BEGIN\n["未完成'),
    ).toEqual({ text: '正文', followUps: [] })
    expect(splitAnswerFollowUps('正文' + suffix + '\n其他正文')).toEqual({
      text: '正文',
      followUps: [],
    })
  })
  it('never reveals a partial protocol suffix during streaming', () => {
    const output = '正文' + suffix
    for (let end = 2; end <= output.length; end++) {
      const parsed = splitAnswerFollowUps(output.slice(0, end), true)
      expect(parsed.text.trimEnd()).toBe('正文')
      expect(parsed.followUps).toEqual([])
    }
  })
  it('validates persisted metadata and deduplicates questions', () => {
    expect(
      answerFollowUps({ followUps: [' 为什么？ ', '为什么？', '对比成本'] }),
    ).toEqual(['为什么？', '对比成本'])
    for (const payload of [
      null,
      {},
      { followUps: 'text' },
      { streaming: true, followUps: ['问题'] },
      { followUps: ['x\ny'] },
    ])
      expect(answerFollowUps(payload)).toEqual([])
  })
})
