/**
 * HarnessMM 运行层自检：run_chain（重复命令检测在 dsh-turn-guard，不在本包）。
 *
 * 两段：
 *   A. 纯逻辑（无宿主）：参数校验、收据归一、链推进与停链；
 *   B. 真宿主管线（借本机 dsh 运行时的 cordis / dsh-tools / native executor）：
 *      证明每步真的经过 tools/pre-execute，被拒即停链。找不到 dsh 运行时则 B 段跳过
 *      （并打印 SKIP），不算通过。
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { receiptOf, validateChainArgs } from '../lib/router-core.mjs'
import { runChain, renderChain, chainToolDefinition } from '../lib/harnessmm-runtime.mjs'
import { apply } from '../lib/router-bootstrap.mjs'

// --- A1. 参数校验 -----------------------------------------------------------
const step = (command, when) => ({ tool: 'bash', args: { command }, ...(when ? { when } : {}) })
assert.ok(validateChainArgs({ steps: [step('a'), step('b')] }).steps, '2 步合法')
assert.match(validateChainArgs({ steps: [step('a')] }).error, /2-8/, '少于 2 步拒绝')
assert.match(validateChainArgs({ steps: Array.from({ length: 9 }, () => step('a')) }).error, /2-8/, '多于 8 步拒绝')
assert.match(validateChainArgs({ steps: [step('a', { exitCode: 0 }), step('b')] }).error, /steps\[0\]\.when/,
  '第一步不能带 when：没有上一步可判')
assert.match(validateChainArgs({ steps: [step('a'), step('b', { exitcode: 0 })] }).error, /unknown keys: exitcode/,
  '卫述键拼错必须拒绝——evaluateGuard 对未知键放行，拼错等于无条件继续')
assert.match(validateChainArgs({ steps: [step('a'), step('b', {})] }).error, /must not be empty/)
assert.match(validateChainArgs({ steps: [{ tool: 'run_chain', args: {} }, step('b')] }).error, /cannot be chained/,
  '禁止递归')
assert.match(validateChainArgs({ steps: [{ tool: '', args: {} }, step('b')] }).error, /tool must be/)
assert.match(validateChainArgs({}).error, /array/)
assert.deepEqual(validateChainArgs({ steps: [step('a'), step('b')] }).steps[1].guard, { status: 'success' },
  '缺省卫述 = 上一步成功')

// --- A2. 收据归一：bash 非零退出码不是 isError，必须读 value -----------------
const fg = (exitCode, extra = {}) => ({
  isError: false,
  content: [{ type: 'text', text: 'x' }],
  value: { kind: 'foreground', cwd: '/w', exitCode, signal: null, timedOut: false, aborted: false,
    timeoutMs: 1, stdout: { text: 'out' }, stderr: { text: '' }, ...extra },
})
assert.equal(receiptOf(fg(0)).status, 'success')
assert.equal(receiptOf(fg(1)).status, 'failed', '退出码 1 = failed，即便 isError 为 false')
assert.equal(receiptOf(fg(0, { timedOut: true })).status, 'failed', '超时不算成功')
assert.equal(receiptOf(fg(null, { signal: 'SIGKILL' })).status, 'failed', '被信号杀掉不算成功')
assert.equal(receiptOf({ isError: false, content: [], value: { kind: 'promoted', output: '' } }).status, 'running',
  '转后台的命令既非成功也非失败')
assert.equal(receiptOf({ isError: true, content: [{ type: 'text', text: 'Error: x' }], error: { message: 'x' } }).isError, true)
assert.equal(receiptOf({ isError: false, content: [{ type: 'text', text: 'wrote' }], value: { path: 'a' } }).status, 'success',
  '非 shell 工具成功 = success')

// --- A3. 链推进（注入 dispatch，不需要宿主）----------------------------------
const checked = (steps) => validateChainArgs({ steps }).steps
const fakeDispatch = (log) => async ({ action }) => {
  log.push(action.args.command)
  return fg(action.args.command.includes('fail') ? 1 : 0, { stdout: { text: `out:${action.args.command}` } })
}
{
  const log = []
  const v = await runChain(checked([step('build'), step('test', { exitCode: 0 }), step('ship', { stdout_contains: 'out:test' })]), fakeDispatch(log))
  assert.deepEqual(log, ['build', 'test', 'ship'])
  assert.equal(v.completed, 3)
  assert.equal(v.stoppedAt, null)
}
{
  const log = []
  const v = await runChain(checked([step('test fail'), step('deploy'), step('notify')]), fakeDispatch(log))
  assert.deepEqual(log, ['test fail'], '上一步失败，后续一步都不跑')
  assert.equal(v.stoppedAt, 1)
  assert.equal(v.reason, 'condition not met')
  assert.deepEqual(v.steps.map((s) => s.outcome), ['failed', 'guard-failed', 'skipped'])
}
{
  const log = []
  const v = await runChain(checked([step('a'), step('b', { stdout_contains: 'NOPE' })]), fakeDispatch(log))
  assert.deepEqual(log, ['a'])
  assert.equal(v.steps[1].outcome, 'guard-failed')
}
{
  const ac = new AbortController()
  const log = []
  const v = await runChain(checked([step('a'), step('b')]), async (s) => { ac.abort(); return fakeDispatch(log)(s) }, { signal: ac.signal })
  assert.deepEqual(log, ['a'], '取消后不再派发')
  assert.equal(v.reason, 'cancelled')
}
{
  const v = await runChain(checked([step('a'), step('b')]), async () => { throw new Error('boom') })
  assert.equal(v.reason, 'dispatch error')
  assert.deepEqual(v.steps.map((s) => s.outcome), ['failed', 'skipped'])
}
assert.match(renderChain({ completed: 1, total: 2, stoppedAt: 1, reason: 'condition not met', steps: [] })[0].text,
  /1\/2 steps completed, stopped at step 2 \(condition not met\)/)

// --- A5. 默认关：不传配置时不注册工具、不挂 post-execute ----------------------
{
  const registered = []
  const events = []
  apply({ on: (e) => events.push(e), logger: {}, tools: { register: (d) => registered.push(d.name) } }, {})
  assert.deepEqual(registered, [], '默认不注册 run_chain')
  assert.equal(events.includes('tools/post-execute'), false, '不挂 post-execute：重复检测已交给 turn-guard')
}
{
  const registered = []
  const events = []
  apply({ on: (e) => events.push(e), logger: {}, tools: { register: (d) => registered.push(d.name) } },
    { chain: true, repeatNotice: true })
  assert.deepEqual(registered, ['run_chain'])
  assert.equal(events.includes('tools/post-execute'), false, '旧配置 repeatNotice:true 被忽略，不报错')
}
assert.equal(chainToolDefinition({ ctx: {}, name: 'x' }).name, 'run_chain')

// --- B. 真宿主管线 ------------------------------------------------------------
const dshDir = [
  process.env.DSH_PACKAGE_DIR,
  join(homedir(), '.local', 'lib', 'node_modules', '@deepseek-ai', 'dsh'),
  '/usr/local/lib/node_modules/@deepseek-ai/dsh',
  '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh',
].find((dir) => typeof dir === 'string' && existsSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh-tools')))

if (dshDir === undefined) {
  console.log('SKIP harnessmm host pipeline: no dsh runtime found (set DSH_PACKAGE_DIR)')
} else {
  const mod = (pkg) => import(pathToFileURL(join(dshDir, 'node_modules', '@deepseek-ai', pkg, 'lib', 'index.js')).href)
  const [{ Context }, SP, Tools, Native] = await Promise.all([
    mod('cordis'), mod('dsh-system-prompt'), mod('dsh-tools'), mod('dsh-tool-executor-native'),
  ])
  const ctx = new Context()
  await ctx.plugin(SP.default)
  await ctx.plugin(Tools.default)
  await ctx.plugin(Native)

  // 自带 schema 校验：run_chain 的参数与输出必须落在宿主支持的 JSON Schema 子集里。
  const def = chainToolDefinition({ ctx: {}, name: 'x' })
  Tools.assertSupportedJsonSchema(def.parameters)
  Tools.assertSupportedJsonSchema(def.output.schema)

  const ran = []
  ctx.tools.register(Tools.defineTool({
    name: 'bash',
    description: 'fake bash',
    parameters: { command: { type: 'string', required: true } },
    output: {
      schema: { type: 'json' },
      render: (_a, v) => [{ type: 'text', text: v.stdout.text + (v.exitCode ? `\n[exit code: ${v.exitCode}]` : '') }],
    },
    async execute(a) {
      ran.push(a.command)
      return {
        kind: 'foreground', cwd: '/w', exitCode: a.command.includes('fail') ? 1 : 0, signal: null,
        timedOut: false, aborted: false, timeoutMs: 1,
        stdout: { text: `out:${a.command}`, truncated: false }, stderr: { text: '', truncated: false },
      }
    },
  }))
  // 审批门：含 rm 的命令一律拒绝。链里的这一步必须被拒、且后续不得执行。
  const gated = []
  ctx.on('tools/pre-execute', async (exec, next) => {
    gated.push(exec.name === 'bash' ? exec.arguments.command : exec.name)
    return exec.name === 'bash' && exec.arguments.command.includes('rm') ? { kind: 'deny', reason: 'denied by policy' } : next()
  })
  const logs = []
  await ctx.plugin({
    name: 'router-under-test',
    inject: ['systemPrompt', 'tools'],
    apply: (c) => apply(new Proxy(c, {
      get: (t, key) => (key === 'logger'
        ? { info: (m) => logs.push(m), warn: (m) => logs.push(m) }
        : (typeof t[key] === 'function' ? t[key].bind(t) : t[key])),
    }), { chain: true }),
  })

  const signal = new AbortController().signal
  let n = 0
  const call = (name, args, agent) => ctx.tools.execute({
    calls: [{ type: 'tool-call', id: `c${n++}`, name, arguments: JSON.stringify(args) }],
    signal,
    ...(agent ? { agent } : {}),
  })

  let r = await call('run_chain', { steps: [step('build'), step('test', { exitCode: 0 })] })
  assert.equal(r.results[0].result.isError, false)
  assert.deepEqual(ran, ['build', 'test'])
  assert.deepEqual(gated, ['run_chain', 'build', 'test'], '每一步都经过 tools/pre-execute（链本身也经过）')

  ran.length = 0
  r = await call('run_chain', { steps: [step('ok'), step('rm -rf x'), step('after')] })
  const v = r.results[0].result.value
  assert.deepEqual(v.steps.map((s) => s.outcome), ['ok', 'denied', 'skipped'], '被拒的一步停链')
  assert.equal(v.reason, 'approval denied')
  assert.deepEqual(ran, ['ok'], '被拒之后的步骤一步都没执行')

  r = await call('run_chain', { steps: [step('a'), step('b', { exitcode: 0 })] })
  assert.equal(r.results[0].result.isError, true, '卫述键拼错 = 工具报错，不执行任何一步')
  assert.match(r.results[0].result.content[0].text, /unknown keys: exitcode/)

  assert.ok(logs.some((m) => m.includes('harnessmm/substitution-certificate')), '每条链留审计凭证')

  await ctx.dispose?.()
  console.log('harnessmm host pipeline: checks passed')
}

console.log('harnessmm runtime: all checks passed')
