# dsh-router-flash

> 让 **DeepSeek V4 Flash** 从「鬼模式」切换到「神模式」的 dsh agent preset 标准分发包。只要模型 id 同时含 `deepseek` 与 `flash` 就生效，**不绑定任何供应商渠道**。

标准 DSH bundle 插件包：安装后自动把 `router-flash` preset 同步到 `~/.dsh/.agent-presets/router-flash`，重启 DSH 即生效。原 `install.sh` 手动复制方式已由本 bundle 替代。

## 这是什么

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的 agent preset 分发包。它把 [dsh-router-standard](https://github.com/yjh051108/dsh-router-standard) 研究里为 **DeepSeek V4 Flash** 标定的最优引导（w7 persona + 深度思考锚）路由逻辑做成与渠道无关的 preset：**看模型身份，不看 provider**。

**核心问题**：Flash 在默认（无引导）条件下会进入「鬼模式」——思考浅、草草动手、质量差。这不是 Flash 能力不行，而是**引导条件不对**。补上正确的引导（分类 + 回顾 + 反跑题 + 深度思考 + 决策闭环），Flash 就能进入「神模式」——深度规划、高质量交付、自测零错误。

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
dsh plugin --profile web add -w github:xiaoxianyu-office/dsh-router-flash#v0.3.0
```

安装后**重启 DSH**：`router-flash` preset 会被自动安装到 `~/.dsh/.agent-presets/router-flash`。

然后编辑 `~/.dsh/settings.yaml`，把默认 agent preset 指向它，并把模型指向**任意渠道**的 DeepSeek V4 Flash：

```yaml
agent-default-model:
  provider: <你用的渠道>          # 例：opencode-go（已验证）、tokenrhythm、opencode-go-extra
  model: deepseek-v4-flash        # 只要 id 含 deepseek + flash 即命中
  reasoningEffort: max
agent-presets:
  default: router-flash
```

`provider` 填什么由你的渠道决定，本 preset 不做假设。已验证渠道见下。

再次重启 dsh，新会话即使用 `router-flash` preset + 该渠道的 DeepSeek V4 Flash。

## 升级

重复 `add` 并指定最新 tag，**不要使用 update 选择 Git 引用**：

```bash
dsh plugin --profile web add -w github:xiaoxianyu-office/dsh-router-flash#v0.3.0
```

重启 DSH 后，包内变更的 preset 文件会自动覆盖到 `~/.dsh/.agent-presets/router-flash`。

## 卸载

```bash
dsh plugin --profile web remove dsh-router-flash
```

卸载后重启 DSH。注意：bundle 安装的 preset 文件（`~/.dsh/.agent-presets/router-flash`）会保留，如需彻底移除可手动删除该目录，并在 `~/.dsh/settings.yaml` 中移除 `agent-presets.default` 指向。

## 使用

1. 安装并配置后重启 dsh，新会话会自动使用 `router-flash` preset + `deepseek-v4-flash` 模型。
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
| Windows | pwsh（PowerShell） | 未实测；`agent.cordis.yml` 内 `process.platform === 'win32'` 判断会自动禁用 bash、启用 pwsh |

> 核心路由逻辑（persona / 引导 / 模型识别）与操作系统无关。缺 shell 时不再报错，退化为文件工具并写警告。

## 依赖

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）**0.1.5-rc.2 及以上**（本 preset 在 0.1.5-rc.2 上实测通过；0.1.2-alpha.4 之前的事件 API 已不兼容）
- 任意渠道的 DeepSeek V4 Flash 模型（id 含 `deepseek` + `flash`）
- 已验证渠道：`opencode-go`（`https://opencode.ai/zen/go/v1`）、`tokenrhythm`（`https://tokenrhythm.studio/v1`）。两者共用同一套 preset，唯一差异是 `agent-default-model` 里的 `provider` 取值。

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
- 本 preset 保持 `false`（跟随家族）。要开启：把该行的 `fetch` 改成 `true`，并同步改 `preset/router.test.mjs` 里那条断言。

### `command-goal`：模型不可见，但仍跟随家族 → 不补

这里有一个容易搞反的点，先说结论：**不补是决定，不是遗漏。**

- 事实层面：`dsh-base` 任何版本都带这行且**启用**；`dsh-web-app` 从 **0.1.2-alpha.2** 起把它设为 `disabled: true`；官方 preset 在**同一版本**补上该行。这之前（含上游家族的目标版本 `0.1.0-rc.6` / `0.1.1-rc.2`）宿主直接提供 `/goal`。
- 所以上游家族**不是漏写、也不是不想要**：它写那行注释时，宿主确实提供 `/goal`，省略是正确的。缺口只在把同一份 preset 拿到 `0.1.2-alpha.2` 之后（含本机 `0.1.5-rc.2`）跑时才出现。
- 现状（实测 `0.1.5-rc.2`）：不写该行，`commands.list()` = `[compact, feedback, permission, plan]`，也就是**没有 `/goal`**。写了才有 `goal`。
- 为什么还是不加：它虽然不占模型上下文（`dsh-commands` 不注册 prompt 段，已核源码，所以加它零扰动），但**加它就是偏离家族工具面**。本 preset 的定位是「补兼容、不补口味」，`/goal` 属于口味。上游 4 个 preset 一致不带这行，本 preset 也保持一致。
- 要开启：把 `- id: command-goal` / `name: '@deepseek-ai/dsh-command-goal'` 两行加回 goals 段，并同步改 `preset/router.test.mjs` 里的对应断言（那里现在是「必须不存在」）。

### `present`：模型可见的加法 → 跟随家族，不补

- 它进了官方 preset，但**只从 `0.1.5-alpha.2` 起**——社区家族写于更早，属于「没赶上」而非「不想要」。
- 即便如此，它仍是**模型可见**的一项（描述约 464 字符），补进去等于改动家族测过的目录。按同一条规则（模型可见的改动需要测量）不补。要开启：把该行加回 `agent.cordis.yml`（`- id: present` / `name: '@deepseek-ai/dsh-tool-present'`）。

### 规则

**工具面跟随上游家族，不增不减；只补会炸的兼容问题。** 家族明写的（`fetch: false`）、家族没写的（`present`、`command-goal`）都不动——包括那些「加了看起来更好」的项，因为「看起来更好」没有测量支撑，而这一族的全部价值来自它的测量。

`preset/router.test.mjs` 把这条规则变成断言：宿主交还的 22 行必须齐（`command-goal` 除外，它属于上面的决定），`command-goal` 与 `present` 必须不在，`tool-web` 必须 `fetch: false`。

## 宿主所有权移交时间线（goal / present / tool-web）

`/goal`、`present`、`web_fetch` 这三项归属权，在 dsh 的 0.1.x 里**分批**从宿主移交给 preset。逐版本核过 npm 包后的实际时间线：

| 版本 | `dsh-base` | `dsh-web-app` | 官方 preset（standard） |
|---|---|---|---|
| `0.1.0-rc.6` ← 上游家族的目标版本 | `command-goal` **启用** | 不碰该行 | **无**该行（不需要） |
| `0.1.1-rc.2` | `command-goal` **启用** | `tool-web` 已 `disabled` | 无 `command-goal` 行 |
| `0.1.2-alpha.2` | `command-goal` 启用 | `command-goal` 也 `disabled` | **补上** `command-goal` 行 |
| `0.1.5-alpha.2` | 同上 | 同上 | 再补 `present` 行 |
| `0.1.5-rc.2` ← 本机 | 同上 | 23 行全部 `disabled` | 三行齐全 |

关键点：**`tool-web` 的移交早于家族落笔**（家族知道这行归 preset，仍写 `fetch: false`，是刻意取舍）；**`command-goal` 的移交晚于家族落笔**（家族写注释时宿主确实提供 `/goal`，所以它的省略在当时是正确的，不是漏写）。两者性质不同，处理方式也不同。

`dsh-command-goal` 包本身自 `0.0.1-rc.1` 就存在，从来不是新功能——变的只是「谁负责挂它」。

## 版本适配

上游 v0.1.0 只适配到 dsh `0.1.0-rc.6`。在 `0.1.5-rc.2` 上它会**装得上、用不了**。适配策略是**只修兼容、不动行为**：

| 偏差 | 症状 | 修法 |
|---|---|---|
| persona 行只写 `config.text` | `dsh-persona` 自 0.1.5 起要求 `prefix`，该行校验失败即整份 preset 挂载被拒（`agent-preset/invalid`） | 双写 `prefix` + `text`（schemastery 保留未声明键），0.1.2-rc.1 ~ 0.1.5-rc.2 两代都能挂 |
| 读 `session.events` | 该属性已在 0.1.2-alpha.4 被 `eventAt()` / `snapshotEvents()` 取代，每轮提示词装配抛 TypeError | `sessionEvents()` 特性探测：`snapshotEvents()` 优先，回退 `session.events` |
| persona 段位置 | `AssembledSection` 现在只有 `{ name, text }`，没有 `order` 可设，渲染顺序即数组顺序 | 上游「过滤后追加」会把身份句甩到全部工具说明之后（已实测），改为**原位替换** |
| `/goal` 命令缺失 | 宿主自 0.1.2-alpha.2 起不再提供该行，preset 不写就没有 `/goal` | **不修**：属工具面选择（不占模型上下文，但补它偏离家族），见「工具面」一节 |

`contexts: []` 保持上游原样（两个分支都清空）：放行它会往每一轮（尤其首轮）注入约 470 字符的运行时上下文快照，改动最敏感的那一轮需要有测量支撑，目前没有。想要这份可见性的部署请自行决定——那是部署的取舍，不是 preset 的。

## 运行时健壮性

- **preset 改为同步发布**：此前靠 `apply()` 返回 promise 让组合层等待，实测该等待覆盖不到写入——冷启动时名册已扫到目录、组合文件还在 `.tmpdir` 里，整份 preset 报 "the composition file agent.cordis.yml is missing"，会话挂不出来。现在 `apply()` 同步写完再返回，并把 `agent.cordis.yml`（发现逻辑的判定标记）**最后**发布，任何观察者要么看到旧版本、要么看到完整的一套。
- **半成品目录自愈**：目录里只剩 `preset.yml` 的残缺状态，下次启动会被补齐并正常挂载（已实测）。
- **缺 shell 不再致命**：工具目录里既没有 `bash` 也没有 `pwsh` 时，首轮退化为文件工具并写警告，而不是抛错让整轮请求失败。
- **自检文件不进 preset 目录**：只同步 `agent.cordis.yml`、`preset.yml` 与组合点名引用的 `./*.mjs`，`*.test.mjs` 之类开发产物留在包内。

## 适配了什么（相对上游 v0.1.0）

上游依赖三个在 0.1.0-rc.6 上就已失效的机制，本 preset 沿用其修法并补上 0.1.5 的适配：

1. `ctx.on('session/event')` 注入 —— session/event 是 session-scoped，agent-plane preset 收不到。
2. `target.inbox.append` —— agent 对象没有 `.inbox` 属性。
3. assemble 时事件里还没有 user/message —— 时序问题。

**修复方式**：把引导静态合并进 `WEAK_FLASH` persona，不依赖任何动态注入机制。

## 自检

```bash
node preset/router.test.mjs
```

覆盖纯逻辑分支：模型识别（DeepSeek Flash 命中、同名 flash 的其他家族不命中）、persona 原位替换与去重、首轮工具面（core + 平台 shell）、首次 `tool/call` 后放开全目录、运行时上下文保留、关键词分类，以及缺 shell 时的降级告警。

## 适用范围

- 命中 `isFlashModel` 后一律走 weak 模式（作者实测 w7 最优解）。
- 非 DeepSeek Flash 模型（如 `deepseek-v4-pro`、`gemini-2.5-flash`）走关键词分类逻辑，仍可用。
- 复杂构建任务（如大型工程、从零开发）尤其受益于深度思考锚。

## 包结构

```
dsh-router-flash/
├── package.json      # dsh.bundle（组合补丁）+ dsh.client（标准双面）声明
├── cordis.patch.yml  # 组合补丁：insert dsh-router-flash 插件行
├── lib/
│   ├── index.js      # host 端：启动时同步安装 preset 到 ~/.dsh/.agent-presets
│   └── client.js     # client 端：空实现占位（无浏览器 UI）
├── preset/           # router-flash agent preset 本体（只有运行时要读的文件会被安装）
│   ├── preset.yml
│   ├── agent.cordis.yml
│   ├── router-bootstrap.mjs
│   ├── router-core.mjs
│   └── router.test.mjs   # 纯逻辑自检（node preset/router.test.mjs），不安装到用户目录
```

## 说明

- host 插件写 `~/.dsh/.agent-presets/router-flash` 用 Node 原生文件 API（`mkdirSync` / `writeFileSync` + `renameSync`），不走 `ctx.fs`：这条写入发生在宿主平面（尚无会话），且此前已显式声明 `danger-full-access`，策略等价；换成同步是出于启动时序（见「运行时健壮性」），不是绕过策略。
- preset 同步为幂等内容比对：无变化不写入；升级时包内变更文件覆盖目标；不删除目标目录中包内没有的文件。
- 冷启动压测：把 preset 目录移走后连续 10 次冷启动，10/10 一次到位；半成品目录（只有 `preset.yml`）1 次启动内自愈。
- 卸载 bundle 不会自动删除已安装的 preset 文件，避免误删用户修改。

## 致谢与来源

本仓库是衍生作品，内容来源如下：

| 项目 | 作者 | 许可 | 用途 |
|---|---|---|---|
| [SheberDavid/v4-flash-godmode-opencode-go](https://github.com/SheberDavid/v4-flash-godmode-opencode-go) | SheberDavid | 无独立 LICENSE（其 README 声明基于 MIT 项目） | `preset/` 本体与 dsh rc.6 适配逻辑的直接来源 |
| [dsh-router-standard](https://github.com/yjh051108/dsh-router-standard) | yjh051108 | MIT（© 2026 yjh051108） | Flash w7 persona、深度思考锚与路由研究的源头 |
| [dsh-routing-suite](https://github.com/yjh051108/dsh-routing-suite) | yjh051108 | MIT | 路由研究 |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | DeepSeek | MIT | 宿主框架 |

本仓库新增的 bundle 包装层（`package.json` / `cordis.patch.yml` / `lib/`）为本仓库独立新增代码。

完整许可与衍生链说明见 [LICENSE](./LICENSE) 与 [NOTICE](./NOTICE)。DeepSeek 是 DeepSeek 公司商标；本项目为社区产物，与 DeepSeek 无关联。
