# 探索模式（dsh-router-flash）

> DeepSeek V4 Flash 的 dsh agent preset。模型 id 同时含 `deepseek` 与 `flash` 即生效，不绑定渠道。

安装后 patch 层里就带了一条 `@deepseek-ai/dsh-agent-preset` 声明行，重启 DSH 即生效——**没有任何落盘同步**。要求 dsh **0.2.0-rc.2 及以上**（0.2.0 起 preset 是插件行，旧形态的 preset 目录已不再被读取）。

它做的事：先判断任务是「建」还是「修」，按类型选引导；首轮只给核心工具（`read` / `write` / `edit` + 平台 shell），首次工具调用后放开全部工具。

## 命中规则（渠道无关）

```
isFlashModel(modelId) = /deepseek/i.test(modelId) && /flash/i.test(modelId)
```

| 模型 id | 命中 | 路由 |
|---|---|---|
| `deepseek-v4-flash` | 是 | weak（w7 引导，本 preset 的主体） |
| `deepseek-v4-flash-0731`、`deepseek-v4-flash-vision-exp` | 是 | weak |
| `deepseek-v4-pro`、`deepseek-chat` | 否 | 首条用户消息关键词分类（build/fix） |
| `gemini-2.5-flash`、`qwen3-flash`、`gpt-5-flash` | 否 | 同上 |

**为什么不是只匹配 `flash`**：那样会把 `gemini-2.5-flash`、`qwen3-flash` 这类非 DeepSeek 模型一起卷进本 preset 的弱 persona，对它们是负优化。未命中的模型仍能用本 preset，只是走通用分类分支。

**为什么不是绑定 `opencode-go`**：模型能力取决于模型本身，不取决于谁在转卖它。任何渠道的 DeepSeek V4 Flash 都该拿到同一套引导；渠道差异用 `provider` 配置表达，不进 preset。


## 安装

```bash
dsh plugin --profile web add -w github:xiaoxianyu-office/dsh-router-flash#v0.4.0
```

安装后**重启 DSH**：`router-flash` preset 会以显示名「探索模式」出现在预设选择器里。

然后把模型指向**任意渠道**的 DeepSeek V4 Flash——`provider` 填什么由你的渠道决定，本 preset 不做假设（已验证渠道见下）。模型路由在 profile 的 `cordis.patch.yml` 里配宿主 `dsh-agent-default-model` 行，或直接在界面上的模型选择器里选。新会话选用「探索模式」即可。

想让**默认预设**就是它，在 profile 的 `cordis.patch.yml` 里覆盖注册表那行（preset 的默认值由它决定）：

```yaml
- id: agent-preset-registry
  name: '@deepseek-ai/dsh-agent-preset-registry'
  config:
    default: router-flash
```

> 0.2.0 起 `~/.dsh/settings.yaml` 的 `agent-presets.default` 已不存在。若你照着旧文档改过，那处配置现在既不被读、也不会报错——删掉即可。

## 升级

```bash
dsh plugin --profile web add -w github:xiaoxianyu-office/dsh-router-flash#v0.4.0
```

重启 DSH 后声明行随补丁层换新，**没有需要覆盖的用户目录**。

**0.3.x → 0.4.0 的独有一步**：0.3.x 会把 preset 文件同步到 `~/.dsh/.agent-presets/router-flash/`，那个目录在 0.2.0-rc.2 上已不被读取（详见「版本适配」）。插件启动时会检查它并在日志里给出提醒，确认升级完成重启后即可手动删除——插件本身只做只读体检，不会替你删。

## 卸载

```bash
dsh plugin --profile web remove dsh-router-flash
```

重启后声明行随补丁层一起消失，presets 名册里不再有它。若还有 0.3.x 留下的旧目录，需手动删除。

## 使用

1. 安装后重启 dsh，在新会话的预设选择器里选「探索模式」。
2. 直接提交任务即可。persona 会自动注入「分类 + 回顾 + 反跑题 + 深度思考 + 决策闭环」五个锚。
3. 会话启动后，模型的 system prompt 应包含：
   ```
   You are a helpful assistant.
   Before acting, decide the task type (build or fix)...
   Before acting, briefly review what you have already done...
   Do not run environment checks (echo, whoami, uname...)...
   Think deeply about the architecture, edge cases...
   Produce when your information is complete...
   ```

## 跨平台支持

本 preset **三平台通用**，dsh 会自动选择 shell 工具：

| 系统 | shell | 状态 |
|---|---|---|
| macOS | bash | 实测通过（本轮验证环境） |
| Linux | bash | 未实测；走同一 bash 分支 |
| Windows | pwsh（PowerShell） | 未实测；`presets/router-flash.patch.yml` 内 `process.platform === 'win32'` 判断会自动禁用 bash、启用 pwsh |

> 核心路由逻辑（persona / 引导 / 模型识别）与操作系统无关。缺 shell 时不再报错，退化为文件工具并写警告。

## 依赖

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）**0.2.0-rc.2 及以上**。本 preset 在 0.2.0-rc.2 上实测通过；0.2.0 之前是目录形态的 preset，本包 0.4.0 起不再支持。
- 任意渠道的 DeepSeek V4 Flash 模型（id 含 `deepseek` + `flash`）
- 已验证渠道：`opencode-go`（`https://opencode.ai/zen/go/v1`）、`tokenrhythm`（`https://tokenrhythm.studio/v1`）。两者共用同一套 preset，唯一差异是模型路由里的 `provider` 取值。

组合要挂的 22 个宿主插件包全部写进了 `peerDependencies`，版本范围统一为 `^0.2.0-rc.2`。这不是装饰：宿主按它判定 bundle 兼容性，**版本对不上时会在启动日志里明确跳过本 bundle，而不是装上了却一行都不生效**（那正是 0.3.x 在 rc.2 上的真实状态）。

## 工具面：限制的性质有两种，本 preset 分别处理

`dsh-web-app`（Web 宿主 bundle）在宿主层把 **23 个 agent 面行设为 `disabled: true`**，注释写明 **「Presets own the human command and model-facing tool」**，涵盖 `tool-web` / `command-goal` / `tool-goal` / `tool-bash` … 等模型与命令入口。**所以在 Web 部署里，preset 少写一行 = 该能力对该 preset 的 agent 直接不存在。**

上游与同类插件在这块**一致地做了限制**：

| 行 | godmode / router-standard 一系 | 锚定系（apex / anchored-flash / liangshen / anchored-standard） | dsh 内置 minimal / ptc / standard / cordis |
|---|---|---|---|
| `tool-web` → `web_fetch` | `fetch: false`（6/6） | `fetch: false`（4/4） | `fetch: true` |
| `command-goal`（`/goal`） | 缺失（6/6） | 缺失（4/4） | 有 |
| `present`（交付物呈现） | 缺失（6/6） | 缺失（4/4） | 有（0.1.5-alpha.2 起） |

但这两条限制的**性质不同**，处理方式因此不同。

### `web_fetch`：模型可见的减法 → 跟随家族，保持 `false`

- 这是家族**刻意**写的行，不是抄漏：`dsh-web-app` 自 `0.1.1-rc.2` 起就禁用了宿主 `tool-web` 行（早于家族落笔），家族知道这行归 preset，仍写 `fetch: false` 而把 `search` 留着。
- 它是**模型可见**的减法（`web_fetch` 的 schema 进模型目录），去掉它需要测量，而 9 个 preset 的文档里对这条一个字都没解释，也没有任何测量。
- 它是**真关掉**：`dsh-tool-web` 的 `apply()` 末尾是 `if (resolved.fetch) applyWebFetchTool(...)`，条件不成立就完全不注册。
- **但部署自己表态时会被绕过**（实测）：部署层写一条显式 `tool-web` 行（如 `fetch: true`），生效的是部署那条，preset 的取值不参与；只有在无人表态时，这一行才体现为「扣掉宿主默认」。所以这条限制「该管的地方管不到，不该扣的地方扣掉」——它是家族的习惯，不是安全或测量结论。
- 本 preset 保持 `false`（跟随家族）。要开启：把该行的 `fetch` 改成 `true`，并同步改 `test/router.test.mjs` 里那条断言。

### `command-goal`：模型不可见，但仍跟随家族 → 不补

这里有一个容易搞反的点，先说结论：**不补是决定，不是遗漏。**

- 事实层面：`dsh-base` 任何版本都带这行且**启用**；`dsh-web-app` 从 **0.1.2-alpha.2** 起把它设为 `disabled: true`；官方 preset 在**同一版本**补上该行。这之前（含上游家族的目标版本 `0.1.0-rc.6` / `0.1.1-rc.2`）宿主直接提供 `/goal`。
- 所以上游家族**不是漏写、也不是不想要**：它写那行注释时，宿主确实提供 `/goal`，省略是正确的。缺口只在把同一份 preset 拿到 `0.1.2-alpha.2` 之后（含本机 `0.1.5-rc.2`）跑时才出现。
- 现状（实测 `0.1.5-rc.2`）：不写该行，`commands.list()` = `[compact, feedback, permission, plan]`，也就是**没有 `/goal`**。写了才有 `goal`。
- 为什么还是不加：它虽然不占模型上下文（`dsh-commands` 不注册 prompt 段，已核源码，所以加它零扰动），但**加它就是偏离家族工具面**。本 preset 的定位是「补兼容、不补口味」，`/goal` 属于口味。上游 4 个 preset 一致不带这行，本 preset 也保持一致。
- 要开启：把 `- id: command-goal` / `name: '@deepseek-ai/dsh-command-goal'` 两行加回 goals 段，并同步改 `test/router.test.mjs` 里的对应断言（那里现在是「必须不存在」）。

### `present`：模型可见的加法 → 跟随家族，不补

- 它进了官方 preset，但**只从 `0.1.5-alpha.2` 起**——社区家族写于更早，属于「没赶上」而非「不想要」。
- 即便如此，它仍是**模型可见**的一项（描述约 464 字符），补进去等于改动家族测过的目录。按同一条规则（模型可见的改动需要测量）不补。要开启：把该行加回 `agent.cordis.yml`（`- id: present` / `name: '@deepseek-ai/dsh-tool-present'`）。

### 规则

**工具面跟随上游家族，不增不减；只补会炸的兼容问题。** 家族明写的（`fetch: false`）、家族没写的（`present`、`command-goal`）都不动——包括那些「加了看起来更好」的项，因为「看起来更好」没有测量支撑，而这一族的全部价值来自它的测量。

`test/router.test.mjs` 把这条规则变成断言：宿主交还的 22 行必须齐（`command-goal` 除外，它属于上面的决定），`command-goal` 与 `present` 必须不在，`tool-web` 必须 `fetch: false`。

## 宿主所有权移交时间线（goal / present / tool-web）

`/goal`、`present`、`web_fetch` 这三项归属权，在 dsh 的 0.1.x 里**分批**从宿主移交给 preset。逐版本核过 npm 包后的实际时间线：

| 版本 | `dsh-base` | `dsh-web-app` | 官方 preset（standard） |
|---|---|---|---|
| `0.1.0-rc.6` ← 上游家族的目标版本 | `command-goal` **启用** | 不碰该行 | **无**该行（不需要） |
| `0.1.1-rc.2` | `command-goal` **启用** | `tool-web` 已 `disabled` | 无 `command-goal` 行 |
| `0.1.2-alpha.2` | `command-goal` 启用 | `command-goal` 也 `disabled` | **补上** `command-goal` 行 |
| `0.1.5-alpha.2` | 同上 | 同上 | 再补 `present` 行 |
| `0.1.5-rc.2` | 同上 | 23 行全部 `disabled` | 三行齐全 |
| `0.2.0-rc.2` ← 本机 | `command-goal` 仍启用 | `command-goal` / `tool-ralph` / `tool-web` 三行均 `disabled` | 三行齐全（另加 `tool-plugin-manager`，`disabled`） |

关键点：**`tool-web` 的移交早于家族落笔**（家族知道这行归 preset，仍写 `fetch: false`，是刻意取舍）；**`command-goal` 的移交晚于家族落笔**（家族写注释时宿主确实提供 `/goal`，所以它的省略在当时是正确的，不是漏写）。两者性质不同，处理方式也不同。

`dsh-command-goal` 包本身自 `0.0.1-rc.1` 就存在，从来不是新功能——变的只是「谁负责挂它」。

## 版本适配

策略始终是**只修兼容、不动行为**。上游 v0.1.0 只适配到 dsh `0.1.0-rc.6`，在 `0.1.5-rc.2` 上会装得上、用不了。

### 0.2.0-rc.2（0.4.0 本轮）

| 偏差 | 症状 | 修法 |
|---|---|---|
| preset 目录形态被移除 | `$DSH_HOME/.agent-presets/<id>/` 已无人读取（rc.2 依赖树 288 个包全树检索 0 命中；官方迁移文档原话 "Nothing reads that directory any more."）。**实测症状最狠**：插件装上了、每次启动照旧同步文件、留一屋子日志，而 preset 名册里根本没有它 | 改为 bundle patch 里的 `@deepseek-ai/dsh-agent-preset` 声明行；删掉全部落盘同步 |
| 组合里的相对模块引用 | `name: ./router-bootstrap.mjs` 在声明行里无处可解析（rc.2 要求资产从已安装的包解析） | 改为包内子路径导出 `dsh-router-flash/router-bootstrap`（由 `exports` 声明） |
| `dsh-workflow-worker-thread` 已改名 | 该包在 rc.2 不存在（→ `dsh-workflow-ptc`），该行会让整份 preset 挂载失败 | 行 id 与包名同步改名 |
| persona 的 `text` 键 | rc.2 的 schema 只认 `prefix`；`text` 是未声明键，实测「保留但无人读」= 死键 | 删掉 `text`，只留 `prefix` |
| 兼容门禁看不见本包 | 0.3.x 的 `dependencies`/`peerDependencies` 全是空的，宿主无从判定它与运行时的关系——本轮有 6 个 bundle 因 peer 不匹配被拦，本包不在其中，**不是因为它兼容，而是因为它什么都没声明** | 声明 22 个宿主包 peer（`^0.2.0-rc.2`），让门禁能拦 |
| README 的默认预设配方 | `~/.dsh/settings.yaml` 在 rc.2 上已不存在 | 改为覆盖 `agent-preset-registry` 行的 `config.default` |

实测**仍然在线**、因此一行未改的接缝：`system-prompt/assemble` 仍是 `(assembly, context, next)`（`dsh-system-prompt:355`）；`assembly.sections` / `contexts` / `tools` 形状未变；`session.snapshotEvents()`、`tool/call`、`user/message` 事件名未变。这也是本 preset 的路由逻辑能原样搬过来的原因。

### 0.1.5-rc.2（0.3.0 的历史适配，保留记录）

| 偏差 | 症状 | 修法 |
|---|---|---|
| persona 行只写 `config.text` | `dsh-persona` 自 0.1.5 起要求 `prefix`，该行校验失败即整份 preset 挂载被拒（`agent-preset/invalid`） | 双写 `prefix` + `text`（schemastery 保留未声明键），0.1.2-rc.1 ~ 0.1.5-rc.2 两代都能挂。**0.4.0 起已不需要**，`text` 已删 |
| 读 `session.events` | 该属性已在 0.1.2-alpha.4 被 `eventAt()` / `snapshotEvents()` 取代，每轮提示词装配抛 TypeError | `sessionEvents()` 特性探测：`snapshotEvents()` 优先，回退 `session.events` |
| persona 段位置 | `AssembledSection` 现在只有 `{ name, text }`，没有 `order` 可设，渲染顺序即数组顺序 | 上游「过滤后追加」会把身份句甩到全部工具说明之后（已实测），改为**原位替换** |
| `/goal` 命令缺失 | 宿主自 0.1.2-alpha.2 起不再提供该行，preset 不写就没有 `/goal` | **不修**：属工具面选择（不占模型上下文，但补它偏离家族），见「工具面」一节 |

`contexts: []` 保持上游原样（两个分支都清空）：放行它会往每一轮（尤其首轮）注入约 470 字符的运行时上下文快照，改动最敏感的那一轮需要有测量支撑，目前没有。想要这份可见性的部署请自行决定——那是部署的取舍，不是 preset 的。

## 组合与官方 standard 的已知差异

`presets/router-flash.patch.yml` 的 27 行里有 26 行指向别人的包（96%）。为了让「上游改了、这里没跟」不再静默，差异被固化成一张必须逐条给理由的表，并由 `npm test` 强制：**与官方 `standard` preset 的差异集必须恰好等于白名单**，多一条要解释，少一条要删（防腐化）。

| 行 | 性质 | 理由 |
|---|---|---|
| `router-bootstrap` | 只本 preset 有 | 路由器本身 |
| `command-goal` / `present` / `tool-plugin-manager` | 只官方有 | 家族工具面：不补（前两者见「工具面」；插件管理面属宿主/部署层） |
| `persona` | 取值不同 | 身份句不同且无 `suffix`；本行只是 fallback，装配时被路由器整体替换 |
| `tool-ralph` | 取值不同 | 官方 `disabled: true`，本 preset 启用——**真实差异，待一次测量决定去留** |
| `tool-subagent` | 取值不同 | 缺 0.2.0 新增的 `modelSelectionSettings: true`（模型可见加法，未测量不跟） |
| `tool-subagent-codex` / `-claude-code` | 取值不同 | 两行本就 `disabled: true`，取法差异不可观测 |
| `tool-web` | 取值不同 | 家族取值 `fetch: false`（模型可见减法，未测量不改） |

补充说明：**「config 键是否在该包的 schema 里」不在离线检查范围内**——那份 schema 只在运行时存在。要查它用宿主 Inspect：`cordis_inspect_query` → `host/Config/listConfigs {name: "@deepseek-ai/dsh-<包名>"}`。

## 运行时健壮性

- **不再写盘**：0.4.0 起 preset 由组合层交付。插件启动时只做一次只读体检（旧的 `.agent-presets/router-flash` 是否还在），并把这唯一一件事的失败降级成日志——说明性插件绝不该让宿主起不来。
- **缺 shell 不再致命**：工具目录里既没有 `bash` 也没有 `pwsh` 时，首轮退化为文件工具并写警告，而不是抛错让整轮请求失败。
- **崩溃面收窄**：路由逻辑只依赖三个接缝（`system-prompt/assemble` 事件、工具目录、会话事件），任一接缝变了也只是退化或告警，不抛错穿透到整轮请求。

## 适配了什么（相对上游 v0.1.0）

上游依赖三个在 0.1.0-rc.6 上就已失效的机制，本 preset 沿用其修法并补上 0.1.5 的适配：

1. `ctx.on('session/event')` 注入 —— session/event 是 session-scoped，agent-plane preset 收不到。
2. `target.inbox.append` —— agent 对象没有 `.inbox` 属性。
3. assemble 时事件里还没有 user/message —— 时序问题。

**修复方式**：把引导静态合并进 `WEAK_FLASH` persona，不依赖任何动态注入机制。

## 自检

```bash
npm test          # = node test/router.test.mjs && node scripts/check-composition.mjs
```

**不需要 `npm install`**：本包零依赖，体检脚本从本机的 dsh 运行时借 `js-yaml` 与官方 preset 文件。

- `test/router.test.mjs` —— 纯逻辑回归：模型识别（DeepSeek Flash 命中、同名 flash 的其他家族不命中）、persona 原位替换与去重、首轮工具面（core + 平台 shell）、首次 `tool/call` 后放开全目录、运行时上下文保留、关键词分类、缺 shell 时的降级告警，以及交付形态自洽（声明行 id / `config.id` / 包子路径引用）。
- `scripts/check-composition.mjs` —— 契约体检，四条断言各自报出：①声明行结构自洽；②自有引用都能由 `exports` 提供且文件存在；③组合里每个 `@deepseek-ai/...` 行名都能在当前 dsh 运行时里解析（**改名漂移的拦网**）；④与官方 `standard` 的差异集恰好等于白名单。找不到 dsh 时明确报 SKIP 而非假装通过；`--strict` 把 SKIP 升级为 FAIL。

## 适用范围

- 命中 `isFlashModel` 后一律走 weak 模式（作者实测 w7 最优解）。
- 非 DeepSeek Flash 模型（如 `deepseek-v4-pro`、`gemini-2.5-flash`）走关键词分类逻辑，仍可用。
- 复杂构建任务（如大型工程、从零开发）尤其受益于深度思考锚。

## 包结构

```
dsh-router-flash/
├── package.json                     # dsh.bundle（两条补丁）+ dsh.client + 22 条 peer 声明
├── cordis.patch.yml                 # 补丁 1：insert dsh-router-flash 宿主行（旧目录体检）
├── presets/
│   └── router-flash.patch.yml       # 补丁 2：@deepseek-ai/dsh-agent-preset 声明行（组合本体，27 行）
├── lib/
│   ├── index.js                     # host 端：只读体检旧形态目录，不再写盘
│   ├── client.js                    # client 端：空实现占位（无浏览器 UI）
│   ├── router-bootstrap.mjs         # 路由器：assemble 钩子（persona 路由 + 首轮工具面）
│   └── router-core.mjs              # 路由纯逻辑：模式识别 / persona / 工具面（零依赖）
├── test/router.test.mjs             # 纯逻辑自检
└── scripts/check-composition.mjs    # 契约体检（结构 / 引用 / 可解析 / 基线差异白名单）
```

`dsh.bundle.patch` 是**数组**（官方 `dsh-web-app` 也这么用）：宿主行与 preset 声明各自一个文件，改哪半边就 diff 哪半边。

## 说明

- host 插件**不再写盘**。0.3.x 曾用 Node 原生文件 API 同步 preset 目录（为了绕开启动时序），0.4.0 起整个写入路径消失——preset 走组合层，插件只剩一次只读体检。
- 覆盖 preset 用 Loader 行 id（`preset-router-flash`）在 profile 的 `cordis.patch.yml` 里整段替换 `config`；**覆盖是整体替换，漏字段即丢字段**，所以覆盖时要把 `id`/`plugins` 一并重述。
- 行 id `preset-router-flash` 是 Loader 地址，`config.id: router-flash` 才是会话记住的身份。改名会让老会话认不回自己的 preset，因此固定不动。

## 致谢与来源

本仓库是衍生作品，内容来源如下：

| 项目 | 作者 | 许可 | 用途 |
|---|---|---|---|
| [SheberDavid/v4-flash-godmode-opencode-go](https://github.com/SheberDavid/v4-flash-godmode-opencode-go) | SheberDavid | 无独立 LICENSE（其 README 声明基于 MIT 项目） | `presets/` 组合本体与 dsh rc.6 适配逻辑的直接来源 |
| [dsh-router-standard](https://github.com/yjh051108/dsh-router-standard) | yjh051108 | MIT（© 2026 yjh051108） | Flash w7 persona、深度思考锚与路由研究的源头 |
| [dsh-routing-suite](https://github.com/yjh051108/dsh-routing-suite) | yjh051108 | MIT | 路由研究 |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | DeepSeek | MIT | 宿主框架 |

本仓库新增的 bundle 包装层（`package.json` / `cordis.patch.yml` / `presets/` / `lib/` / `scripts/`）为本仓库独立新增代码。

完整许可与衍生链说明见 [LICENSE](./LICENSE) 与 [NOTICE](./NOTICE)。DeepSeek 是 DeepSeek 公司商标；本项目为社区产物，与 DeepSeek 无关联。
