/**
 * router-core / router-bootstrap 回归自检（node preset/router.test.mjs）。
 *
 * 覆盖不依赖模型的纯逻辑分支：
 *   1. 模型识别：DeepSeek Flash 命中，同名「flash」的其他家族不命中；
 *   2. persona 原位替换（顺序、去重、plan-mode 段保留）；
 *   3. 工具面：首轮只留 core + 平台 shell，出现 tool/call 后放开全目录；
 *   4. 运行时上下文不被清空；
 *   5. 非 DeepSeek Flash 模型走首条 user/message 的关键词分类；
 *   6. `session.events` 已不存在时不再被读取（读旧属性会抛 TypeError）；
 *   7. 工具目录里没有 shell 时降级告警，而不是让整轮装配失败；
 *   8. 组合覆盖宿主交还给 preset 的每一行（防止「没写一行」变成静默裁能力）；
 *   9. 交付形态自洽：声明行 id / config.id / 包子路径引用（搬迁到声明行之后）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  applyPersona, coreFor, isFlashModel, personaFor, sessionEvents, sessionMode,
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

const weakFlash = personaFor('weak', 'deepseek-v4-flash')
assert.ok(weakFlash.includes('Before acting, decide the task type'))
assert.ok(weakFlash.includes('Think deeply about the architecture'))
assert.ok(weakFlash.includes('Do not run environment checks'))
assert.notEqual(weakFlash, personaFor('weak', 'deepseek-v4-pro'), 'pro 与 flash 的 weak persona 必须不同')

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
async function assemble({ model, events = [], tools = ALL_TOOLS, warnings = [] }) {
  const listeners = []
  const ctx = {
    on: (_event, handler) => listeners.push(handler),
    logger: { warn: (message) => warnings.push(message) },
  }
  apply(ctx, {})

  const agent = {
    options: { model },
    session: {
      id: 'session-test',
      snapshotEvents: () => events,
    },
  }
  const call = listeners[0]
  return await call({}, { agent }, async () => ({
    sections: sections.map((s) => ({ ...s })),
    contexts: [{ name: 'sandbox:policy', text: 'policy' }],
    tools: tools.map((t) => ({ ...t })),
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
const nonFlash = await assemble({
  model: 'gemini-2.5-flash',
  events: [{ type: 'user/message', data: { content: [{ text: '修复崩溃 bug' }] } }],
})
assert.equal(nonFlash.sections[0].text, 'You are a helpful software engineer assistant.',
  'spec 带用最小 persona；同名 flash 的其他家族不得套 DeepSeek 弱 persona')
assert.equal(nonFlash.tools.map((t) => t.name).join(','), 'read,edit,glob,grep,bash',
  'spec 带核心工具面 = read/edit/glob/grep + shell')

const nonFlashPro = await assemble({ model: 'deepseek-v4-pro' })
assert.notEqual(nonFlashPro.sections[0].text, personaFor('weak', 'deepseek-v4-flash'),
  'deepseek-v4-pro 不算 flash')

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
apply({ on: (_e, h) => listeners.push(h), logger: { warn: () => {} } }, {})
await listeners[0]({}, { agent: { options: { model: 'deepseek-v4-flash' }, session: legacySession } },
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
  'tool-subagent-control', 'tool-subagent-list-agents', 'tool-subagent',
  'tool-subagent-fork', 'workflow-ptc', 'tool-workflow', 'tool-ralph',
  'agent-instructions', 'tool-todo', 'tool-web',
]
// 组合已从「preset 目录里的 agent.cordis.yml」搬进 bundle patch 的声明行
// （presets/router-flash.patch.yml），整段缩进 +10。下面的断言仍按原样的零缩进
// 文本比对，所以先 dedent 回来——搬迁不该顺带改掉这些断言的字面。
const patch = readFileSync(
  fileURLToPath(new URL('../presets/router-flash.patch.yml', import.meta.url)), 'utf8',
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

console.log('router-flash preset: all checks passed')
