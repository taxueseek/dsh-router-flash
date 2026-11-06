/**
 * router-core / router-bootstrap 回归自检（node preset/router.test.mjs）。
 *
 * 覆盖不依赖模型的纯逻辑分支：
 *   1. 模型识别：DeepSeek Flash 命中，同名「flash」的其他家族不命中；
 *   2. persona 原位替换（顺序、去重、plan-mode 段保留）；
 *   3. 工具面：首轮只留 core + 平台 shell，出现 tool/call 后放开全目录；
 *   4. 运行时上下文不被清空；
 *   5. 家族路由：DeepSeek 非 Flash 走关键词分类；第三方默认中性句 + 全目录，
 *      只有 thirdPartyGuidance:'classify' 才回到分类 + 首轮收窄；
 *   6. `session.events` 已不存在时不再被读取（读旧属性会抛 TypeError）；
 *   7. 工具目录里没有 shell 时降级告警，而不是让整轮装配失败；
 *   8. 组合覆盖宿主交还给 preset 的每一行（防止「没写一行」变成静默裁能力）；
 *   9. 交付形态自洽：声明行 id / config.id / 包子路径引用（搬迁到声明行之后）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  applyPersona, coreFor, createSubstitutionCertificate, evaluateGuard,
  isDeepSeekModel, isFlashModel, isLongCatModel, isRedundantVerification,
  modelFamily, personaFor, sessionEvents, sessionMode, shouldBypassCallback,
  ChiselPlanScheduler,
} from '../lib/router-core.mjs'
import { apply } from '../lib/router-bootstrap.mjs'

// --- 1. 模型识别：渠道无关，只认 DeepSeek 家族的 flash ----------------------
for (const id of [
  'deepseek-v4-flash',
  'deepseek-v4-flash-0731',
  'deepseek-v4-flash-vision-exp',
  'DeepSeek-V4-Flash',
  'deepseek-flash',
  'opencode-go/deepseek-v4-flash',
]) {
  assert.equal(isFlashModel(id), true, `${id} 应命中 DeepSeek Flash`)
}
for (const id of [
  'deepseek-v4-pro',
  'deepseek-chat',
  'deepseek-v4-0324',
  'gemini-2.5-flash',
  'qwen3-flash',
  'gpt-5-flash',
  'kimi-k2.5',
  'glm-5.3',
  undefined,
  null,
  '',
  42,
]) {
  assert.equal(isFlashModel(id), false, `${String(id)} 不应命中 DeepSeek Flash`)
}

// 家族判定：四分支，只按 id
assert.equal(modelFamily('deepseek-v4-flash'), 'flash')
assert.equal(modelFamily('deepseek-v4-pro'), 'deepseek')
assert.equal(modelFamily('auto/longcat-2.0'), 'longcat')
assert.equal(modelFamily('longcat-2/LongCat-2.0'), 'longcat')
assert.equal(modelFamily('LongCat-2.5'), 'longcat')
assert.equal(modelFamily('gemini-2.5-flash'), 'third-party')
assert.equal(modelFamily('kimi-k2.5'), 'third-party')
assert.equal(modelFamily(undefined), 'third-party')
assert.equal(isDeepSeekModel('deepseek-v4-pro'), true)
assert.equal(isDeepSeekModel('gemini-2.5-flash'), false)
assert.equal(isLongCatModel('longcat-2.0'), true)
assert.equal(isLongCatModel('deepseek-v4-flash'), false)

const weakFlash = personaFor('weak', 'deepseek-v4-flash')
assert.ok(weakFlash.includes('Before acting, decide the task type'))
assert.ok(weakFlash.includes('Think deeply about the architecture'))
assert.ok(weakFlash.includes('Do not run environment checks'))
assert.notEqual(weakFlash, personaFor('weak', 'deepseek-v4-pro'), 'pro 与 flash 的 weak persona 必须不同')

const weakLongCat = personaFor('weak', 'auto/longcat-2.0')
assert.ok(weakLongCat.includes('strong reasoning capability'))
assert.ok(weakLongCat.includes('Direct production anchor'))
assert.ok(weakLongCat.includes('Single verification anchor'))

// 幂等反刍拦截测试
assert.equal(isRedundantVerification({ exitCode: 0 }, { tool: 'bash', args: { command: 'python3 test_processor.py' } }), true)
assert.equal(isRedundantVerification({ exitCode: 0 }, { tool: 'bash', args: { command: 'python3 -m unittest test' } }), true)
assert.equal(isRedundantVerification({ exitCode: 1 }, { tool: 'bash', args: { command: 'python3 test.py' } }), false)
assert.equal(isRedundantVerification({ exitCode: 0 }, { tool: 'write', args: { path: 'a.py' } }), false)

// --- 1.1 HarnessMM 决策卫述判定 (GDR) 与回调置换 (CCS) 单元测试 -------------
// 5 种标准物理卫述测试
// 1) return_code
assert.equal(evaluateGuard({ return_code: 0 }, { return_code: 0 }), true)
assert.equal(evaluateGuard({ return_code: 0 }, { return_code: 1 }), false)
// 2) stdout_contains
assert.equal(evaluateGuard({ stdout_contains: 'PASSED' }, { stdout: 'tests: 5 PASSED in 0.1s' }), true)
assert.equal(evaluateGuard({ stdout_contains: 'PASSED' }, { stdout: 'tests: 1 FAILED' }), false)
// 3) stdout_equals
assert.equal(evaluateGuard({ stdout_equals: 'OK' }, { stdout: 'OK\n' }), true)
assert.equal(evaluateGuard({ stdout_equals: 'OK' }, { stdout: 'ERROR' }), false)
// 4) stderr_empty
assert.equal(evaluateGuard({ stderr_empty: true }, { stderr: '' }), true)
assert.equal(evaluateGuard({ stderr_empty: true }, { stderr: 'Traceback...' }), false)
// 5) json_equals
assert.equal(evaluateGuard({ json_equals: { path: ['result', 'code'], value: 200 } }, { stdout: JSON.stringify({ result: { code: 200 } }) }), true)
assert.equal(evaluateGuard({ json_equals: { path: ['result', 'code'], value: 200 } }, { stdout: JSON.stringify({ result: { code: 500 } }) }), false)

// 兼容测试
assert.equal(evaluateGuard({ condition: 'status == success' }, { status: 'success' }), true)
assert.equal(evaluateGuard({ condition: 'status == success' }, { status: 'failed', isError: true }), false)
assert.equal(evaluateGuard({ exitCode: 0 }, { exitCode: 0 }), true)
assert.equal(evaluateGuard({ exitCode: 0 }, { exitCode: 1 }), false)

// 1.2 多步决策链调度器 (ChiselPlanScheduler) 单元测试
const scheduler = new ChiselPlanScheduler('session-dag-01')
const dagCandidates = [
  { action: { tool: 'write', args: { path: 'b.py' } }, guard: { status: 'success' } },
  { action: { tool: 'bash', args: { command: 'pytest b.py' } }, guard: { return_code: 0 } },
]
scheduler.loadCandidates(dagCandidates)
assert.equal(scheduler.hasPending(), true)

// 步骤 1：成功完成，推进到动作 1
const act1 = scheduler.step({ status: 'success' })
assert.equal(act1.tool, 'write')
assert.equal(scheduler.hasPending(), true)

// 步骤 2：成功完成，推进到动作 2
const act2 = scheduler.step({ return_code: 0 })
assert.equal(act2.tool, 'bash')
assert.equal(scheduler.hasPending(), false)

// 队列耗尽后安全返回 null
const act3 = scheduler.step({ return_code: 0 })
assert.equal(act3, null)

// 异常打断测试：若中间某步卫述未通过，队列立即被清空并安全回退
scheduler.loadCandidates(dagCandidates)
const failStep = scheduler.step({ return_code: 1, isError: true })
assert.equal(failStep, null)
assert.equal(scheduler.hasPending(), false, '卫述失败后队列必须安全清空')

const validCandidate = {
  action: { tool: 'bash', args: { command: 'pytest' } },
  guard: { condition: 'status == success' },
}
assert.equal(shouldBypassCallback({ status: 'success' }, validCandidate), true)
assert.equal(shouldBypassCallback({ status: 'error', isError: true }, validCandidate), false)
assert.equal(shouldBypassCallback({ status: 'success' }, null), false)
assert.equal(shouldBypassCallback({ status: 'success' }, { action: null }), false)

const cert = createSubstitutionCertificate({
  sessionId: 'test-session',
  modelId: 'deepseek-v4-flash',
  bypassedTool: 'bash',
  receipt: { status: 'success' },
  estimatedTokens: 15000,
})
assert.equal(cert.kind, 'harnessmm/substitution-certificate')
assert.equal(cert.estimatedTokensSaved, 15000)

// --- 2. persona 原位替换 ----------------------------------------------------
const sections = [
  { name: 'deployment:persona-prefix', text: 'old persona' },
  { name: 'agent-instructions', text: 'AGENTS' },
  { name: 'plan', text: 'plan-mode' },
  { name: 'deployment:persona-suffix', text: '' },
]
const replaced = applyPersona(sections, 'NEW')
assert.equal(replaced.length, 3, 'suffix 段被吸收，不留重复 persona 段')
assert.equal(replaced[0].name, 'deployment:persona-prefix')
assert.equal(replaced[0].text, 'NEW')
assert.equal(replaced[1].name, 'agent-instructions', '其他段相对顺序不变')
assert.equal(replaced[2].name, 'plan')
assert.equal(replaced.filter((s) => /persona/i.test(s.name)).length, 1)

// 没有 persona 段时退化为前置插入，而不是追加到末尾
assert.equal(applyPersona([{ name: 'a', text: 'A' }], 'NEW')[0].text, 'NEW')

// --- 3~5. 装配 handler 行为 ------------------------------------------------
const ALL_TOOLS = ['read', 'write', 'edit', 'glob', 'grep', 'bash'].map((name) => ({ name }))

/** 以指定 model 与事件日志驱动一次 system-prompt/assemble。 */
async function assemble({ model, events = [], tools = ALL_TOOLS, warnings = [], config = {}, omitTools = false }) {
  const listeners = []
  const ctx = {
    on: (event, handler) => listeners.push({ event, handler }),
    logger: { warn: (message) => warnings.push(message) },
  }
  apply(ctx, config)

  const agent = {
    options: { model },
    session: {
      id: 'session-test',
      snapshotEvents: () => events,
    },
  }
  const call = listeners.find((entry) => entry.event === 'system-prompt/assemble').handler
  return await call({}, { agent }, async () => ({
    sections: sections.map((s) => ({ ...s })),
    contexts: [{ name: 'sandbox:policy', text: 'policy' }],
    // 0.2.2+ 宿主：载荷不再携带 tools（工具声明归 provider）。
    ...(omitTools ? {} : { tools: tools.map((t) => ({ ...t })) }),
    variables: {},
  }))
}

const first = await assemble({ model: 'deepseek-v4-flash' })
assert.equal(first.tools.map((t) => t.name).join(','), 'read,write,edit,bash',
  '首轮工具面 = weak core(含 write) + 平台 shell')
assert.ok(first.sections[0].text.startsWith('You are a helpful assistant.'))
assert.equal(first.contexts.length, 0, '首轮清空运行时上下文（上游行为，未测量不改）')

const promoted = await assemble({
  model: 'deepseek-v4-flash',
  events: [{ type: 'tool/call' }],
})
assert.equal(promoted.tools.length, ALL_TOOLS.length, '首次 tool call 后放开全目录')
assert.equal(promoted.contexts.length, 0, '晋级后同样清空（上游两个分支都清）')

// 非 DeepSeek Flash：走关键词分类，不套用 flash 弱 persona（'修复' 命中 spec 词表）
assert.equal(sessionMode({ snapshotEvents: () => [] }), 'weak')
assert.equal(
  sessionMode({ snapshotEvents: () => [{ type: 'user/message', data: { content: [{ text: '修复崩溃 bug' }] } }] }),
  0,
)
assert.equal(
  sessionMode({ snapshotEvents: () => [{ type: 'user/message', data: { content: [{ text: '从零写一个网页游戏' }] } }] }),
  1,
)
// 第三方家族默认：人设仍按关键词分类（0.4.1 行为不变），但首轮不再收窄。
const thirdParty = await assemble({
  model: 'gemini-2.5-flash',
  events: [{ type: 'user/message', data: { content: [{ text: '修复崩溃 bug' }] } }],
})
assert.equal(thirdParty.sections[0].text, 'You are a helpful software engineer assistant.',
  '第三方默认策略下 persona 仍是分类结果（spec 档）')
assert.equal(thirdParty.tools.length, ALL_TOOLS.length,
  '第三方默认也放开首轮工具面：提示词教了 glob/grep，schema 就必须有')
assert.equal(thirdParty.contexts.length, 0)

// 显式 opt-in 的 neutral：不分类、中性句；工具面同样全量。
const thirdPartyNeutral = await assemble({
  model: 'gemini-2.5-flash',
  events: [{ type: 'user/message', data: { content: [{ text: '修复崩溃 bug' }] } }],
  config: { thirdPartyGuidance: 'neutral' },
})
assert.equal(thirdPartyNeutral.sections[0].text, 'You are a helpful assistant.',
  'neutral 策略：不被关键词分类改写')
assert.equal(thirdPartyNeutral.tools.length, ALL_TOOLS.length,
  'neutral 策略同样不收窄首轮工具面')

const nonFlashPro = await assemble({ model: 'deepseek-v4-pro' })
assert.notEqual(nonFlashPro.sections[0].text, personaFor('weak', 'deepseek-v4-flash'),
  'deepseek-v4-pro 不算 flash')
assert.equal(nonFlashPro.sections[0].text, personaFor('weak', 'deepseek-v4-pro'),
  'DeepSeek 非 Flash 仍走关键词分类（weak 档 = w6）')

const proSpec = await assemble({
  model: 'deepseek-v4-pro',
  events: [{ type: 'user/message', data: { content: [{ text: '修复崩溃 bug' }] } }],
})
assert.equal(proSpec.sections[0].text, 'You are a helpful software engineer assistant.',
  'DeepSeek 非 Flash 的 spec 档保持不变')
assert.equal(proSpec.tools.map((t) => t.name).join(','), 'read,edit,glob,grep,bash')

// --- 6. 不依赖已移除的 session.events -------------------------------------
let touchedLegacy = false
const legacySession = {
  id: 'session-legacy',
  snapshotEvents: () => [],
}
Object.defineProperty(legacySession, 'events', {
  get() {
    touchedLegacy = true
    throw new TypeError('session.events is gone')
  },
})
const listeners = []
apply({ on: (event, handler) => listeners.push({ event, handler }), logger: { warn: () => {} } }, {})
await listeners.find((entry) => entry.event === 'system-prompt/assemble').handler(
  {}, { agent: { options: { model: 'deepseek-v4-flash' }, session: legacySession } },
  async () => ({ sections: [], contexts: [], tools: ALL_TOOLS.map((t) => ({ ...t })), variables: {} }))
assert.equal(touchedLegacy, false, '不得再读 session.events')

// --- 7. 没有 shell 时降级，不让整轮装配失败 ---------------------------------
const warnings = []
const shellless = await assemble({
  model: 'deepseek-v4-flash',
  tools: ALL_TOOLS.filter((t) => t.name !== 'bash'),
  warnings,
})
assert.equal(shellless.tools.map((t) => t.name).join(','), 'read,write,edit',
  '缺 shell 时首轮只剩文件工具')
assert.equal(warnings.length, 1, '降级必须留下告警')
assert.ok(/bash\/pwsh/.test(warnings[0]))

// --- 8. 组合与宿主所有权的一致性 --------------------------------------------
// `dsh-web-app` 在宿主层把 23 个 agent 面行设为 disabled，把 agent 面交给 preset；
// 在 Web 部署里，preset 少写一行 = 该能力对它的 agent 直接不存在。
// 清单来自 dsh-web-app/cordis.patch.yml 的 `disabled: true` 行（0.1.5-rc.2），
// 内联在此以免自检依赖某个具体安装路径。
//
// 例外：`command-goal` 故意不补（保持上游家族的工具面，见 README「工具面」）。
// 宿主确实把它交了出来，所以这里不是「漏了」而是「决定了不要」——因此它从
// 必须存在的清单里移出，改为单独的「必须不存在」断言，防止将来顺手指回。
const HOST_DELEGATED_ROWS = [
  'tool-bash', 'tool-pwsh', 'tool-jobs', 'tool-fs', 'tool-fs-search',
  'skill-filesystem', 'tool-skill', 'tool-goal', 'plan-mode',
  'compaction-basic', 'command-compact', 'tool-result-pruner',
  'tool-subagent-control', 'tool-subagent',
  'tool-subagent-fork', 'workflow-ptc', 'tool-workflow', 'tool-ralph',
  'agent-instructions', 'tool-todo', 'tool-web',
]
// 组合已从「preset 目录里的 agent.cordis.yml」搬进 bundle patch 的声明行
// （0.5.1 起并入 cordis.patch.yml 的第二条 insert），整段缩进 +10。下面的断言
// 仍按原样的零缩进文本比对，所以先 dedent 回来——搬迁不该顺带改掉这些断言的字面。
const patch = readFileSync(
  fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)), 'utf8',
)
const composition = patch
  .split('\n')
  .map((line) => (line.startsWith('          ') ? line.slice(10) : line))
  .join('\n')
const missingRows = HOST_DELEGATED_ROWS.filter((id) => !composition.includes(`- id: ${id}\n`))
assert.deepEqual(missingRows, [],
  `宿主已把下列行交给 preset，组合里不能缺：${missingRows.join(', ')}`)

// 模型可见的目录跟随上游家族，不增不减：`present` 是模型可见的加法（描述约
// 464 字符），`command-goal` 虽不占模型上下文，但补它同样是偏离家族工具面。
// 两条都保持家族的「不写」。真要有意开启，先改这里并写下理由。
assert.equal(/\n- id: command-goal\n/.test(composition), false,
  'command-goal 故意不补：保持上游家族工具面')
assert.equal(/\n- id: present\n/.test(composition), false,
  'present 故意不补：模型可见的加法，需要测量')

// 工具面取值跟随 router-standard 家族（`fetch: false`），不改动：它是模型可见
// 的减法，去掉需要测量，而目前没有。这条断言防的是「顺手改成 true」。
assert.match(composition, /- id: tool-web\n  name: '@deepseek-ai\/dsh-tool-web'\n  config:\n    fetch: false\n/,
  'tool-web 保持家族取值 fetch: false')

// `sessionEvents()` 必须能在两代宿主上取到事件：新版走 snapshotEvents()，
// 旧版回退 session.events。
assert.deepEqual(sessionEvents({ snapshotEvents: () => [{ type: 'x' }] }), [{ type: 'x' }])
assert.deepEqual(sessionEvents({ events: [{ type: 'y' }] }), [{ type: 'y' }])

assert.deepEqual(coreFor('weak'), ['read', 'write', 'edit'])

// --- 交付形态：声明行自洽 ------------------------------------------------
// 0.2.0-rc.2 起 preset 是插件行，行 id 是 Loader 地址、config.id 才是会话记住的
// 身份。两者混用会让老会话认不回自己的 preset，所以在此钉死。
assert.match(patch, /- id: preset-router-flash\n      name: '@deepseek-ai\/dsh-agent-preset'\n/,
  '声明必须由 @deepseek-ai/dsh-agent-preset 承载，行 id 为 preset-router-flash')
assert.match(patch, /config:\n        id: router-flash\n/,
  'config.id 必须是 router-flash（会话身份，改名会让老会话失联）')
// 资产必须从已安装的包解析：rc.2 明确要求 preset 不能引用自身目录里的相对文件。
assert.equal(/name: \.\//.test(patch), false,
  'preset 内不得再有 ./ 相对模块引用（改用包子路径导出）')
assert.match(composition, /- id: router-bootstrap\n  name: dsh-router-flash\/router-bootstrap\n/,
  '路由模块必须走包内子路径导出 dsh-router-flash/router-bootstrap')

// --- 9. 0.2.1 能力恢复：时钟与定时工具必须在组合里 ---------------------------
// 两者都是「模型可见的加法」，但性质是恢复缺口而非口味：宿主不再提供，官方
// standard 由 preset 声明。少写一行的后果是模型不知道今天几号、也建不了提醒。
assert.match(composition, /- id: time-context\n  name: '@deepseek-ai\/dsh-time-context'\n/,
  '时钟行必须在组合里（宿主 Web 组合不声明它）')
assert.match(composition, /- id: tool-schedule\n  name: '@deepseek-ai\/dsh-tool-schedule'\n/,
  '定时提醒行必须在组合里（官方 standard 有）')

// --- 10. flashGuidance 开关：必须可达，且不得退回 spec 句 --------------------
// 这条分支此前是一处未定义标识符（FLASH_NEUTRAL），一次都没被调用过——因为它
// 既没定义也没接线。现在两头都钉住：值是中性句，且不等于 spec 的 persona。
const neutral = personaFor('weak', 'deepseek-v4-flash', { flashGuidance: false })
assert.equal(neutral, 'You are a helpful assistant.', 'flashGuidance:false 必须退回中性句')
assert.notEqual(neutral, personaFor(0, 'deepseek-v4-pro'),
  '不得退回 spec 句：P11 实测它对 Flash 是反向路由')

// --- 11. 0.2.2+ 宿主：assemble 载荷没有 tools，收窄改走 tools.restrict ------
// 0.2.2-alpha.2 起 system-prompt/assemble 只交 PromptPresentation，工具声明归
// provider。此前这里读 `assembled.tools.map(...)` 抛 TypeError，整轮请求直接失败
// （web 会话：turn/start 后 8ms 报 Cannot read properties of undefined）。
const payloadWithoutTools = await assemble({ model: 'deepseek-v4-flash', omitTools: true })
assert.equal(payloadWithoutTools.tools, undefined,
  '0.2.2+ 载荷没有 tools 时不得写入（工具声明归 provider）')
assert.ok(payloadWithoutTools.sections[0].text.startsWith('You are a helpful assistant.'),
  '人设替换照旧生效')
assert.equal(payloadWithoutTools.contexts.length, 0)

// 收窄路径：agent/created 时用 agent.ctx.tools.restrict({allow}) 登记，
// 首次工具结果（tools/result）后解除。
const events = new Map()
const restrictFilters = []
let lifts = 0
const fakeTools = {
  restrict: (filter) => {
    restrictFilters.push([...filter.allow])
    return () => { lifts += 1 }
  },
  get: (tool) => (['read', 'write', 'edit', 'glob', 'grep', 'bash'].includes(tool) ? { name: tool } : undefined),
}
apply({
  on: (event, handler) => {
    if (!events.has(event)) events.set(event, [])
    events.get(event).push(handler)
  },
  logger: { warn: () => {} },
  tools: fakeTools,
}, {})
const restrictAgent = {
  options: { model: 'deepseek-v4-flash' },
  model: { current: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }) },
  session: { id: 'session-restrict', snapshotEvents: () => [] },
  ctx: { tools: fakeTools },
}
for (const handler of events.get('agent/created') ?? []) handler({ agent: restrictAgent })
assert.deepEqual(restrictFilters[0], ['read', 'write', 'edit', 'bash'],
  '0.2.2+ 首轮收窄 = weak core + 平台 shell（经 tools.restrict）')
for (const handler of events.get('tools/result') ?? []) handler({ agent: restrictAgent })
assert.equal(lifts, 1, '首次工具结果后解除收窄')

// 第三方模型不登记收窄；已有 tool/call 的会话也不登记。
restrictFilters.length = 0
const thirdPartyAgent = {
  ...restrictAgent,
  options: { model: 'gemini-2.5-flash' },
  model: { current: () => ({ provider: 'g', model: 'gemini-2.5-flash' }) },
}
for (const handler of events.get('agent/created') ?? []) handler({ agent: thirdPartyAgent })
assert.equal(restrictFilters.length, 0, '第三方模型首轮不收窄')
const promotedAgent = {
  ...restrictAgent,
  session: { id: 'session-promoted', snapshotEvents: () => [{ type: 'tool/call' }] },
}
for (const handler of events.get('agent/created') ?? []) handler({ agent: promotedAgent })
assert.equal(restrictFilters.length, 0, '已有 tool/call 的会话不再收窄')

console.log('router-flash preset: all checks passed')
