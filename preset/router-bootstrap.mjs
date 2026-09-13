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
 * - 事件读取用 `session.snapshotEvents()`：`session.events` 已在 0.1.2-alpha.4
 *   被 `seq` / `eventAt()` / `snapshotEvents()` 取代，本文件此前读旧属性会抛
 *   TypeError，沿 waterfall 冒泡到 SystemPrompt.assemble()，每轮请求直接失败。
 * - 组件位置：`AssembledSection` 现在是 `{ name, text }`，没有 `order` 可设，
 *   渲染顺序就是 sections 数组顺序，故 persona 用「原位替换」而非追加到末尾。
 * - 运行时上下文（`contexts`）不再清空：本代 dsh 用它下发沙箱模式、工作区根和
 *   审批策略，清掉会让模型看不见权限事实。详见下方返回处的注释。
 */

import {
  applyPersona, coreFor, personaFor, sessionMode, isFlashModel,
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

    // `contexts` 一概不动：它是本代 dsh 传递运行时事实的唯一通道——文件沙箱
    // 模式与工作区根、审批策略都在这里下发（dsh-sandbox-policy 注册
    // `systemPrompt.context`，agent-loop 再折叠成运行时上下文快照）。上游把
    // `contexts` 清空是另一代宿主的"首轮最小化"选择，在这里会让模型既不知道
    // 自己能不能写文件，也不知道审批策略，而工具说明又要求它按沙箱模式决定
    // 是否升级权限——两者必须同时可见。
    if (session.snapshotEvents().some((event) => event.type === 'tool/call')) {
      return { ...assembled, sections } // promoted: full catalog
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
      tools: assembled.tools.filter((tool) => core.has(tool.name)),
    }
  })
}
