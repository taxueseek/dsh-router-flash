# Changelog

## 0.4.0

### 破坏性：preset 改为声明行交付（DSH 0.2.0-rc.2）

驱动的诊断结论是一句话：**0.3.1 在 0.2.0-rc.2 上等于不存在**——装得上、每次启动照旧同步文件、日志齐整，而 preset 名册里根本没有它。

- **交付机制重做**：DSH 0.2.0 移除了目录形态的 agent preset。rc.2 依赖树 288 个包全树检索 `.agent-presets` / `agent.cordis.yml` 为 **0 命中**，官方迁移文档原话是 *"Nothing reads that directory any more."*；preset 的唯一注册路径是 `@deepseek-ai/dsh-agent-preset` **插件行**。本版把 312 行组合搬进 `presets/router-flash.patch.yml` 的声明行（`config.id: router-flash`，显示名「探索模式」），`dsh.bundle.patch` 改为数组（宿主行 + 声明各一个文件）。
- **落到实处的证据**：旧版在活体宿主上的编号是 0——`Config.listConfigs(name=@deepseek-ai/dsh-agent-preset)` 只返回官方 4 条（standard / ptc / minimal / cordis）。本版 compose 后 `--dump-config` 里出现 `- id: preset-router-flash`。
- **资产改走包内子路径**：`name: ./router-bootstrap.mjs` → `dsh-router-flash/router-bootstrap`（rc.2 要求从已安装的包解析资产，不再允许引用 preset 自身目录）。`lib/index.js` 的落盘同步整段删除（6.2 KB → 只读体检）。
- **不再写盘**：`lib/index.js` 现在只在启动时检查旧的 `~/.dsh/.agent-presets/router-flash/` 是否存在，存在就在日志里说明它已失效、可安全删除。不删、不改、不写；该检查的任何失败都降级为日志。
- **兼容门禁装上了牙**：此前 `dependencies` / `peerDependencies` 全空，宿主无从判定兼容性——本轮有 6 个 bundle 因 peer 不匹配被拦并跳过，本包不在其中：**不是因为它兼容，而是因为它什么都没声明**。现在声明 22 个宿主包 peer（`^0.2.0-rc.2`），版本对不上时宿主会明确跳过本 bundle 而不是静默失效。

### 漂移变成可测的失败

- 新增 `scripts/check-composition.mjs`（`npm test` 的一部分，零依赖——从本机 dsh 运行时借 `js-yaml` 与官方 preset 文件）。四条断言各自报出：①声明行结构自洽（行 id / `config.id` / `plugins` 形状 / 行 id 不重复）；②自有引用必须由 `exports` 提供且文件存在；③组合里每个 `@deepseek-ai/...` 行名都能在当前 dsh 运行时里解析；④与官方 `standard` preset 的差异集**恰好等于**白名单（多一条要解释，少一条要删）。
- **已验证有牙**（三条红测）：把 `dsh-workflow-ptc` 换回已改名的旧包名 → 检查 3 与 4 同时变红；把 `tool-web` 的 `fetch` 改成 `true` → 检查 4 变红；删掉路由器行 → 检查 2 变红。
- 与官方 standard 的 10 处差异逐条写进 README 的差异表并各带理由；其中 `tool-ralph` 被明确标注为**真实差异、待一次测量决定去留**。
- 诚实边界：**「config 键是否在该包 schema 内」不在离线检查范围**（schema 只在运行时存在）。README 给出用宿主 Inspect 查它的确切方法。

### 兼容性修复

- `dsh-workflow-worker-thread` → `dsh-workflow-ptc`（rc.2 里旧包已不存在，该行会让整份 preset 挂载失败）。此前已在工作区改过，本次一并纳入。
- `persona` 行删掉 `text` 键：rc.2 只要求 `prefix`，`text` 是未声明键（实测「保留但无人读」= 死键），而只写 `text` 会以 `$.prefix missing required value` 让整份 preset 挂载失败。
- README：安装/升级/卸载/自检按 rc.2 契约重写；默认预设的配方从已不存在的 `~/.dsh/settings.yaml` 改为覆盖 `agent-preset-registry` 行的 `config.default`；补「已知差异」表与「旧目录迁移」说明。
- `test/router.test.mjs`：随组合搬迁更新路径（新增 dedent，断言字面不变），并新增交付形态断言（声明行 id / `config.id` / 不得再有 `./` 相对引用 / 必须走包子路径）。

### 实测结论（0.2.0-rc.2）

| 接缝 | 结论 |
|---|---|
| `system-prompt/assemble` `(assembly, context, next)` | 仍在（`dsh-system-prompt:355`） |
| `assembly.sections` / `contexts` / `tools` | 形状未变 |
| `session.snapshotEvents()` / `tool/call` / `user/message` | 未变 |
| `dsh-persona` schema | 只认 `prefix`（`text` 保留但无人读） |
| `dsh-tool-subagent` schema | `enableRunInBackground` 与 `backgroundMode` 并存 |
| bundle 兼容门禁 | 读 `peerDependencies`，只看 `@deepseek-ai/dsh-*` 的名字，按 **dsh 运行时版本**判定 |

零运行时依赖不变：`dependencies` 仍为空。

## 更早（摘要，详见 git log）

- **0.3.1** — 不补 `command-goal`，工具面与上游家族完全一致；显示名改为「探索模式」。
- **0.3.0** — 回到「只修兼容、不动行为」，撤回三处无测量的改动。
- **0.2.1** — 补 `command-goal`（修正上一版对「宿主已提供」的误判）。
- **0.2.0** — 渠道无关化（只认模型 id 含 `deepseek` + `flash`）+ 工具面对齐内建 preset + 修启动竞态。
- **0.1.1** — 适配 dsh 0.1.5-rc.2。
