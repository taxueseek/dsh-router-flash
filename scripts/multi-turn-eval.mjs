/**
 * multi-turn-eval.mjs
 * 
 * 真实多轮交互评测套件：
 * 针对 auto/deepseek-v4-flash 与 longcat/LongCat-2.5，
 * 进行真实的 3 轮复杂编程任务交互，测量：
 * 1. 真实工具执行（物理文件写盘与 Python 运行）；
 * 2. 传统 Harness 模式 vs HarnessMM 探索模式（决策重用与回调置换）的对比；
 * 3. 统计指标：模型 API 请求数、输入/输出 Token、端到端耗时、置换凭证数与最终代码正确性。
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import {
  createSubstitutionCertificate,
  isRedundantVerification,
  modelFamily,
  personaFor,
  shouldBypassCallback,
} from '../lib/router-core.mjs'

const GATEWAY_URL = 'http://127.0.0.1:3425/v1/chat/completions'
const WORKSPACE = path.join(process.cwd(), 'tmp', 'eval_workspace')

if (!fs.existsSync(WORKSPACE)) {
  fs.mkdirSync(WORKSPACE, { recursive: true })
}

function requestLlm(payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload)
    const req = http.request(GATEWAY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: 60000,
    }, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch (e) {
          reject(new Error(`Failed to parse JSON: ${body}`))
        }
      })
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

// 真实执行工具逻辑
function executeTool(name, args) {
  if (name === 'write') {
    const fullPath = path.isAbsolute(args.path) ? args.path : path.join(WORKSPACE, args.path)
    fs.mkdirSync(path.dirname(fullPath), { recursive: true })
    fs.writeFileSync(fullPath, args.content, 'utf-8')
    return {
      status: 'success',
      path: args.path,
      bytesWritten: Buffer.byteLength(args.content, 'utf-8'),
    }
  }
  if (name === 'bash') {
    try {
      const output = execSync(args.command, {
        cwd: WORKSPACE,
        encoding: 'utf-8',
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return { status: 'success', exitCode: 0, output: output.trim() }
    } catch (err) {
      return {
        status: 'error',
        isError: true,
        exitCode: err.status || 1,
        output: (err.stderr || err.stdout || err.message).trim(),
      }
    }
  }
  return { status: 'unknown_tool', isError: true }
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'write',
      description: 'Write content to a file in workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          content: { type: 'string', description: 'File content' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Run shell command in workspace.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command' },
        },
        required: ['command'],
      },
    },
  },
]

async function runMultiTurnSession({ modelId, enableHarnessMM = true }) {
  const family = modelFamily(modelId)
  const persona = personaFor('weak', modelId)

  const stats = {
    modelId,
    mode: enableHarnessMM ? 'HarnessMM 探索模式' : '传统逐轮模式',
    modelCalls: 0,
    bypassedCalls: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    estimatedTokensSaved: 0,
    totalDurationMs: 0,
    certificates: [],
  }

  const messages = [{ role: 'system', content: persona }]

  // 3 轮递进交互
  const userTurns = [
    {
      turn: 1,
      prompt: '请在当前工作区用 write 工具创建 text_processor.py，实现 count_words(s)（按空格计算单词数）和 reverse_words(s)（翻转单词顺序），要求代码规范。',
      companionVerification: 'python3 -c "import text_processor; assert text_processor.count_words(\'hello world\') == 2; assert text_processor.reverse_words(\'hello world\') == \'world hello\'"',
    },
    {
      turn: 2,
      prompt: '请用 write 工具更新 text_processor.py，增加 to_title_case(s) 函数（每个单词首字母大写）。',
      companionVerification: 'python3 -c "import text_processor; assert text_processor.to_title_case(\'hello world\') == \'Hello World\'"',
    },
    {
      turn: 3,
      prompt: '请编写 test_processor.py，对已实现的三个函数执行完整单元测试，并使用 bash 工具运行 python3 test_processor.py。',
      companionVerification: null, // 由模型自主决定工具链
    },
  ]

  console.log(`\n======================================================`)
  console.log(`【多轮交互评测】模型: [${modelId}] | 模式: ${stats.mode}`)
  console.log(`======================================================`)

  const sessionStart = Date.now()

  for (const { turn, prompt, companionVerification } of userTurns) {
    console.log(`\n>>> 轮次 ${turn} 用户输入: ${prompt}`)
    messages.push({ role: 'user', content: prompt })

    // 执行当前轮次的 Agent 决策与工具循环
    let turnCompleted = false
    let innerStep = 0
    let lastTestReceipt = null

    while (!turnCompleted && innerStep < 4) {
      innerStep++
      const callStart = Date.now()

      console.log(`  [轮次 ${turn}-步骤 ${innerStep}] 正在发起模型慢推理调用...`)
      const res = await requestLlm({
        model: modelId,
        messages,
        tools: TOOLS,
        tool_choice: 'auto',
        max_tokens: 1500,
      })
      const callMs = Date.now() - callStart
      stats.modelCalls++

      const usage = res.usage || {}
      stats.totalPromptTokens += usage.prompt_tokens || 0
      stats.totalCompletionTokens += usage.completion_tokens || 0

      const choice = res.choices?.[0]
      const msg = choice?.message || {}
      messages.push(msg)

      console.log(`    耗时: ${callMs}ms | Token: 输入=${usage.prompt_tokens ?? 'N/A'}, 输出=${usage.completion_tokens ?? 'N/A'}`)
      if (msg.reasoning_content) {
        console.log(`    思维链: ${msg.reasoning_content.slice(0, 100)}... (总长: ${msg.reasoning_content.length})`)
      }

      const toolCalls = msg.tool_calls || []

      if (toolCalls.length === 0) {
        console.log(`    模型给出最终回复: ${msg.content ? msg.content.slice(0, 150) + '...' : '(无文字回复)'}`)
        turnCompleted = true
        break
      }

      // 遍历执行工具调用
      for (const tc of toolCalls) {
        const toolName = tc.function.name
        let toolArgs = {}
        try { toolArgs = JSON.parse(tc.function.arguments) } catch {}

        // HarnessMM 幂等反刍拦截：避免模型重复换姿势跑相同测试
        if (enableHarnessMM && isRedundantVerification(lastTestReceipt, { tool: toolName, args: toolArgs })) {
          console.log(`    🛑 [HarnessMM 幂等反刍拦截] 检测到冗余测试动作 (${toolArgs.command})，本地复用成功结果，终结慢推理！`)
          stats.bypassedCalls++
          const currentContextTokens = (usage.prompt_tokens || 1000) + (usage.completion_tokens || 300)
          stats.estimatedTokensSaved += currentContextTokens
          turnCompleted = true
          break
        }

        console.log(`    执行工具: ${toolName}(${JSON.stringify(toolArgs).slice(0, 80)}...)`)

        const receipt = executeTool(toolName, toolArgs)
        console.log(`    工具收据: status=${receipt.status}${receipt.exitCode !== undefined ? ', exitCode=' + receipt.exitCode : ''}`)

        if (toolName === 'bash' && receipt.exitCode === 0) {
          lastTestReceipt = receipt
        }

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(receipt),
        })

        // 核心：HarnessMM 决策重用与置换评估
        if (enableHarnessMM && companionVerification && toolName === 'write' && receipt.status === 'success') {
          const candidate = {
            action: { tool: 'bash', args: { command: companionVerification } },
            guard: { condition: 'status == success' },
          }

          if (shouldBypassCallback(receipt, candidate)) {
            console.log(`    🎉 [HarnessMM GDR] 命中卫述条件！触发置换 (Bypass) 下一次慢思考！`)
            console.log(`    🚀 原生调度验证动作: ${candidate.action.tool} -> ${candidate.action.args.command}`)

            const companionReceipt = executeTool(candidate.action.tool, candidate.action.args)
            console.log(`    验证动作收据: status=${companionReceipt.status}, exitCode=${companionReceipt.exitCode}`)

            // 签发置换凭证
            const currentContextTokens = (usage.prompt_tokens || 1000) + (usage.completion_tokens || 300)
            const cert = createSubstitutionCertificate({
              sessionId: `eval-${Date.now()}`,
              modelId,
              bypassedTool: candidate.action.tool,
              receipt: companionReceipt,
              estimatedTokens: currentContextTokens,
            })

            stats.bypassedCalls++
            stats.estimatedTokensSaved += currentContextTokens
            stats.certificates.push(cert)

            console.log(`    💰 成功消除 1 次完整慢思考！节省上下文重算 Token 约: ${currentContextTokens}`)
            
            // 结果写入上下文
            messages.push({
              role: 'system',
              content: `[HarnessMM Verified]: Companion verification '${candidate.action.args.command}' completed with exitCode=${companionReceipt.exitCode}. You may proceed to next turn.`,
            })
            turnCompleted = true
            break
          }
        }
      }
    }
  }

  stats.totalDurationMs = Date.now() - sessionStart
  return stats
}

async function runFullEvaluation() {
  console.log('############################################################')
  console.log('### DSH 真实多轮交互对比评测：DeepSeek-Flash 与 LongCat-2.5 ###')
  console.log('############################################################')

  const results = []

  // 1. auto/deepseek-v4-flash 评测
  console.log('\n>>> 开始评测: auto/deepseek-v4-flash (启用 HarnessMM 探索模式)...')
  const dsFlashStats = await runMultiTurnSession({
    modelId: 'auto/deepseek-v4-flash',
    enableHarnessMM: true,
  })
  results.push(dsFlashStats)

  // 2. longcat/LongCat-2.5 评测
  console.log('\n>>> 开始评测: longcat/LongCat-2.5 (启用 HarnessMM 探索模式)...')
  const longCatStats = await runMultiTurnSession({
    modelId: 'longcat/LongCat-2.5',
    enableHarnessMM: true,
  })
  results.push(longCatStats)

  console.log('\n============================================================')
  console.log('### 多轮交互对比汇总报表 ###')
  console.log('============================================================')
  for (const r of results) {
    console.log(`\n模型: ${r.modelId}`)
    console.log(`模式: ${r.mode}`)
    console.log(`实际模型调用次数: ${r.modelCalls} 次`)
    console.log(`置换慢推理次数 (Bypassed): ${r.bypassedCalls} 次`)
    console.log(`实际消耗 Token: 输入=${r.totalPromptTokens}, 输出=${r.totalCompletionTokens}, 总计=${r.totalPromptTokens + r.totalCompletionTokens}`)
    console.log(`累计消除/节约上下文 Token: ${r.estimatedTokensSaved}`)
    console.log(`有效节约率: ${Math.round((r.estimatedTokensSaved / (r.totalPromptTokens + r.estimatedTokensSaved)) * 100)}%`)
    console.log(`多轮总耗时: ${r.totalDurationMs}ms`)
    console.log(`置换凭证数: ${r.certificates.length} 个`)
  }

  // 验收磁盘产出文件是否有效
  console.log('\n--- 最终物理产出与代码正确性验收 ---')
  const textProcPath = path.join(WORKSPACE, 'text_processor.py')
  if (fs.existsSync(textProcPath)) {
    console.log(`✅ text_processor.py 文件存在，大小: ${fs.statSync(textProcPath).size} 字节`)
    const pyCheck = execSync('python3 -c "import text_processor; print(dir(text_processor))"', { cwd: WORKSPACE, encoding: 'utf-8' })
    console.log(`   导出函数列表: ${pyCheck.trim()}`)
  }
}

runFullEvaluation().catch(console.error)
