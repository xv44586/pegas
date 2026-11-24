import { parseModelReconciliationVerdict } from './action-reconciliation.js'
import type {
  ModelReconciliationInput,
  ModelReconciliationVerdict,
} from './action-reconciliation.js'
import type { JsonModelProvider } from '../model/provider.js'
import type { Logger } from './logger.js'

const reconciliationPolicy = [
  '你是 Pegas 的副作用对账审阅器。一个已获用户批准的 bash 命令执行后,',
  '执行器没能上报结果,你需要根据证据判断写入副作用是否已经发生。',
  '你只做判定,绝不建议重新执行命令,也绝不执行任何命令。',
  '证据包括:用户的任务目标、命令原文、每个目标文件的现状(存在性、大小、',
  '修改时间,以及不超过 8KB 的当前全文)。',
  '判定标准:',
  '- succeeded:现有证据能明确说明命令的预期写入效果已经发生',
  '(例如目标内容包含命令应产生的结果、或目标确已按命令语义消失)。',
  '- failed:现有证据能明确说明预期写入没有发生(例如应写入的目标不存在)。',
  '- inconclusive:证据不足以确认任何一边,或命令效果无法从文件现状推断。',
  '文件存在不等于写入成功:必须对照命令语义与内容判断。',
  '拿不准就返回 inconclusive,宁可留给人工也不猜测。',
  '只输出一个 JSON 对象,形状为',
  '{"resolution":"succeeded"|"failed"|"inconclusive","reason":"中文说明,不超过500字"}。',
].join('\n')

export function createModelReconciliationJudge(options: {
  provider: () => JsonModelProvider
  logger?: Logger
}): (input: ModelReconciliationInput) => Promise<ModelReconciliationVerdict> {
  return async input => {
    const provider = options.provider()
    const value = await provider.generateJson({
      system: reconciliationPolicy,
      input: JSON.stringify(input),
    })
    const verdict = parseModelReconciliationVerdict(value)
    if (!verdict) {
      options.logger?.warn('action.model_reconcile_malformed', {
        provider: provider.name,
      })
      return { resolution: 'inconclusive', reason: '模型输出形状不符' }
    }
    return verdict
  }
}
