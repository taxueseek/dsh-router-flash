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

/** True when the routed model id names a DeepSeek Flash-family model.
 *
 * 判据是「渠道无关的模型身份」，不是渠道本身：`deepseek` 与 `flash` 两个词都出现
 * 才算命中（`deepseek-v4-flash`、`deepseek-v4-flash-0731`、
 * `deepseek-v4-flash-vision-exp`、`DeepSeek-V4-Flash` 都算）。
 *
 * 只匹配 `flash` 会把别的家族一起卷进来——`gemini-2.5-flash`、`qwen3-flash`、
 * `gpt-5-flash` 都不是 DeepSeek Flash，套上本 preset 的弱 persona 只会让它们变差。
 * 未命中的模型不走 Flash 分支，改走首条用户消息的关键词分类，仍可用。
 *
 * 若某个渠道给同一模型起了不含这两个词的名字，本函数返回 false，路由退回关键词
 * 分类——是预期降级，不是故障。 */
export function isFlashModel(modelId) {
  return typeof modelId === 'string' && /deepseek/i.test(modelId) && /flash/i.test(modelId)
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
export function personaFor(mode, modelId, { flashGuidance = true } = {}) {
  switch (bandOf(mode)) {
    case 'spec': return SPEC_PERSONA
    case 'transition': return MIXED_PERSONA
    case 'weak':
      if (!isFlashModel(modelId)) return WEAK_PRO
      return flashGuidance ? WEAK_FLASH : FLASH_NEUTRAL
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
  return typeof session.snapshotEvents === 'function'
    ? session.snapshotEvents()
    : session.events
}

/** Per-session mode derived from the first user message（非 Flash 走这里）。 */
export function sessionMode(session) {
  const events = sessionEvents(session)
  const userMsg = events.find((e) => e.type === 'user/message')
  return classifyTask(extractText(userMsg?.data))
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
