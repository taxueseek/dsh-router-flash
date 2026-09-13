/**
 * router-bootstrap: DeepSeek V4 Flash 神模式引导（渠道无关）。
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
  applyPersona, coreFor, personaFor, sessionEvents, sessionMode, isFlashModel,
} from './router-core.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'router-bootstrap'

/** Prompt assembly and the tools registry must exist. */
export const inject = ['systemPrompt', 'tools']

export function apply(ctx, config) {
  const overrides = new Map() // session id -> explicit mode（预留，供未来外部调优）

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const agent = context.agent
    if (agent === undefined) return assembled
    const session = agent.session

    const modelId = agent.options?.model
    // DeepSeek Flash 一律走 weak（作者 w7 最优解）；其他模型走关键词分类。
    const mode = overrides.get(session.id)
      ?? (isFlashModel(modelId) ? 'weak' : sessionMode(session))
    const persona = personaFor(mode, modelId)

    // persona 全程不变；只有工具面在首次 tool call 后放开全目录。
    const sections = applyPersona(assembled.sections, persona)

    // `contexts: []` 是上游行为，保持不变：本 preset 的全部测量都围绕「首轮请求
    // 要干净」——运行时上下文快照（文件沙箱模式、工作区根、审批策略）在每次请求
    // 都会注入约 470 字符，去掉它会直接改动最敏感的那一轮。要放行它需要测量，
    // 目前没有任何测量支持；想要这份可见性的部署应自行决定（见 README）。
    if (sessionEvents(session).some((event) => event.type === 'tool/call')) {
      return { ...assembled, sections, contexts: [] } // promoted: full catalog
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
