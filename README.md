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
dsh plugin --profile web add -w github:xiaoxianyu-office/dsh-router-flash#v0.2.0
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
dsh plugin --profile web add -w github:xiaoxianyu-office/dsh-router-flash#v0.2.0
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

## 工具面：与内置 standard preset 对齐

本 preset 从 dsh-router-standard 一系继承了两处**削减**，v0.2.0 已按证据恢复：

| 行 | godmode / router-standard 一系 | dsh 内置 minimal / ptc / standard / cordis | 本 preset 取值 |
|---|---|---|---|
| `tool-web` → `web_fetch` | `fetch: false`（不注册该工具） | `fetch: true` | **`true`** |
| `present`（交付物呈现） | 整行缺失 | 有 | **补上** |
| `command-goal`（`/goal` 斜杠命令） | 缺失 | 有 | 不补（理由见下） |

**为什么恢复 `web_fetch`**：这是渠道无关的判定，不是口味问题。宿主的 `dsh-base` 默认就挂 `dsh-web-fetch-http` 并设 `fetch: true`；本机 web profile 的 `cordis.patch.yml` 更把 `fetch` 当作 toggle 覆写（注释写着「按需开启 / 关闭」）。也就是说**抓取能力归部署决定，归渠道决定——唯独不该由路由预设替用户关掉**。核过 `dsh-tool-web` 源码：`fetch: false` 时 `applyWebFetchTool` 整个不执行（`apply()` 末尾的 `if (resolved.fetch) applyWebFetchTool(...)`），`web_fetch` 彻底从工具目录消失，而不是保留但受限。安全侧没有理由削减：http fetch provider 匿名（不发凭证）、拒绝 URL 内嵌凭证、只解析公网地址、连接锁定已校验地址、重定向不跨源、字节/字符/超时全有上限、带显式 User-Agent（见其 README）。
上游为什么关，**查不到理由**：godmode 与 router-standard 三个 preset 全写着 `fetch: false`，两边的 README / CHANGELOG / docs 一个字都没解释，属无因继承。

**为什么补 `present`**：内置三个 preset 都有、router 一系全没有。它负责把 agent 产出的文件登记成交付物给 Web UI 渲染。没有它 agent 照样能写文件，但**没法把文件交到用户手上**。它依赖的 `fs` 与 `sessionProjections` 都由 `dsh-base` 提供，且不在首轮核心工具面里，对路由那一轮零成本。

**为什么不补 `command-goal`**：本机 web profile 已经在宿主组合里挂了这一行（来自 `dsh-web-app`）。preset 再挂会向同一个命令表注册同名命令，靠 cordis 的「后注册的遮蔽先注册的」生效——这是重复注册，不是新能力。纯 headless 宿主里它确实缺失，但那一层属于宿主组装的决定（`dsh-web-app` 管），不该由路由预设代管。

## 版本适配（v0.1.1，v0.2.0 沿用）

上游 v0.1.0 只适配到 dsh `0.1.0-rc.6`。在 `0.1.5-rc.2` 上它会**装得上、用不了**，三处必须修的偏差：

| 偏差 | 症状 | 修法 |
|---|---|---|
| persona 行用 `config.text` | 该行 config 校验失败（`dsh-persona` 的 `prefix` 是必填），整份 preset 挂载被拒，会话报 `agent-preset/invalid` | 改用 `prefix` |
| 读 `session.events` | 该属性已在 0.1.2-alpha.4 被 `eventAt()` / `snapshotEvents()` 取代，每轮提示词装配抛 TypeError | 改用 `session.snapshotEvents()` |
| 清空 `contexts` | 运行时上下文快照被抹掉，模型看不到文件沙箱模式、工作区根和审批策略，而工具说明要求它据此决定是否升级权限 | 保留 `contexts` |

另外 `AssembledSection` 现在只有 `{ name, text }`，没有 `order` 可设，渲染顺序即数组顺序；上游把 persona 段追加到末尾会把身份句排到全部工具说明之后，已改为**原位替换**。

## 运行时健壮性（v0.2.0）

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
