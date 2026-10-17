# Changelog

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
