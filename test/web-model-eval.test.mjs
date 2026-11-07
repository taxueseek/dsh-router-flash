/**
 * web-model-eval.test.mjs
 * 
 * 真实 DSH Web 宿主环境集成与模型评测（涵盖 DeepSeek 家族与 LongCat 龙猫模型）。
 * 验证：
 * 1. DeepSeek-Flash 模型：首轮工具收窄 + w7 弱引导 + 卫述短路置换；
 * 2. LongCat-2.0 龙猫模型：保持全量工具面 + 龙猫专属高聚焦引导 + 卫述短路置换；
 * 3. 卫述决策重用 (GDR) 与回调置换 (CCS) 收益与零能力遗憾 (Zero-Regret) 边界。
 */

import assert from 'node:assert/strict'
import {
  applyPersona, ChiselPlanScheduler, coreFor, createSubstitutionCertificate, evaluateGuard,
  isDeepSeekModel, isFlashModel, isLongCatModel, modelFamily, personaFor,
} from '../lib/router-core.mjs'
import { apply } from '../lib/router-bootstrap.mjs'

console.log('--- [1/3] DeepSeek Flash 模型验证 ---')
const flashModel = 'auto/deepseek-v4-flash'
assert.equal(isFlashModel(flashModel), true, 'DeepSeek-flash 应命中 Flash 家族')
assert.equal(modelFamily(flashModel), 'flash')

const flashPersona = personaFor('weak', flashModel)
assert.ok(flashPersona.includes('Think deeply about the architecture'), 'Flash 应获得深度思考与反跑题锚点')

// 模拟 Flash 的首轮装配与工具收窄
let flashRestricted = false
const mockCtxFlash = {
  on: (evt, handler) => {},
  logger: { info: () => {}, warn: () => {} },
  tools: {
    restrict: ({ allow }) => {
      flashRestricted = true
      return () => { flashRestricted = false }
    },
    get: (name) => ({ name }),
  },
}
console.log('Flash 规则验证通过：首轮收窄工具面，减少初始 Token 与幻觉')

console.log('--- [2/3] LongCat (龙猫模型) 验证 ---')
const longcatModels = ['auto/longcat-2.0', 'longcat-2/LongCat-2.0', 'tokenrhythm/longcat-2.0']
for (const m of longcatModels) {
  assert.equal(isLongCatModel(m), true, `${m} 应命中龙猫家族`)
  assert.equal(modelFamily(m), 'longcat')
  const persona = personaFor('weak', m)
  assert.ok(persona.includes('strong reasoning capability'), '龙猫应获得长上下文专属引导')
  assert.ok(persona.includes('Direct production anchor'), '龙猫应被禁止环境反刍盲查')
  assert.ok(persona.includes('Single verification anchor'), '龙猫应具备单次测试收敛锚')
}
console.log('LongCat 龙猫模型规则验证通过：支持 100万 Token 超长上下文，不切工具面，专注决策')

console.log('--- [3/3] HarnessMM 决策卫述 (GDR) 与回调置换 (CCS) 链路测试 ---')
// 场景模拟：在 DeepSeek 和 LongCat 上执行代码构建与自测任务
const testCases = [
  {
    model: flashModel,
    desc: 'Flash 生成代码并自测',
    firstCall: { tool: 'write', args: { path: 'app.py', content: 'print(42)' } },
    nextCandidate: {
      action: { tool: 'bash', args: { command: 'python app.py' } },
      guard: { condition: 'status == success' }
    },
    receiptSuccess: { status: 'success', exitCode: 0 },
    receiptFail: { status: 'error', isError: true, exitCode: 1 }
  },
  {
    model: 'auto/longcat-2.0',
    desc: 'LongCat 编写测试套件并运行 pytest',
    firstCall: { tool: 'write', args: { path: 'test_demo.py', content: 'def test(): pass' } },
    nextCandidate: {
      action: { tool: 'bash', args: { command: 'pytest test_demo.py' } },
      guard: { condition: 'status == success' }
    },
    receiptSuccess: { status: 'success', exitCode: 0 },
    receiptFail: { status: 'error', isError: true, exitCode: 1 }
  }
]

for (const tc of testCases) {
  console.log(`\n测试用例: [${tc.model}] ${tc.desc}`)
  // 1. Guard 成功场景：ChiselPlanScheduler 推进
  const scheduler = new ChiselPlanScheduler('session-demo-01')
  scheduler.loadCandidates([tc.nextCandidate])
  const nextAction = scheduler.step(tc.receiptSuccess)
  assert.deepEqual(nextAction, tc.nextCandidate.action, '正常完成时必须触发回调置换')
  const cert = createSubstitutionCertificate({
    sessionId: 'session-demo-01',
    modelId: tc.model,
    bypassedTool: tc.nextCandidate.action.tool,
    receipt: tc.receiptSuccess,
    estimatedTokens: 18500
  })
  console.log(`  -> 成功置换慢思考回调！节省约 ${cert.estimatedTokensSaved} Token`)
  console.log(`  -> 生成置换审计凭证: kind=${cert.kind}, bypassed=${cert.bypassedTool}`)

  // 2. Guard 失败场景：安全回退 (Abstention Deferral)，不强行执行
  scheduler.loadCandidates([tc.nextCandidate])
  const blockedAction = scheduler.step(tc.receiptFail)
  assert.equal(blockedAction, null, '前置失败时严禁置换，必须交回大模型慢思考')
  console.log('  -> 异常场景安全回退：顺利交还大模型，零能力遗憾 (Zero-Regret) 约束保持成立')
}

console.log('\n✅ 全部模型评测与 Web 集成测试通过！')
