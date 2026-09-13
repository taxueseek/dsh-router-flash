/**
 * router-core / router-bootstrap 回归自检（node preset/router.test.mjs）。
 *
 * 覆盖不依赖模型的纯逻辑分支：
 *   1. Flash 识别与弱 persona 选择；
 *   2. persona 原位替换（顺序、去重、plan-mode 段保留）；
 *   3. 工具面：首轮只留 core + 平台 shell，出现 tool/call 后放开全目录；
 *   4. 运行时上下文不被清空；
 *   5. 非 Flash 模型走首条 user/message 的关键词分类；
 *   6. `session.events` 已不存在时不再被读取（读旧属性会抛 TypeError）。
 */
import assert from 'node:assert/strict'
import {
  applyPersona, coreFor, isFlashModel, personaFor, sessionMode,
} from './router-core.mjs'
import { apply } from './router-bootstrap.mjs'

// --- 1. Flash 识别与 persona 选择 ------------------------------------------
assert.equal(isFlashModel('deepseek-v4-flash'), true)
assert.equal(isFlashModel('deepseek-v4-flash-0731'), true)
assert.equal(isFlashModel('deepseek-v4-pro'), false)
assert.equal(isFlashModel(undefined), false)

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
async function assemble({ model, events = [] }) {
  const listeners = []
  const ctx = { on: (_event, handler) => listeners.push(handler) }
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
    tools: ALL_TOOLS.map((t) => ({ ...t })),
    variables: {},
  }))
}

const first = await assemble({ model: 'deepseek-v4-flash' })
assert.equal(first.tools.map((t) => t.name).join(','), 'read,write,edit,bash',
  '首轮工具面 = weak core(含 write) + 平台 shell')
assert.ok(first.sections[0].text.startsWith('You are a helpful assistant.'))
assert.equal(first.contexts.length, 1, '运行时上下文必须保留')

const promoted = await assemble({
  model: 'deepseek-v4-flash',
  events: [{ type: 'tool/call' }],
})
assert.equal(promoted.tools.length, ALL_TOOLS.length, '首次 tool call 后放开全目录')
assert.equal(promoted.contexts.length, 1, '晋级后同样保留运行时上下文')

// 非 Flash：weak 兜底之外的分类走首条用户消息（'修复' 命中 spec 词表）
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
  model: 'deepseek-v4-pro',
  events: [{ type: 'user/message', data: { content: [{ text: '修复崩溃 bug' }] } }],
})
assert.equal(nonFlash.sections[0].text, 'You are a helpful software engineer assistant.',
  'spec 带用最小 persona（非 weak/pro）')
assert.equal(nonFlash.tools.map((t) => t.name).join(','), 'read,edit,glob,grep,bash',
  'spec 带核心工具面 = read/edit/glob/grep + shell')

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
apply({ on: (_e, h) => listeners.push(h) }, {})
await listeners[0]({}, { agent: { options: { model: 'deepseek-v4-flash' }, session: legacySession } },
  async () => ({ sections: [], contexts: [], tools: ALL_TOOLS.map((t) => ({ ...t })), variables: {} }))
assert.equal(touchedLegacy, false, '不得再读 session.events')

assert.deepEqual(coreFor('weak'), ['read', 'write', 'edit'])
console.log('router-flash preset: all checks passed')
