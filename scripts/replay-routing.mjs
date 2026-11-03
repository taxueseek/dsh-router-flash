#!/usr/bin/env node
/**
 * replay-routing：拿历史会话回放路由，做「不花模型调用」的对照测量。
 *
 * 读 $DSH_HOME/sessions（默认 ~/.dsh/sessions）里的会话日志，筛出 router-flash
 * 且模型不属于 DeepSeek 家族的会话，然后回答三个问题：
 *
 *   1. 首轮有没有被收窄（tools ≤ 6 视为收窄）；
 *   2. 收窄时，提示词是否仍在教模型用被藏掉的工具（提示词与 schema 不一致）；
 *   3. 旧的关键词分类把这些会话分到了哪一档（spec / react / weak）。
 *
 * 它度量的是「改动覆盖到哪些会话、修掉了什么不一致」，不是「模型表现更好」。
 * 后者要跑真实模型（见 README 的对照测量约定），本脚本不替代它。
 *
 * 用法：
 *   node scripts/replay-routing.mjs            # 汇总 + 明细
 *   node scripts/replay-routing.mjs --quiet    # 只打印汇总
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'
import { classifyTask, modelFamily } from '../lib/router-core.mjs'

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const sessionsRoot = join(dshHome, 'sessions')
const quiet = process.argv.includes('--quiet')

/** 会话目录是 <sessions>/<workspace>/<session>/session.v4.jsonl.zstd。 */
function sessionFiles() {
  const out = []
  for (const workspace of readdirSync(sessionsRoot)) {
    const wsDir = join(sessionsRoot, workspace)
    if (!statSync(wsDir).isDirectory()) continue
    for (const session of readdirSync(wsDir)) {
      const file = join(wsDir, session, 'session.v4.jsonl.zstd')
      try {
        if (statSync(file).isFile()) out.push(file)
      } catch {
        // 没有日志的会话目录（例如刚创建）跳过。
      }
    }
  }
  return out
}

/** 会话日志是「一个事件一帧」拼接出来的；Node 的 zstdDecompressSync 只解第一帧，
 *  所以按 Zstd 帧头逐帧切分再分别解压。 */
function frameLength(buf, offset) {
  if (buf.readUInt32LE(offset) !== 0xfd2fb528) throw new Error('not a zstd frame')
  let cursor = offset + 4
  const descriptor = buf[cursor++]
  const contentSizeFlag = descriptor >> 6
  const singleSegment = (descriptor >> 5) & 1
  const hasChecksum = (descriptor >> 2) & 1
  const dictionaryFlag = descriptor & 3
  if (!singleSegment) cursor += 1 // Window_Descriptor
  cursor += [0, 1, 2, 4][dictionaryFlag] // Dictionary_ID
  cursor += [singleSegment ? 1 : 0, 2, 4, 8][contentSizeFlag] // Frame_Content_Size
  for (;;) {
    const header = buf.readUIntLE(cursor, 3)
    cursor += 3
    const lastBlock = header & 1
    const blockType = (header >> 1) & 3
    const blockSize = header >>> 3
    cursor += blockType === 1 ? 1 : blockSize // RLE stores one byte
    if (lastBlock) break
  }
  if (hasChecksum) cursor += 4
  return cursor - offset
}

function readLog(file) {
  const buf = readFileSync(file)
  const chunks = []
  for (let offset = 0; offset < buf.length;) {
    const length = frameLength(buf, offset)
    chunks.push(zstdDecompressSync(buf.subarray(offset, offset + length)))
    offset += length
  }
  return Buffer.concat(chunks).toString('utf8')
}

function events(file) {
  return readLog(file).split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line))
}

const rows = []
for (const file of sessionFiles()) {
  let list
  try {
    list = events(file)
  } catch {
    continue
  }
  const presets = list.filter((e) => e.type === 'agent-preset/selected')
    .map((e) => e.data?.agentPreset)
  if (!presets.includes('router-flash')) continue

  const system = list.find((e) => e.type === 'system/message')
  const header = list.find((e) => e.type === 'request/header')
  const user = list.find((e) => e.type === 'user/message')
  if (!system || !header || !user) continue

  const model = header.data?.header?.config?.model ?? ''
  if (modelFamily(model) !== 'third-party') continue

  const tools = (header.data?.header?.tools ?? []).map((t) => t.name)
  const prompt = system.data?.message?.content?.[0]?.text ?? ''
  const message = (user.data?.content ?? [])
    .map((c) => (typeof c === 'string' ? c : c?.text ?? '')).join(' ')

  // 提示词教了一个首轮 schema 里没有的工具 = 模型被要求做一件它做不到的事。
  const orphaned = ['glob', 'grep', 'read'].filter((tool) =>
    !tools.includes(tool) && new RegExp(`use the ${tool} tool`, 'i').test(prompt))

  const band = classifyTask(message)
  rows.push({
    model,
    band: band === 1 ? 'react' : band === 0 ? 'spec' : 'weak',
    message: message.replace(/\s+/g, ' ').slice(0, 44),
    narrowed: tools.length <= 6,
    tools: tools.length,
    orphaned,
  })
}

const count = (predicate) => rows.filter(predicate).length
const bands = rows.reduce((acc, row) => ({ ...acc, [row.band]: (acc[row.band] ?? 0) + 1 }), {})

console.log(`第三方会话：${rows.length}`)
console.log(`首轮被收窄：${count((r) => r.narrowed)}/${rows.length}`)
console.log(`收窄且提示词仍教被藏工具：${count((r) => r.narrowed && r.orphaned.length > 0)}/${rows.length}`)
console.log(`关键词分类分布：${Object.entries(bands).map(([k, v]) => `${k} ${v}`).join(' / ') || '—'}`)

if (!quiet && rows.length > 0) {
  console.log('\n模型 | 档位 | 首轮工具数 | 被藏却仍在教的工具 | 首条消息')
  for (const row of rows) {
    console.log([
      row.model,
      row.band,
      row.tools,
      row.orphaned.join('+') || '—',
      row.message,
    ].join(' | '))
  }
}
