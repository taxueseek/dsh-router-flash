/**
 * router-bootstrap: 探索模式 —— DeepSeek V4 Flash 的任务分类与工具面路由（渠道无关）。
 *
 * 在 system-prompt/assemble 阶段，把 DeepSeek Flash 模型（模型 id 同时含
 * "deepseek" 与 "flash"，不看 provider）强制路由到 weak 模式（作者
 * dsh-router-standard 实测 w7 最优解），注入对应的 WEAK_FLASH persona，首轮只
 * 暴露 core 工具集，首次 tool call 后放开全目录。opencode-go 只是已验证渠道之一。
 *
 * dsh 0.1.5-rc.2 适配说明：
 * - 作者原版的"近距离引导"依赖 `ctx.on('session/event')` + `target.inbox.append`，
 *   在 0.1.0-rc.6 上就已失效（session/event 是 session-scoped、agent 对象无 inbox、
 *   assemble 时事件尚未落盘）。故改为把深度引导静态并入 WEAK_FLASH persona
 *   （见 router-core.mjs），不依赖动态注入。
 * - 事件读取走 `sessionEvents()` 特性探测（`snapshotEvents()` 优先，回退
 *   `session.events`）：`session.events` 在 0.1.2-alpha.4 被
 *   `seq` / `eventAt()` / `snapshotEvents()` 取代，直接读旧属性会抛 TypeError，
 *   沿 waterfall 冒泡到 SystemPrompt.assemble()，每轮请求直接失败。
 * - 组件位置：`AssembledSection` 现在是 `{ name, text }`，没有 `order` 可设，
 *   渲染顺序就是 sections 数组顺序，故 persona 用「原位替换」而非追加到末尾
 *   （追加会把身份句甩到全部工具说明之后，实测如此）。
 * - `contexts: []` 保持上游原样，理由见下方返回处注释。
 */

import {
  applyPersona, coreFor, firstUserText, modelFamily, personaFor, resolveModelId, sessionEvents, sessionMode,
} from './router-core.mjs'
import { chainToolDefinition } from './harnessmm-runtime.mjs'


/** Cordis plugin name used by loader diagnostics. */
export const name = 'router-bootstrap'

/** Prompt assembly and the tools registry must exist. */
export const inject = ['systemPrompt', 'tools']

export function apply(ctx, config = {}) {
  // Flash 的引导开关（默认 true＝w7）。false 只影响 Flash 的 weak 分支（见 router-core）。
  const flashGuidance = config.flashGuidance !== false
  // 第三方模型（非 DeepSeek 家族）的人设策略：
  //   classify（默认）——保持 0.4.1 的行为：首条消息关键词分类选 w6/spec/react；
  //   neutral        ——中性句（可选，尚无对照测量支持，故不做默认）。
  // 两种策略都放开首轮工具面：收窄会造成「提示词教 glob/grep、schema 里却没有」，
  // 这一点在 13 个历史第三方会话里 13 次复现（scripts/replay-routing.mjs）。
  const thirdPartyGuidance = config.thirdPartyGuidance === 'neutral' ? 'neutral' : 'classify'

  // ── 首轮工具面收窄与会话锁定状态（0.2.2 起的原生路径）──────────────────────
  // 0.2.2-alpha.2 起 `system-prompt/assemble` 的载荷是 PromptPresentation：
  // 只有 sections / contexts / variables，**不再有 tools**（工具声明归 provider，
  // 且步级 toolSet 在 pre-step 之前就已由 tools.resolve() 解析完成）。官方口径
  // 是「隐藏某个 agent 的工具用 ctx.tools.restrict()」——所以在 agent 创建以及
  // 首轮 turn/start、model/selection 时登记收窄，首次工具结果后解除；assemble 只负责
  // 人设与上下文。旧宿主（≤0.2.1）的 assemble 仍携带 tools，保留原过滤路径。
  const narrowed = new WeakMap()
  const lockedModes = new WeakMap()
  const agentsBySession = new WeakMap()
  const canRestrict = typeof ctx.tools?.restrict === 'function'

  const liftRestriction = (agent) => {
    const entry = narrowed.get(agent)
    if (entry === undefined) return
    narrowed.delete(agent)
    try { entry.dispose() } catch {}
  }

  const modeForAgent = (agent, modelId, family = modelFamily(modelId)) => {
    const thirdPartyNeutral = family === 'third-party' && thirdPartyGuidance === 'neutral'
    if (family === 'flash' || family === 'longcat' || thirdPartyNeutral) return 'weak'
    if (agent && lockedModes.has(agent)) return lockedModes.get(agent)
    const session = agent?.session
    const computed = sessionMode(session)
    if (agent && firstUserText(session) !== '') {
      lockedModes.set(agent, computed)
    }
    return computed
  }

  const applyFirstTurnRestriction = (agent, context) => {
    if (!canRestrict || agent === undefined || agent === null) return
    if (agent.session && typeof agent.session === 'object') {
      agentsBySession.set(agent.session, agent)
    }
    try {
      if (sessionEvents(agent.session).some((event) => event.type === 'tool/call')) {
        liftRestriction(agent)
        return
      }
      const modelId = resolveModelId(agent, context)
      const family = modelFamily(modelId)
      if (family === 'third-party') {
        liftRestriction(agent)
        return
      }
      const mode = modeForAgent(agent, modelId, family)
      const tools = agent.ctx?.tools
      if (tools === undefined) return
      const visible = (tool) => tools.get(tool, agent) !== undefined
      const allow = coreFor(mode).filter(visible)
      if (visible('pwsh')) allow.push('pwsh')
      else if (visible('bash')) allow.push('bash')
      if (allow.length === 0) {
        ctx.logger?.info?.(`${name}: first-turn restriction skipped (no core tools visible yet)`)
        return
      }
      const key = allow.join(',')
      const existing = narrowed.get(agent)
      if (existing?.key === key) return
      if (existing !== undefined) liftRestriction(agent)
      const dispose = tools.restrict({ allow })
      narrowed.set(agent, {
        dispose: typeof dispose === 'function' ? dispose : () => {},
        key,
      })
      ctx.logger?.info?.(`${name}: first-turn restriction ${key} (${modelId})`)
    } catch (error) {
      ctx.logger?.warn(`${name}: first-turn tool restriction skipped: ${String(error)}`)
    }
  }

  ctx.on('agent/created', ({ agent }) => {
    applyFirstTurnRestriction(agent)
  })

  // 用户在 Web UI 首轮发送消息前切模型（model/selection），或首轮进入 pre-step（turn/start）
  // 时，重新按当前模型与首条消息校准首轮工具面收窄，避免 agent/created 时的默认模型陈旧。
  ctx.on('session/event', (session, event) => {
    const type = event?.type
    if (type !== 'model/selection' && type !== 'turn/start') return
    const agent = agentsBySession.get(session)
    if (agent !== undefined) applyFirstTurnRestriction(agent)
  })

  ctx.on('tools/result', (exec) => {
    liftRestriction(exec?.agent)
  })

  // ── HarnessMM 运行层（0.6.0，默认关）──────────────────────────────────────
  // run_chain：模型声明的确定性链，每步经 ctx.tools.execute 走完整审批管线。
  // 注册为全局工具，所以首轮收窄（allow 清单不含它）自然把它藏到首次工具结果之后。
  if (config.chain === true && typeof ctx.tools?.register === 'function') {
    try {
      ctx.tools.register(chainToolDefinition({ ctx, name, logger: ctx.logger }))
    } catch (error) {
      ctx.logger?.warn?.(`${name}: run_chain not registered: ${String(error)}`)
    }
  }
  // 重复命令检测统一交给 dsh-turn-guard 规则 6（0.6.1 起移除本插件的 repeatNotice）。

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const agent = context.agent
    if (agent === undefined) return assembled
    const session = agent.session
    if (session && typeof session === 'object') {
      agentsBySession.set(session, agent)
    }

    const modelId = resolveModelId(agent, context)
    const family = modelFamily(modelId)
    const thirdParty = family === 'third-party'
    // DeepSeek Flash / LongCat 一律走 weak；其余家族走首条消息分类并在会话内锁定。
    const mode = modeForAgent(agent, modelId, family)
    const persona = personaFor(mode, modelId, { flashGuidance, thirdPartyGuidance })

    // persona 全程不变；只有工具面在首次 tool call 后放开全目录。
    const sections = applyPersona(assembled.sections, persona)

    // `contexts: []` 是上游行为，保持不变：本 preset 的全部测量都围绕「首轮请求
    // 要干净」——运行时上下文快照（文件沙箱模式、工作区根、审批策略）在每次请求
    // 都会注入约 470 字符，去掉它会直接改动最敏感的那一轮。要放行它需要测量，
    // 目前没有任何测量支持；想要这份可见性的部署应自行决定（见 README）。
    // 第三方模型一律不收窄首轮：收窄是为 Flash 的「首轮聚焦」服务的，但在第三方
    // 会话上它只造成「提示词教 glob/grep、schema 里没有」的不一致（历史 13/13 复现）。
    // 这是本次唯一按测量改掉的行为；人设仍默认按分类走，未测的部分不动。
    //
    // `assembled.tools` 缺失 = 0.2.2+ 宿主：工具声明归 provider，assemble 只拿到
    // PromptPresentation（sections/contexts/variables）。此时收窄已由 agent 创建时
    // 的 tools.restrict() 负责（见本文件上方），这里不再触碰 tools——旧版在这里
    // 读 `assembled.tools.map(...)` 会抛 TypeError，让整轮请求失败。
    if (thirdParty
      || !Array.isArray(assembled.tools)
      || sessionEvents(session).some((event) => event.type === 'tool/call')) {
      return { ...assembled, sections, contexts: [] } // full catalog
    }

    // 平台 shell 只在这一轮的工具面里补齐；找不到就降级并告警，不抛错。
    // 抛错会沿 waterfall 冒泡到 SystemPrompt.assemble()，让整轮请求失败——
    // 一个「工具面少了 bash」的部署问题不该变成模型完全不能用。降级后首轮只有
    // read/write/edit，晋级后恢复完整目录，宿主日志里留下原因。
    const core = new Set(coreFor(mode))
    const available = new Set(assembled.tools.map((tool) => tool.name))
    const shell = available.has('pwsh') ? 'pwsh' : available.has('bash') ? 'bash' : null
    if (shell === null) {
      ctx.logger?.warn(
        `${name}: no bash/pwsh in the tool catalog; first-turn face keeps file tools only`,
      )
    } else {
      core.add(shell)
    }

    return {
      ...assembled,
      sections,
      contexts: [],
      tools: assembled.tools.filter((tool) => core.has(tool.name)),
    }
  })
}
