/**
 * router-core: reasoning-mode routing logic (zero dependencies).
 *
 * 理论基础（dsh-router-standard 作者实测）：
 * - 模型行为沿 react↔spec 轴坍塌为三个稳定带，不是连续谱：spec [0,0.15]、
 *   transition [0.2,0.45]（不稳定，回避）、react [0.5,1.0]。
 * - 第四个模式 weak（内部路由）：让模型自己按任务选方向，是最强的弱 persona 域。
 * - weak 的最优 persona 依模型而不同（P11）：
 *     pro:   spec 句 + few-shot 路由指令（w6）
 *     flash: neutral + 显式分类指令 + 回顾/收敛/反跑题锚（w7）
 *
 * 本文件只保留路由所需的最小核心。
 */

const SPEC_PERSONA = 'You are a helpful software engineer assistant.'

const MIXED_PERSONA =
  'You are a helpful software engineer assistant.\n'
  + 'Work directly: prefer writing or editing code over describing plans. '
  + 'Verify your changes by reading and running them.'

const REACT_PERSONA =
  'You are a hands-on software engineer who delivers working output fast.\n'
  + 'Work directly: write or edit code, then verify it by reading and running. '
  + 'Keep the loop tight — produce, verify, fix — and do not build test '
  + 'harnesses, scaffolding, or ceremony the user did not ask for. '
  + 'Finish with a usable deliverable and a short summary.'

/** Weak (internal-routing) personas — model-specific optimum (P11/P24).
 *  pro:   spec sentence + classify instruction（w6c）；few-shot/回顾/收敛锚对 Pro 有害。
 *  flash: neutral + classify + recall/converge/anti-runaway anchors（w7）。
 */
const WEAK_PRO =
  'You are a helpful software engineer assistant.\n'
  + 'Before acting, decide the task type (build or fix) and adopt the matching '
  + 'style: build → hands-on production; fix → inspect-and-plan.'

const WEAK_FLASH =
  'You are a helpful assistant.\n'
  + 'Before acting, decide the task type (build or fix) and adopt the matching '
  + 'style: build → hands-on production; fix → inspect-and-plan.\n'
  + 'Before acting, briefly review what you have already done in this session and continue from where you left off; do not repeat completed steps. Do not run environment checks (echo, whoami, uname, node --version, date) or exhaustive grep/glob scans.\n'
  + 'Think deeply about the architecture, edge cases, and integration points before writing. Do not spend reasoning on the environment or tooling. Produce when your information is complete, and end each reasoning block with a decision or an information need.'

/** LongCat (龙猫模型) 专属弱引导：
 *  长上下文容量大，强于多步规划，避免细碎单步往返、前置目录盲查与冗余测试震荡。
 */
const WEAK_LONGCAT =
  'You are a software engineering assistant with strong reasoning capability.\n'
  + 'Before acting, decide the task type (build or fix) and adopt the matching '
  + 'style: build → hands-on production; fix → inspect-and-plan.\n'
  + 'Work directly: write or edit code, and verify with tests.\n'
  + 'Direct production anchor: when asked to create or write a specific file, call write directly without preliminary bash exploration (ls, find, cat, pwd).\n'
  + 'Single verification anchor: once a test passes with exit code 0, do not re-run tests with different runners or arguments. Conclude your turn immediately.'

/** flashGuidance:false 的对照分支：只留中性句——不带分类指令，也不带回顾/收敛/反跑题锚。
 *
 *  不能退回 SPEC_PERSONA 顶替：P11 实测 spec 句对 Flash 是**反向路由**，那会把「没有
 *  引导」变成「反向引导」。中性句才是引导真正缺席时的状态。 */
const FLASH_NEUTRAL =
  'You are a helpful assistant.'

/** 第三方模型（既非 DeepSeek，也非 DeepSeek Flash）的默认句。
 *
 *  为什么不是 w6：w6 的分类指令是在 DeepSeek Pro 上测出来的；gemini / qwen /
 *  gpt / LongCat 一个都没测过。把人设按模型家族搬过去属于外推，而外推的代价
 *  是实打实的——关键词一旦误判，整场会话都戴着错的人设。
 *
 *  为什么不是 w7：w7 的回顾/收敛/反跑题锚同样是为 Flash 调的，见 P11/P21。
 *
 *  这不是默认值：它尚无对照测量支持，只能 opt-in（thirdPartyGuidance: neutral）。
 *  默认仍是 w6 分类——未测的改动不改默认。 */
const THIRD_PARTY_NEUTRAL =
  'You are a helpful assistant.'

/** True when the routed model id names a DeepSeek Flash-family model.
 *
 * 判据是「渠道无关的模型身份」，不是渠道本身：`deepseek` 与 `flash` 两个词都出现
 * 才算命中（`deepseek-v4-flash`、`deepseek-v4-flash-0731`、
 * `deepseek-v4-flash-vision-exp`、`DeepSeek-V4-Flash` 都算）。
 *
 * 只匹配 `flash` 会把别的家族一起卷进来——`gemini-2.5-flash`、`qwen3-flash`、
 * `gpt-5-flash` 都不是 DeepSeek Flash，套上本 preset 的弱 persona 只会让它们变差。
 * 未命中的模型走 `modelFamily()` 的第二、三档（见下），不共用 Flash 的引导。
 *
 * 若某个渠道给同一模型起了不含这两个词的名字，本函数返回 false——是预期降级，
 * 不是故障：非 Flash 的 DeepSeek 家族仍走关键词分类，第三方家族默认拿中性句。 */
export function isFlashModel(modelId) {
  return typeof modelId === 'string' && /deepseek/i.test(modelId) && /flash/i.test(modelId)
}

/** True when the id names any DeepSeek-family model（含 Flash 与 Pro/chat）。 */
export function isDeepSeekModel(modelId) {
  return typeof modelId === 'string' && /deepseek/i.test(modelId)
}

/** True when the id names any LongCat-family model (美团龙猫大模型). */
export function isLongCatModel(modelId) {
  return typeof modelId === 'string' && /longcat/i.test(modelId)
}

/** Four routing families, decided by id alone:
 *
 *  - `flash`        DeepSeek + flash：w7 弱引导 + 首轮收窄 + 卫述前瞻；
 *  - `deepseek`     其余 DeepSeek 家族：w6 分类引导 + 首轮收窄；
 *  - `longcat`      龙猫家族：长上下文高聚焦 + 防反刍 + 卫述前瞻；
 *  - `third-party`  其他开源/第三方家族：默认中性句、不收窄首轮。
 *
 *  家族判定只用于选人设与工具面，不改变工具本身是否可用。
 */
export function modelFamily(modelId) {
  if (isFlashModel(modelId)) return 'flash'
  if (isDeepSeekModel(modelId)) return 'deepseek'
  if (isLongCatModel(modelId)) return 'longcat'
  return 'third-party'
}

export function clamp01(v) {
  return Math.min(1, Math.max(0, Number(v) || 0))
}

/** Quantize a mode to one of the measured behavior bands. */
export function bandOf(mode) {
  if (mode === 'weak') return 'weak'
  const m = clamp01(mode)
  if (m < 0.2) return 'spec'
  if (m < 0.5) return 'transition'
  return 'react'
}

/** Persona for a mode; weak picks the model-specific internal-routing text.
 *
 * `flashGuidance: false` 把 Flash 的弱 persona 降为纯中性句，用来做对照实验。
 * 依据是 apex-standard 记录的 P21：在**连续相关的任务链**上，这套静态引导实测
 * 为负收益（46-63% vs 63% 基线），该 preset 为此提供了同一个开关。
 *
 * 关闭时**不能**退回 SPEC_PERSONA：P11 实测「spec 句 persona 对 Flash 是反向
 * 路由」，那会从「没引导」变成「反向引导」。所以退回的是无分类指令、无锚点的
 * 中性句，也就是引导缺省状态本身。
 */
export function personaFor(mode, modelId, {
  flashGuidance = true,
  thirdPartyGuidance = 'classify',
} = {}) {
  switch (bandOf(mode)) {
    case 'spec': return SPEC_PERSONA
    case 'transition': return MIXED_PERSONA
    case 'weak':
      if (isFlashModel(modelId)) return flashGuidance ? WEAK_FLASH : FLASH_NEUTRAL
      if (isLongCatModel(modelId)) return WEAK_LONGCAT
      // 第三方模型：只有显式 opt-in 才拿中性句；默认仍是 w6（0.4.1 行为）。
      if (modelFamily(modelId) === 'third-party' && thirdPartyGuidance === 'neutral') {
        return THIRD_PARTY_NEUTRAL
      }
      return WEAK_PRO
    default: return REACT_PERSONA
  }
}

/** First-turn core tools (shell added dynamically by the plugin). */
export function coreFor(mode) {
  switch (bandOf(mode)) {
    case 'spec': return ['read', 'edit', 'glob', 'grep']
    case 'transition': return ['read', 'edit', 'write', 'glob', 'grep']
    default: return ['read', 'write', 'edit']
  }
}

const REACT_RE = /(开发|创建|写一个|生成|从零|做一个|游戏|网页|网站|构建|新项目|搭建|实现|做出|上线|落地|脚本|工具|应用|build|create|develop|generate|implement|make a|new project)/gi
const SPEC_RE = /(修复|修一下|调试|重构|维护|排查|报错|出错|崩溃|优化|审查|review|fix|debug|refactor|maintain|repair|broken|break|为什么|异常|故障|迁移|升级|兼容)/gi

function countHits(regex, text) {
  return [...text.matchAll(regex)].length
}

/** Classify a task text into a mode: react(1) / spec(0) / weak（无倾向）。 */
export function classifyTask(text) {
  const react = countHits(REACT_RE, text)
  const spec = countHits(SPEC_RE, text)
  if (react > spec) return 1
  if (spec > react) return 0
  return 'weak'
}

export function extractText(data) {
  if (!data) return ''
  const content = Array.isArray(data.content) ? data.content : []
  return content.map((c) => (typeof c === 'string' ? c : (c.text ?? ''))).join(' ')
}

/**
 * 会话事件读取，跨宿主两代兼容。
 *
 * `session.events` 在 dsh 0.1.2-alpha.4 被 `seq` / `eventAt()` / `snapshotEvents()`
 * 取代；读旧属性在新宿主上会抛 TypeError，沿 waterfall 冒泡到
 * SystemPrompt.assemble()，整轮请求失败。这里做特性探测：有 `snapshotEvents()`
 * 就用它，否则回退 `session.events`，同一份 preset 覆盖
 * 0.1.2-rc.1 ~ 0.1.5-rc.2。
 *
 * @param session - 当前会话。
 * @returns 会话事件的只读视图（`snapshotEvents()` 返回冻结快照）。
 */
export function sessionEvents(session) {
  if (!session) return []
  return typeof session.snapshotEvents === 'function'
    ? session.snapshotEvents()
    : (session.events ?? [])
}

/**
 * 解析当前 Agent 的真实模型 id（跨 0.2.0 ~ 0.2.2+ 宿主）。
 *
 * 优先级：
 *   1. `context.modelSelection.model`（0.2.2+ `dsh-agent-loop` 传给 `systemPrompt.assemble` 的当前步模型）
 *   2. `agent.model.current().model`（`dsh-agent` 的 `modelSelection` 会话投影）
 *   3. 会话事件里最后一条 `model/selection` 或 `request/header`（界面切换模型后的持久事件）
 *   4. `agent.options.model`（会话创建时的静态兜底路由）
 */
export function resolveModelId(agent, context) {
  if (typeof context?.modelSelection?.model === 'string' && context.modelSelection.model !== '') {
    return context.modelSelection.model
  }
  const current = typeof agent?.model?.current === 'function' ? agent.model.current() : undefined
  if (typeof current?.model === 'string' && current.model !== '') {
    return current.model
  }
  if (agent?.session) {
    const events = sessionEvents(agent.session)
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      if (e?.type === 'model/selection' && typeof e.data?.model === 'string' && e.data.model !== '') {
        return e.data.model
      }
      if (e?.type === 'request/header' && typeof e.data?.header?.config?.model === 'string') {
        return e.data.header.config.model
      }
    }
  }
  return agent?.options?.model
}

/**
 * 提取会话首条用户消息文本。
 *
 * 在 DSH `dsh-agent-loop` 中，Turn 1 Step 1 调用 `systemPrompt.assemble()` 时，
 * 首条用户消息刚由 `inbox.claim()` 从 `agent/inbox/spliced` 取出，要到 `step()`
 * 阶段才真正写入 `user/message` 事件。若只查 `user/message`，Step 1 永远返回空串
 * （100% 落入 weak），到 Step 2 才读到消息并翻转人设。这里在 `user/message` 尚未
 * 落盘时回退读取 `agent/inbox/spliced` 的 `inserted` 消息。
 */
export function firstUserText(session) {
  const events = sessionEvents(session)
  const userMsg = events.find(
    (e) => e?.type === 'user/message' && e.data?.source?.kind !== 'runtime-context',
  ) ?? events.find((e) => e?.type === 'user/message')
  if (userMsg) return extractText(userMsg.data)
  for (const e of events) {
    if (e?.type === 'agent/inbox/spliced' && Array.isArray(e.data?.inserted) && e.data.inserted.length > 0) {
      const inserted = e.data.inserted.find((m) => m?.source?.kind === 'user') ?? e.data.inserted[0]
      const text = extractText(inserted)
      if (text) return text
    }
  }
  return ''
}

/** Per-session mode derived from the first user message（非 Flash / 非 LongCat 走这里）。 */
export function sessionMode(session) {
  return classifyTask(firstUserText(session))
}

/** Replace only the persona section, keeping everything else（plan-mode 等）。
 *
 * 原位替换，不追加到末尾：`AssembledSection` 现在是 `{ name, text }`，没有
 * `order` 字段可设，`renderPrompt()` 直接按 sections 数组顺序拼接，所以只有
 * 替换 persona 原本所在的位置（部署 persona prefix，order 0）才能让身份句
 * 仍居 prompt 之首；追加会把它排到全部工具说明之后。
 * 部署 persona 有 prefix/suffix 两段，这里只保留第一段，避免重复段落。 */
export function applyPersona(sections, personaText) {
  const kept = []
  let replaced = false
  for (const section of sections || []) {
    if (!/persona/i.test(section.name)) {
      kept.push(section)
      continue
    }
    if (replaced) continue
    replaced = true
    kept.push({ ...section, text: personaText })
  }
  if (!replaced) kept.unshift({ name: 'router-persona', text: personaText })
  return kept
}

/**
 * ── HarnessMM 决策卫述重用 (GDR) 与回调置换 (CCS) 核心逻辑 ─────────────────
 * 吸收 HarnessMM 原生工程规范，纯 JS 确定性判定，0 额外模型调用，
 * 严格防范代换悖论 (Substitution Paradox)，仅允许物理收据判定，严禁主观语义卫述。
 */

/**
 * 评估工具执行收据 (receipt) 是否满足预设的 Guard 条件。
 * 全面支持 HarnessMM 5 种标准物理卫述：
 * - return_code (兼容 exitCode / exit_code)
 * - stdout_contains
 * - stdout_equals
 * - stderr_empty
 * - json_equals
 *
 * @param {object} guard - 卫述条件定义。
 * @param {object} receipt - 工具实际执行返回的收据对象。
 * @returns {boolean} 卫述是否通过。
 */
export function evaluateGuard(guard, receipt) {
  if (!guard || typeof guard !== 'object' || !receipt) return false
  if (receipt.isError || receipt.is_error) return false

  // 标准退出码 / return_code
  const actualExitCode = receipt.return_code ?? receipt.exitCode ?? receipt.exit_code
  const expectedReturnCode = guard.return_code ?? guard.exitCode ?? guard.exit_code

  if (expectedReturnCode !== undefined) {
    if (actualExitCode !== expectedReturnCode) return false
  }

  // status 字段兼容（如 write 成功）
  if (guard.status !== undefined && receipt.status !== guard.status) {
    return false
  }
  if (guard.condition === 'status == success' && receipt.status !== 'success' && actualExitCode !== 0) {
    return false
  }

  // stdout 包含特定标记
  if (typeof guard.stdout_contains === 'string') {
    const stdout = String(receipt.stdout ?? receipt.output ?? '')
    if (!stdout.includes(guard.stdout_contains)) return false
  }

  // stdout 精确相等
  if (typeof guard.stdout_equals === 'string') {
    const stdout = String(receipt.stdout ?? receipt.output ?? '')
    if (stdout.trim() !== guard.stdout_equals.trim()) return false
  }

  // stderr 为空校验
  if (guard.stderr_empty === true) {
    const stderr = String(receipt.stderr ?? '')
    if (stderr.trim().length > 0) return false
  }

  // json_equals 字段路径比对
  if (guard.json_equals && Array.isArray(guard.json_equals.path)) {
    try {
      let json = receipt.json
      if (!json && typeof receipt.stdout === 'string') {
        json = JSON.parse(receipt.stdout)
      }
      for (const key of guard.json_equals.path) {
        json = json?.[key]
      }
      if (json !== guard.json_equals.value) return false
    } catch {
      return false
    }
  }

  return true
}

/**
 * HarnessMM 局部决策链调度器 (ChiselPlanScheduler)：
 * 支持模型在一次慢思考中前瞻声明多步确定性动作（2~8 步链条），
 * 控制器本地连续置换执行合格节点，直到链路穷尽或卫述不满足。
 */
export class ChiselPlanScheduler {
  constructor(sessionId = 'default-session') {
    this.sessionId = sessionId
    this.queue = []
    this.completedSteps = 0
    this.lastReceipt = null
  }

  /**
   * 注册一组候选节点
   * @param {Array<{ action: object, guard: object }>} candidates
   */
  loadCandidates(candidates) {
    if (!Array.isArray(candidates)) return
    this.queue = candidates.filter((c) => c && c.action && c.guard)
  }

  /**
   * 依据上一步收据推进并获取下一个合规置换动作
   * @param {object} receipt - 上一步工具执行收据。
   * @returns {object|null} 下一个待执行的动作对象，若卫述不满足或队列耗尽则返回 null（安全回退）。
   */
  step(receipt) {
    this.lastReceipt = receipt
    if (this.queue.length === 0) return null
    const nextCandidate = this.queue[0]
    if (evaluateGuard(nextCandidate.guard, receipt)) {
      this.queue.shift()
      this.completedSteps++
      return nextCandidate.action
    }
    // 卫述未通过，安全清空队列，交还大模型慢推理纠错
    this.queue = []
    return null
  }

  /**
   * 是否仍有待置换节点
   */
  hasPending() {
    return this.queue.length > 0
  }
}

/**
 * 构造置换审计凭证 (Substitution Certificate)。
 *
 * @param {object} meta - 凭证元数据。
 * @returns {object}
 */
export function createSubstitutionCertificate({
  sessionId,
  modelId,
  bypassedTool,
  receipt,
  estimatedTokens = 0,
  substitutedSteps = 0,
}) {
  return {
    kind: 'harnessmm/substitution-certificate',
    ts: Date.now(),
    sessionId,
    modelId,
    bypassedTool,
    receiptSummary: receipt?.status ?? 'ok',
    estimatedTokensSaved: estimatedTokens,
    substitutedSteps,
  }
}

/**
 * ── 宿主收据适配 ────────────────────────────────────────────────────────────
 * 把 dsh 的 `ToolExecutionResult` 归一成 `evaluateGuard` 认识的收据。
 *
 * bash 的非零退出码**不是** `isError`（宿主只在 spawn 失败、中止时置 isError，
 * 退出码写在 `value.exitCode` 里），所以这里必须读 canonical value，不能只看
 * isError——否则「测试失败」会被当成「上一步成功」，链条照样往下跑。
 */
export function receiptOf(result) {
  const text = (Array.isArray(result?.content) ? result.content : [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n')
  if (!result || result.isError) {
    return { isError: true, status: 'error', stdout: text, stderr: '' }
  }
  const value = result.value
  if (value && typeof value === 'object' && value.kind === 'foreground') {
    const ok = value.exitCode === 0 && !value.timedOut && !value.aborted && value.signal == null
    return {
      isError: false,
      status: ok ? 'success' : 'failed',
      exitCode: value.exitCode,
      stdout: String(value.stdout?.text ?? ''),
      stderr: String(value.stderr?.text ?? ''),
    }
  }
  if (value && typeof value === 'object' && value.kind === 'promoted') {
    // 转入后台的前台命令：还没结束，不算成功也不算失败。
    return { isError: false, status: 'running', stdout: String(value.output ?? ''), stderr: '' }
  }
  return {
    isError: false,
    status: 'success',
    stdout: text,
    stderr: '',
    ...(value && typeof value === 'object' && !Array.isArray(value) ? { json: value } : {}),
  }
}

/** 默认卫述：上一步成功（无错误、退出码 0 或无退出码）。 */
export const DEFAULT_GUARD = Object.freeze({ status: 'success' })

const GUARD_KEYS = new Set([
  'return_code', 'exitCode', 'exit_code', 'status', 'condition',
  'stdout_contains', 'stdout_equals', 'stderr_empty', 'json_equals',
])

/** 链里不允许出现的工具：自身（防递归）。 */
const CHAIN_FORBIDDEN = new Set(['run_chain'])

export const CHAIN_MIN_STEPS = 2
export const CHAIN_MAX_STEPS = 8

/**
 * 校验并规范化 `run_chain` 的参数。返回 `{ steps }` 或 `{ error }`。
 *
 * 卫述里的未知键必须拒绝：`evaluateGuard` 对它不认识的键一律放行，模型拼错
 * 一个键（`exitcode`）就等于「无条件继续」——那正是链条最不该有的失败模式。
 */
export function validateChainArgs(args) {
  const steps = args?.steps
  if (!Array.isArray(steps)) return { error: 'steps must be an array' }
  if (steps.length < CHAIN_MIN_STEPS || steps.length > CHAIN_MAX_STEPS) {
    return { error: `steps must contain ${CHAIN_MIN_STEPS}-${CHAIN_MAX_STEPS} entries (got ${steps.length})` }
  }
  const out = []
  for (const [index, step] of steps.entries()) {
    const at = `steps[${index}]`
    if (!step || typeof step !== 'object' || Array.isArray(step)) return { error: `${at} must be an object` }
    if (typeof step.tool !== 'string' || step.tool.trim() === '') return { error: `${at}.tool must be a non-empty string` }
    if (CHAIN_FORBIDDEN.has(step.tool)) return { error: `${at}.tool "${step.tool}" cannot be chained` }
    const toolArgs = step.args ?? {}
    if (typeof toolArgs !== 'object' || Array.isArray(toolArgs)) return { error: `${at}.args must be an object` }
    if (index === 0 && step.when !== undefined) {
      return { error: 'steps[0].when is not allowed: the first step has no previous result to check' }
    }
    let guard = DEFAULT_GUARD
    if (step.when !== undefined) {
      if (!step.when || typeof step.when !== 'object' || Array.isArray(step.when)) {
        return { error: `${at}.when must be an object` }
      }
      const unknown = Object.keys(step.when).filter((key) => !GUARD_KEYS.has(key))
      if (unknown.length > 0) {
        return { error: `${at}.when has unknown keys: ${unknown.join(', ')} (allowed: ${[...GUARD_KEYS].join(', ')})` }
      }
      if (Object.keys(step.when).length === 0) return { error: `${at}.when must not be empty` }
      guard = step.when
    }
    out.push({ action: { tool: step.tool, args: toolArgs }, guard })
  }
  return { steps: out }
}
