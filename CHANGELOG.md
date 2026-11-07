# Changelog

## 0.6.1 — 2026-11-07 — 首轮路由与工具收窄缺陷修复、重复检测移交与冗余裁剪

### 以前不行、现在能行

- **Web UI 切换模型后人设与首轮收窄不再错配**：此前 `system-prompt/assemble` 只读静态的
  `agent.options.model`，用户在界面模型选择器切模型后仍按默认模型路由（本机回放 20+ 会话
  错配）。现在新增 `resolveModelId(agent, context)`，按 `context.modelSelection` →
  `agent.model.current()` → 会话最新 `model/selection` 事件 → `agent.options.model` 顺序解析；
  同时监听 `session/event` 的 `model/selection` 与 `turn/start`，在首次工具调用前动态重算或
  解除首轮 `tools.restrict()`。
- **Turn 1 Step 1 就能读到首条用户消息，Step 2 不再翻转人设击穿 KV 缓存**：DSH 0.2.2 的
  `user/message` 在 `step()` 里才落盘（晚于 `tools.resolve()` 与 `systemPrompt.assemble()`），
  此前首轮第 1 步 `sessionMode()` 100% 退回 `'weak'`，第 2 步才突然翻转为 `spec`/`react`
  （本机 18 个会话中途变人设）。现在新增 `firstUserText()` 同时读取 `user/message` 与
  `agent/inbox/spliced`（`data.inserted`），并在会话内锁定已解析的 `mode`，全程保持人设稳定。
- **LongCat 家族首轮固定走 `weak` 分支**：`router-bootstrap.mjs` 此前只给 `family === 'flash'`
  固定 `'weak'`，导致 LongCat 首条消息含构建或修复词时掉入 `0`/`1` 分支丢失 `WEAK_LONGCAT`
  专属长上下文锚点；现将 `family === 'longcat'` 一并归入 `'weak'`。
- **首轮 core 工具集补齐 `glob` 与 `grep`**：本机 105 个 `router-flash` 会话（6,998 次工具调用）
  实测显示，首轮裁掉 `glob`/`grep` 导致模型第 1 步被迫用 `bash` 跑 `find`/`ls`/`grep` 并形成
  整场沿用 `bash` 的强先验（`bash` 占 69.7%，`glob` 0 次、`grep` 3 次），同时在 ≤0.2.1 宿主上
  造成 71/88 个会话出现 `tool:glob`/`tool:grep` 孤儿提示词、在 0.2.2+ 宿主上造成 Step 2 提示词
  中部插入抖动。现将 `coreFor('weak' | 'react')` 扩为 `['read', 'write', 'edit', 'glob', 'grep']`，
  并为 `run_chain` 补入字面量闭包示例。

### Removed

- `repeatNotice` 开关与对应的 `tools/post-execute` 监听（`repeatNoticeListener`、`REPEAT_NOTICE`、
  `isIdenticalRepeat`、`READ_ONLY_TOOLS`）。原因：它只看紧挨着的两次调用，按本机回放只覆盖
  LongCat 273 次真重复里的 66 次，而且只提示不拦截。判重统一交给 dsh-turn-guard 的规则 6，
  宿主提醒、turn-guard、本插件三处重叠收成一处。旧配置写着 `repeatNotice: true` 不报错，
  只是不再生效。
- 删掉 `router-core.mjs` 中生产代码从未调用的 `shouldBypassCallback` 与 `isRedundantVerification`。
- 删掉 `cordis.patch.yml` 中 `disabled: true` 的 `tool-subagent-codex` 与 `tool-subagent-claude-code`
  两行死配置，以及 `scripts/check-composition.mjs` 中对应的两条 `only-here` 白名单（叶子行从
  28 行收敛为 26 行，与官方 `standard` 差异从 12 处减至 10 处）。

### 相关依赖

- 想要重复命令拦截，装 dsh-turn-guard 0.5.0 或更高（规则 6 默认开）。

## 0.6.0 — 2026-11-07 — HarnessMM 运行层真正接线（默认关）

### 以前不行、现在能行

0.5.x 带着 HarnessMM 的判定函数（`evaluateGuard`、`ChiselPlanScheduler`、置换凭证），但运行时
从未触发过一次：没有任何代码调用 `loadCandidates()`，模型也没有声明候选动作的通道，
`tools/result` 里的调度分支永远进不去。README 说「路由器还在 `tools/result` 上跑 HarnessMM
链式置换」，与事实不符。0.6.0 补上声明通道和执行器。

### Added

- **`run_chain` 工具**（`chain: true` 打开）：模型一次声明 2-8 步参数已定的调用，每步可带
  `when` 卫述（`exitCode` / `status` / `stdout_contains` / `stdout_equals` / `stderr_empty`，
  缺省为「上一步成功」）。推进由 `ChiselPlanScheduler` 完成。每一步经 `ctx.tools.execute()`
  走宿主完整管线，**审批、拒绝策略、沙箱对每一步照样生效**；卫述不过、被拒、出错都立即
  停链，返回已有结果。每条链写一条 `harnessmm/substitution-certificate` 日志。
- **幂等重复提示**（`repeatNotice: true` 打开）：`tools/post-execute` 上，同一 shell 命令、同一
  目录、输出逐字相同时附一句提示，不拦截、不改结果。依据：本机 router-flash 会话回放，
  36 次连续重复的 bash 命令 36 次输出相同。
- `lib/harnessmm-runtime.mjs`（新包子路径 `dsh-router-flash/harnessmm-runtime`）。
- `router-core.mjs`：`receiptOf()`（把宿主 `ToolExecutionResult` 归一成收据；bash 非零退出码
  不是 `isError`，必须读 canonical value）、`validateChainArgs()`（卫述未知键一律拒绝）、
  `isIdenticalRepeat()`。
- `test/harnessmm-runtime.test.mjs`：纯逻辑 + 借本机 dsh 运行时的真管线测试，`npm test` 包含它。

### Changed

- `router-bootstrap.mjs` 删掉空转的每 agent 调度器和 `tools/result` 里永不触发的分支。
- 首轮收窄不变：`run_chain` 不在 allow 清单里，首次工具结果后才出现。
- `npm run typecheck` 覆盖全部 `lib/` 模块；`install.sh` 固定 v0.6.0。
- README 第 45 行与 HarnessMM 章节按实际行为重写。

### 默认关闭的功能怎么打开

在 `router-bootstrap` 行的 `config` 里设 `chain: true`、`repeatNotice: true`，重启 DSH。

### Not measured

- 打开后真实模型是否会用 `run_chain`、能省多少次往返、是否影响完成率，都没有测过。
- `repeatNotice` 能否减少 LongCat 的重复命令，需要打开后用会话回放对比。

### 依赖

仍为零运行时依赖。真管线测试从本机 dsh 运行时借 `cordis`、`dsh-system-prompt`、`dsh-tools`、
`dsh-tool-executor-native`，找不到时跳过并打印 SKIP。

## 0.5.2 — 2026-11-06 — adapt to dsh 0.2.2-rc.1

- cordis 基线适配 0.2.2-rc.1，`dshReleases` 补登记 `0.2.2-rc.1`，新增 `npm run typecheck`。

## 0.5.1 — 2026-11-06 — single-file bundle patch

### Changed

- **The two patch files are merged into one `cordis.patch.yml`.** 0.5.0 declared
  `dsh.bundle.patch` as an array (`["./cordis.patch.yml", "./presets/router-flash.patch.yml"]`);
  0.5.1 merges both inserts into the single `cordis.patch.yml` and declares it as one
  string. The host loads both shapes identically, but the plugin-market tooling this
  package is submitted to does not: the DSH STORE submission precheck rejects arrays
  outright (`SUBMISSION_BUNDLE_PATCH_INVALID`, checked before any scan), and the
  deepseek1024 catalog's static review gate requires "a non-empty string". `presets/`
  is gone; the preset declaration insert and every design comment moved verbatim into
  `cordis.patch.yml` as its second operation. The loaded operation sequences of both
  layouts were deep-compared with the host's own js-yaml: identical in content and
  order, `!!js` platform switches included. No runtime behavior change.
- `scripts/check-composition.mjs` locates the `preset-router-flash` declaration by id
  among all inserts instead of assuming it is the first operation.
- `install.sh` pins `v0.5.1`.

## 0.5.0 — 2026-11-03 — third-party models stop getting a first turn they cannot use

This change is limited to what a deterministic replay can prove. Replaying
every `router-flash` session on this machine whose model is outside the
DeepSeek family (`scripts/replay-routing.mjs`) gave **13 sessions**: all 13
were narrowed on the first turn, and all 13 still carried prompt guidance for
tools the first-turn schema did not contain (`glob`/`grep`; one also `read`).
The model was told "use the glob tool — not shell find" while `glob` did not
exist yet. That mismatch is the defect this release removes.

### Fixed

- **Preset no longer declares `@deepseek-ai/dsh-tool-subagent-control/list-agents`.**
  DSH 0.2.2-alpha.2 merged `list_agents` into the control package's main entry and
  removed the `./list-agents` subpath export. The old row failed to resolve, the
  loader entry stayed `never started`, and preset validation rejected the whole
  preset (`agent-preset/invalid`) — new sessions could not be created at all.
  The row is gone; `tool-subagent-control` supplies `list_agents` on 0.2.2. On
  hosts ≤ 0.2.1 that tool is simply absent (their main entry registers only
  `send_message` / `interrupt_agent`).
- **The assemble hook no longer reads `assembled.tools`.** 0.2.2-alpha.2 changed
  `system-prompt/assemble` to hand listeners a `PromptPresentation` — sections,
  contexts, variables — with tool declarations owned by the provider (and the
  step's `toolSet` resolved before the hook runs). The old first-turn filter read
  `assembled.tools.map(...)`, which threw `Cannot read properties of undefined
  (reading 'map')` and failed the whole turn within 8 ms. On 0.2.2+ the persona
  still comes from this hook and the first-turn narrowing now registers
  `agent.ctx.tools.restrict({ allow: core + shell })` on `agent/created`, lifting
  it on the first `tools/result`; hosts ≤ 0.2.1 keep the old assemble-time
  filtering (their payload still carries `tools`).

### Changed

- **Third-party models no longer narrow the first turn.** `modelFamily()` now
  splits ids into `flash` / `deepseek` / `longcat` / `third-party`; for
  `third-party` the router returns the full catalog from the first request.
  Persona is untouched: keyword classification still runs by default, exactly as
  in 0.4.1.
- **`thirdPartyGuidance` config key** (`classify` by default, `neutral` for a
  neutral sentence) on the `preset-router-flash` declaration row. `neutral` is
  opt-in only: no controlled comparison has been run on third-party models, and
  an unmeasured persona is not made the default.

### Added

- `scripts/replay-routing.mjs`: replays session logs (multi-frame zstd aware)
  and reports first-turn width, orphaned tool guidance, and the keyword
  classification distribution. `npm run replay` runs it.
- Tests pinning all four families and both third-party policies, including
  that the third-party first turn is always the full catalog.

### Not measured (do not read this as a performance claim)

- Whether a neutral persona helps or hurts on third-party models. That needs a
  controlled A/B with real model calls; until then the default stays `classify`.

### License and attribution

- **HarnessMM is now credited.** The decision-reuse logic in
  `lib/router-core.mjs` (`evaluateGuard`, `shouldBypassCallback`,
  `ChiselPlanScheduler`, `createSubstitutionCertificate`,
  `isRedundantVerification`) and its wiring in `lib/router-bootstrap.mjs` are
  derived from
  [YuhuaJiang2002/HarnessMM](https://github.com/YuhuaJiang2002/HarnessMM)
  (Apache License 2.0, Copyright (c) 2026 PhiAgent-0 contributors). Those parts
  remain available under Apache-2.0; the original license and NOTICE are
  reproduced in `LICENSE-APACHE-2.0` and `NOTICE-HarnessMM`, and the root
  `LICENSE` / `NOTICE` name the exception. Earlier releases carried a blanket
  MIT notice with no HarnessMM credit.

## 0.4.1 — 2026-10-17

Aligning with DSH 0.2.1: restore two rows of capability, fix one reachable
throw, and get the gate back to green.

Nothing already measured changed this round: the persona, the first-turn tool
face, `contexts: []` and `fetch: false` are all untouched. Only two classes of
thing moved — "the host changed and the composition did not follow" and
"written but never wired".

### Fixed

- **`FLASH_NEUTRAL` was undefined** (`router-core.mjs`):
  `personaFor(mode, id, { flashGuidance: false })` threw a `ReferenceError`
  every time, because that constant was never defined. At the same time
  `apply(ctx, config)` never read `config`, so the switch was neither defined
  nor wired. Both ends now work; the default is `flashGuidance: true`
  (behaviour unchanged) and it is a configurable key on the declaration row.
- **Dead code removed**: the `overrides` Map (written, never read); the config
  now reads from `config.flashGuidance`.

### Added

- **`time-context` (the clock)**: the host Web composition does not declare
  this row, while the official standard / cordis / ptc all declare it from
  their presets. Without it the model can only guess at "today" and
  "recently". One reading every 10 minutes by default.
- **`tool-schedule` (timed reminders)**: the four tools
  `schedule_create/list/update/delete`. The official standard has it; this
  preset had been missing the row.
- **Two peers**: `@deepseek-ai/dsh-time-context` and
  `@deepseek-ai/dsh-tool-schedule`, so the host's compatibility gate can judge
  them by name (the rule 0.4.0 established: only what is declared can be
  blocked).

### Changed

- **`plan-mode` wording aligned**: `until exit_plan_mode succeeds` → `until the
  user approves your plan through exit_plan_mode`. The old sentence treated
  "the call succeeded" as the approval condition.
- **Composition drift down to zero** (`npm test` from 4/5 red → 5/5 green):
  after a row-by-row comparison against the official `standard`
  (0.2.1-rc.1), the differences went from 8 unexplained to 12 **all with
  reasons** (including two new explanations: `tool-plugin-market` and
  `tool-subagent-fork`).
- **Documentation wording corrected**: the README no longer implies "the code
  classifies the task type" — for Flash everything takes the weak branch and
  the classification is left to the model reading the persona; the keyword
  classification only serves non-Flash models.

### Tests

- **+3 checks**: the clock row and the schedule row must be in the
  composition; `flashGuidance:false` must fall back to the neutral sentence
  and must never fall back to the spec sentence (P11 reverse routing).

### Measured baseline (0.2.1-rc.1, this round)

| Metric | Value |
|---|---|
| `npm test` | 5/5 pass (4/5 before the fix, exit code 1) |
| One `system-prompt/assemble` | 1.3µs (first turn) / 0.7–0.8µs (after promotion, still 0.7µs at 3000 events) |
| Module load | import 30–90ms (including node startup), RSS +0.5MB |
| persona injection | 663 characters ≈ 166 tokens/turn |
| deepseek-flash cache hit (10-17) | 611 calls, 599,805 uncached input tokens, 113,014,528 cache reads → 99.5% |

## 0.4.0 — 2026-10-17

Breaking: the preset is delivered as a declaration row (DSH 0.2.0-rc.2).

The diagnosis that drove this is one sentence: **0.3.1 does not exist on
0.2.0-rc.2** — it installs, it syncs files on every startup, the logs look
tidy, and the preset roster does not contain it at all.

### Changed

- **Delivery mechanism rebuilt**: DSH 0.2.0 removed the directory-form agent
  preset. Searching all 288 packages in rc.2's dependency tree for
  `.agent-presets` / `agent.cordis.yml` gave **0 hits**; the official migration
  doc's words are *"Nothing reads that directory any more."* The only
  registration path for a preset is the `@deepseek-ai/dsh-agent-preset`
  **plugin row**. This version moves the 312-line composition into a
  declaration row in `presets/router-flash.patch.yml` (`config.id:
  router-flash`, display name 「探索模式」), and `dsh.bundle.patch` becomes an
  array (one file for the host row, one for the declaration).
- **Evidence it landed**: the old version's count on a live host was 0 —
  `Config.listConfigs(name=@deepseek-ai/dsh-agent-preset)` returned only the
  official 4 (standard / ptc / minimal / cordis). After this version composes,
  `--dump-config` contains `- id: preset-router-flash`.
- **Assets moved to in-package subpaths**: `name: ./router-bootstrap.mjs` →
  `dsh-router-flash/router-bootstrap` (rc.2 requires assets to resolve from the
  installed package, no longer allowing references to the preset's own
  directory). `lib/index.js`'s entire disk-sync path was deleted (6.2 KB → a
  read-only check).
- **No more disk writes**: `lib/index.js` now only checks at startup whether
  the old `~/.dsh/.agent-presets/router-flash/` exists, and if so explains in
  the log that it is dead and safe to delete. It does not delete, modify or
  write; any failure in that check degrades to a log line.
- **The compatibility gate grew teeth**: previously `dependencies` /
  `peerDependencies` were both empty, so the host had no way to judge
  compatibility — this round 6 bundles were blocked and skipped for peer
  mismatch, and this one was not among them: **not because it is compatible,
  but because it declared nothing**. It now declares 22 host-package peers
  (`^0.2.0-rc.2`), so a version mismatch makes the host explicitly skip this
  bundle instead of silently doing nothing.

### Drift became a testable failure

- Added `scripts/check-composition.mjs` (part of `npm test`, zero
  dependencies — it borrows `js-yaml` and the official preset files from the
  local dsh runtime). Four assertions each report on their own: ① the
  declaration row is structurally consistent (row id / `config.id` / `plugins`
  shape / no duplicate row ids); ② every self-reference is provided by
  `exports` and the file exists; ③ every `@deepseek-ai/...` row name in the
  composition resolves in the current dsh runtime; ④ the difference set
  against the official `standard` preset is **exactly** the whitelist (one
  extra needs an explanation, one missing must be deleted).
- **Verified to have teeth** (three red tests): swapping `dsh-workflow-ptc`
  back to its old renamed package name turns checks 3 and 4 red at once;
  setting `tool-web`'s `fetch` to `true` turns check 4 red; deleting the router
  row turns check 2 red.
- The 10 differences from the official standard are written into the README's
  difference table one by one, each with a reason; `tool-ralph` is explicitly
  marked as **a real difference, keep-or-drop pending a measurement**.
- Honest boundary: **"is this config key inside that package's schema" is not
  in the offline check's scope** (the schema only exists at runtime). The
  README gives the exact method for checking it with the host's Inspect.

### Compatibility fixes

- `dsh-workflow-worker-thread` → `dsh-workflow-ptc` (the old package no longer
  exists in rc.2, and the row makes the whole preset fail to mount). It had
  already been changed in the workspace; this brings it into the release.
- The `persona` row drops its `text` key: rc.2 only requires `prefix`, and
  `text` is an undeclared key (measured as "kept but read by nobody" = a dead
  key), while writing only `text` fails the whole preset mount with
  `$.prefix missing required value`.
- README: install / upgrade / uninstall / self-check rewritten against the
  rc.2 contract; the default-preset recipe changed from the no-longer-existing
  `~/.dsh/settings.yaml` to overriding the `agent-preset-registry` row's
  `config.default`; added the 「Known differences」 table and the
  「Legacy directory migration」 note.
- `test/router.test.mjs`: paths updated with the composition move (a `dedent`
  added, assertion literals unchanged), plus new delivery-form assertions
  (declaration row id / `config.id` / no more `./` relative references / must
  go through an in-package subpath).

### Measured conclusions (0.2.0-rc.2)

| Seam | Conclusion |
|---|---|
| `system-prompt/assemble` `(assembly, context, next)` | still there (`dsh-system-prompt:355`) |
| `assembly.sections` / `contexts` / `tools` | shape unchanged |
| `session.snapshotEvents()` / `tool/call` / `user/message` | unchanged |
| `dsh-persona` schema | only accepts `prefix` (`text` kept but read by nobody) |
| `dsh-tool-subagent` schema | `enableRunInBackground` and `backgroundMode` coexist |
| bundle compatibility gate | reads `peerDependencies`, looks only at `@deepseek-ai/dsh-*` names, judges by the **dsh runtime version** |

Zero runtime dependencies unchanged: `dependencies` is still empty.

## Earlier (summary; see git log for details)

- **0.3.1** — do not add `command-goal`; the tool face stays exactly aligned
  with the upstream family. Display name changed to 「探索模式」.
- **0.3.0** — back to "fix compatibility only, do not touch behaviour";
  reverted three unmeasured changes.
- **0.2.1** — added `command-goal` (correcting the previous version's
  misjudgement that "the host already provides it").
- **0.2.0** — model- and channel-agnostic (match only on a model id containing
  `deepseek` + `flash`; non-matching models still use the preset through the
  generic classification branch) + tool face aligned with the built-in presets +
  a startup race fixed.
- **0.1.1** — adapted to dsh 0.1.5-rc.2.
