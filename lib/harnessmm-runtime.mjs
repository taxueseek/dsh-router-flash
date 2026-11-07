/**
 * harnessmm-runtime：把 HarnessMM 决策重用层接到 dsh 宿主上（0.6.0 起）。
 *
 * 0.5.x 只带了判定逻辑，没有声明通道，也没有执行器：`loadCandidates()` 从未被
 * 调用，`tools/result` 里的调度分支永远不会进入。这个模块补上三样东西：
 *
 *   1. 声明通道：`run_chain` 工具。模型一次声明 2-8 步确定性动作，每步可带卫述
 *      （`when`），省掉中间每一步的模型往返。
 *   2. 执行器：每一步都经 `ctx.tools.execute()` 走宿主完整管线——`tools/pre-execute`
 *      审批、`tools.guard()`、沙箱、超时、`tools/post-execute`。**本模块不直接执行
 *      任何命令**，也不能绕过审批：被拒的步骤和失败的步骤一样，停链、交还模型。
 *   3. 审计：每次链条结束都写一条 `harnessmm/substitution-certificate` 日志，并把
 *      每步的收据摘要写进返回值，模型和用户都看得到跑了什么、在哪一步停下。
 *
 * 默认关（`chain: false`）：它改变模型可见的工具面，按本仓库规则，未经对照测量的
 * 改动不做默认。打开方式见 README。
 *
 * 重复命令检测不在这里：0.6.1 起统一交给 dsh-turn-guard 的规则 6（Shell 输出复用），
 * 一处判重，避免宿主提醒、turn-guard、本插件三处重叠。
 */

import {
  CHAIN_MAX_STEPS, CHAIN_MIN_STEPS, ChiselPlanScheduler,
  createSubstitutionCertificate, receiptOf, resolveModelId, validateChainArgs,
} from './router-core.mjs'

const STEP_TEXT_LIMIT = 4000
const CHAIN_TOOL = 'run_chain'

const CHAIN_DESCRIPTION = [
  'Run 2-8 tool calls in order without a model round-trip between them.',
  'Use it only when every step and its arguments are already fully decided, for example',
  '"write file → run its test" or "build → run → check output".',
  'Each step after the first runs only if the previous step passes its `when` check',
  '(default: previous step succeeded, i.e. no error and exit code 0).',
  'The chain stops at the first failed check, failed step, or denied approval, and returns every result so far.',
  'Every step goes through normal approval; nothing is skipped.',
  'Do not use it when a later step depends on reading an earlier result.',
].join(' ')

/** 卫述的 schema（只用宿主支持的 JSON Schema 子集）。 */
const WHEN_SCHEMA = {
  type: 'object',
  description: 'Condition on the previous step result. Omit for "previous step succeeded".',
  additionalProperties: false,
  properties: {
    exitCode: { type: 'integer', description: 'Required exit code of the previous shell step.' },
    status: { type: 'string', enum: ['success', 'failed'], description: 'Required status of the previous step.' },
    stdout_contains: { type: 'string', description: 'Previous output must contain this text.' },
    stdout_equals: { type: 'string', description: 'Previous output must equal this text (trimmed).' },
    stderr_empty: { type: 'boolean', description: 'Previous stderr must be empty.' },
  },
}

const CHAIN_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['steps'],
  properties: {
    steps: {
      type: 'array',
      description: `${CHAIN_MIN_STEPS}-${CHAIN_MAX_STEPS} steps, executed in order.`,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['tool', 'args'],
        properties: {
          tool: { type: 'string', description: 'Name of a tool you could call directly.' },
          args: { type: 'object', description: 'Exact arguments for that tool.' },
          when: WHEN_SCHEMA,
        },
      },
    },
  },
}

const STEP_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['index', 'tool', 'outcome'],
  properties: {
    index: { type: 'integer' },
    tool: { type: 'string' },
    outcome: { type: 'string', enum: ['ok', 'failed', 'denied', 'guard-failed', 'skipped'] },
    exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
    text: { type: 'string' },
  },
}

const CHAIN_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  required: ['completed', 'total', 'stoppedAt', 'steps'],
  properties: {
    completed: { type: 'integer' },
    total: { type: 'integer' },
    stoppedAt: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
    reason: { type: 'string' },
    steps: { type: 'array', items: STEP_OUTPUT },
  },
}

function clip(text) {
  const s = String(text ?? '')
  return s.length > STEP_TEXT_LIMIT ? `${s.slice(0, STEP_TEXT_LIMIT)}\n[... ${s.length - STEP_TEXT_LIMIT} chars clipped]` : s
}

function resultText(result) {
  return (Array.isArray(result?.content) ? result.content : [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

/** 把链条结果渲染成模型看到的文本。 */
export function renderChain(value) {
  const lines = [`run_chain: ${value.completed}/${value.total} steps completed`
    + (value.stoppedAt === null ? '' : `, stopped at step ${value.stoppedAt + 1}${value.reason ? ` (${value.reason})` : ''}`)]
  for (const step of value.steps) {
    const code = step.exitCode === undefined || step.exitCode === null ? '' : ` exit=${step.exitCode}`
    lines.push(`\n--- step ${step.index + 1}: ${step.tool} [${step.outcome}${code}]`)
    if (step.text) lines.push(step.text)
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * 执行一条已校验的链。`dispatch(step, index)` 负责真正调用工具并返回宿主的
 * `ToolExecutionResult`（生产环境走 `ctx.tools.execute`，测试里可注入）。
 *
 * 推进逻辑复用 HarnessMM 的 `ChiselPlanScheduler`：第一步由模型直接发起（没有
 * 上一步可判），其余步骤装入调度器，每拿到一个收据就 `step()` 一次；卫述不过
 * 时调度器清空队列并返回 null，链在此停下。
 */
export async function runChain(steps, dispatch, { signal } = {}) {
  const out = []
  const scheduler = new ChiselPlanScheduler()
  scheduler.loadCandidates(steps.slice(1))
  let action = steps[0].action
  let index = 0
  let stoppedAt = null
  let reason
  while (action) {
    if (signal?.aborted) {
      stoppedAt = index
      reason = 'cancelled'
      break
    }
    let result
    try {
      result = await dispatch({ action }, index)
    } catch (error) {
      out.push({ index, tool: action.tool, outcome: 'failed', text: clip(String(error?.message ?? error)) })
      stoppedAt = index
      reason = 'dispatch error'
      break
    }
    const receipt = receiptOf(result)
    const denied = result?.isError === true && /denied|approval|not allowed|blocked/i.test(result?.error?.message ?? '')
    out.push({
      index,
      tool: action.tool,
      outcome: denied ? 'denied' : receipt.status === 'success' ? 'ok' : 'failed',
      ...(receipt.exitCode !== undefined ? { exitCode: receipt.exitCode } : {}),
      text: clip(resultText(result)),
    })
    if (result?.isError) {
      stoppedAt = index
      reason = denied ? 'approval denied' : 'step error'
      break
    }
    if (index + 1 >= steps.length) break
    const pendingGuard = steps[index + 1].guard
    action = scheduler.step(receipt)
    index += 1
    if (action === null) {
      out.push({ index, tool: steps[index].action.tool, outcome: 'guard-failed', text: `when ${JSON.stringify(pendingGuard)} not met` })
      stoppedAt = index
      reason = 'condition not met'
    }
  }
  const completed = out.filter((s) => s.outcome === 'ok' || s.outcome === 'failed').length
  for (let i = out.length; i < steps.length; i++) {
    out.push({ index: i, tool: steps[i].action.tool, outcome: 'skipped' })
  }
  return {
    completed,
    total: steps.length,
    stoppedAt,
    ...(reason ? { reason } : {}),
    steps: out,
  }
}

/** 构造 `run_chain` 工具定义（宿主 ToolDefinition 形状，不依赖 dsh-tools 包）。 */
export function chainToolDefinition({ ctx, name, logger }) {
  return {
    name: CHAIN_TOOL,
    description: CHAIN_DESCRIPTION,
    parameters: CHAIN_PARAMETERS,
    output: {
      schema: CHAIN_OUTPUT,
      render: (_args, value) => renderChain(value),
    },
    async execute(args, exec) {
      const checked = validateChainArgs(args)
      if (checked.error) throw new Error(`run_chain: ${checked.error}`)
      const agent = exec.agent
      const tools = agent?.ctx?.tools ?? ctx.tools
      const dispatch = async (step, index) => {
        const batch = await tools.execute({
          calls: [{
            type: 'tool-call',
            id: `${exec.callId}:chain:${index}`,
            name: step.action.tool,
            arguments: JSON.stringify(step.action.args),
          }],
          signal: exec.signal,
          ...(agent ? { agent } : {}),
          ...(exec.toolSet ? { toolSet: exec.toolSet } : {}),
        })
        return batch.results[0]?.result
      }
      const value = await runChain(checked.steps, dispatch, { signal: exec.signal })
      // 被置换掉的模型往返 = 完成的步数 - 1（第一步本来就要模型发起）。
      const substituted = Math.max(0, value.completed - 1)
      const modelId = resolveModelId(agent)
      const cert = createSubstitutionCertificate({
        sessionId: agent?.session?.id,
        modelId,
        bypassedTool: checked.steps.map((s) => s.action.tool).join('>'),
        receipt: { status: value.stoppedAt === null ? 'success' : value.reason },
        substitutedSteps: substituted,
      })
      logger?.info?.(`${name}: ${JSON.stringify(cert)}`)
      return value
    },
  }
}
