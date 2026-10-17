#!/usr/bin/env node
/**
 * 组合体检：让「宿主契约漂移」从静默变成一条会红的检查。
 *
 * 为什么需要它：本 bundle 的 27 行组合里有 26 行是别人的插件包——占 96%。一个包被
 * 改名（真实发生过：`dsh-workflow-worker-thread` → `dsh-workflow-ptc`）、一个行被
 * 上游删掉、一个官方 preset 改了写法，宿主都不会报错：preset 要么整份挂载失败、要么
 * 静默少了能力。本脚本把这些契约做成四条可离线跑的断言。
 *
 * 四条检查（每条独立，失败各自报出）：
 *   1. 结构自洽：声明行 id / config.id / plugins 列表形状 / 每行 name 非空。
 *   2. 自有引用：`dsh-router-flash/*` 的每个子路径必须在 package.json 的 `exports`
 *      里，且目标文件真实存在（防改名后 patch 没跟上）。
 *   3. 宿主包可解析：每个 `@deepseek-ai/...` 行名（含子路径）必须能在**当前安装的
 *      dsh 运行时**里 resolve。这是那条改名漂移的拦网。
 *   4. 基线差异白名单：与官方 `dsh-web-app/presets/standard.patch.yml` 逐行比对，
 *      差异集必须**恰好**等于白名单——多一条要解释，少一条要删白名单（防白名单腐化）。
 *
 * 不做的检查（诚实声明，别把它当全能门禁）：**config 键是否在该包的 schema 里**。
 * 那份 schema 只在运行时存在，离线拿不到。要查它，用宿主 Inspect：
 *   cordis_inspect_query host/Config listConfigs {name:"@deepseek-ai/dsh-<pkg>"}
 * 本脚本的白名单只能覆盖「已知的、已解释过的」差异，覆盖不了未知的按键漂移。
 *
 * 依赖：只依赖 dsh 运行时（从中借 js-yaml 与官方 preset 文件）。本包自身零依赖，
 * 不需要 npm install。找不到运行时 → 明确报 SKIP / `--strict` 下报 FAIL，绝不假装通过。
 *
 * 用法：node scripts/check-composition.mjs [--strict] [--dsh <dsh 可执行文件或包目录>]
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter as pathDelimiter, dirname, join, resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolvePath(HERE, "..");
const PATCH_PATH = join(PACKAGE_DIR, "presets", "router-flash.patch.yml");
const MANIFEST_PATH = join(PACKAGE_DIR, "package.json");

const STRICT = process.argv.includes("--strict");

/**
 * 允许存在的差异表：每条都要写「为什么」。空理由 = 没解释 = 不该在白名单里。
 * kind：`only-here`（只本 preset 有）/ `only-baseline`（只官方有）/ `config`（同名行取值不同）。
 */
const ALLOWED_DIFFS = [
  { id: "router-bootstrap", kind: "only-here", note: "本 preset 的路由器本身，官方 standard 没有这一行" },
  { id: "command-goal", kind: "only-baseline", note: "家族工具面：不补 /goal（README「工具面」）" },
  { id: "present", kind: "only-baseline", note: "模型可见的加法（约 464 字符描述），未测量不补" },
  { id: "tool-plugin-manager", kind: "only-baseline", note: "插件管理面属宿主/部署层，不进 preset" },
  { id: "tool-plugin-market", kind: "only-baseline", note: "同上；官方行本身 disabled:true，不给 agent" },
  { id: "persona", kind: "config", note: "身份句不同且无 suffix；本行只是 fallback，装配时被路由器整体替换" },
  { id: "tool-ralph", kind: "only-here", note: "官方 0.2.1 已整行移除；本 preset 仍开 maxRounds:64——真实差异，去留待一次测量" },
  { id: "tool-subagent", kind: "config", note: "缺 0.2.0 新增的 modelSelectionSettings:true（模型可见加法，未测量不跟）" },
  { id: "tool-subagent-fork", kind: "config", note: "本 preset 多 backgroundMode: continuable（可续聊），官方无该键" },
  { id: "tool-subagent-codex", kind: "only-here", note: "官方已移除该行；本行 disabled:true，不注册工具，不可观测" },
  { id: "tool-subagent-claude-code", kind: "only-here", note: "同上" },
  { id: "tool-web", kind: "config", note: "家族取值 fetch:false（模型可见减法，未测量不改）" },
];

const results = [];
const pass = (title, detail = "") => results.push({ ok: true, title, detail });
const fail = (title, detail) => results.push({ ok: false, title, detail });
const skip = (title, detail) => results.push({ ok: null, title, detail });

/** 解析 dsh 运行时包目录：--dsh > $DSH_BIN > 常见全局前缀 > 自己扫 PATH。找不到返回 undefined。 */
function findDshPackageDir() {
  const flagAt = process.argv.indexOf("--dsh");
  const explicit = flagAt !== -1 ? process.argv[flagAt + 1] : process.env.DSH_BIN;
  if (typeof explicit === "string" && explicit.trim() !== "") {
    const dir = packageDirOf(explicit);
    if (dir !== undefined) return dir;
  }
  for (const candidate of candidateDshDirs()) {
    if (existsSync(join(candidate, "package.json"))) return candidate;
  }
  for (const bin of scanPathForDsh()) {
    const dir = packageDirOf(bin);
    if (dir !== undefined) return dir;
  }
  return undefined;
}

/** 常见的全局安装前缀。纯文件系统判断，不执行任何进程。 */
function candidateDshDirs() {
  const relative = join("node_modules", "@deepseek-ai", "dsh");
  const dirs = [];
  const prefix = process.env.npm_config_prefix;
  if (typeof prefix === "string" && prefix.trim() !== "") {
    dirs.push(join(prefix, relative), join(prefix, "lib", relative));
  }
  dirs.push(join(homedir(), ".local", "lib", relative));
  dirs.push(join(homedir(), ".npm-global", "lib", relative));
  dirs.push(join("/usr/local/lib", relative));
  dirs.push(join("/opt/homebrew/lib", relative));
  if (typeof process.env.APPDATA === "string") dirs.push(join(process.env.APPDATA, "npm", relative));
  return dirs;
}

/** 扫 PATH 找 dsh 可执行文件——自己遍历目录，不调 which/where（Windows 上没有它们）。 */
function scanPathForDsh() {
  const names = ["dsh", "dsh.exe", "dsh.cmd", "dsh.bat", "dsh.ps1"];
  const found = [];
  for (const entry of (process.env.PATH ?? "").split(pathDelimiter)) {
    if (entry.trim() === "") continue;
    for (const name of names) {
      const candidate = join(entry, name);
      if (existsSync(candidate)) found.push(candidate);
    }
  }
  return found;
}

/** 从任意形态的入口（bin 文件 / 包目录 / package.json）推出包目录。 */
function packageDirOf(entry) {
  try {
    const real = realpathSync(entry);
    const candidates = [real, dirname(real), dirname(dirname(real))];
    return candidates.find((dir) => existsSync(join(dir, "package.json")));
  } catch {
    return undefined;
  }
}

/** 从 dsh 运行时借一个模块（它自带 js-yaml）；借不到返回 undefined。 */
function borrowFromDsh(pkgDir, name) {
  try {
    return createRequire(join(pkgDir, "package.json"))(name);
  } catch {
    return undefined;
  }
}

/** `!!js` 是 DSH 的自定义标签（`disabled: !!js process.platform === 'win32'`），YAML 默认不认。 */
function makeYamlSchema(yaml) {
  const jsTag = new yaml.Type("tag:yaml.org,2002:js", {
    kind: "scalar",
    resolve: () => true,
    construct: (data) => ({ $js: data }),
  });
  return yaml.DEFAULT_SCHEMA.extend([jsTag]);
}

/** 展平组合：把 `group: true` 的容器拆开，只留叶子行。 */
function flattenRows(rows, out = []) {
  for (const row of rows ?? []) {
    if (row === null || typeof row !== "object") continue;
    if (row.group === true) flattenRows(row.config, out);
    else out.push(row);
  }
  return out;
}

/** 行取值指纹：name + 排序后的 config + disabled，用于同名行的差异判定。 */
function fingerprint(row) {
  const config = row.config ?? {};
  const sorted = {};
  for (const key of Object.keys(config).sort()) sorted[key] = config[key];
  return JSON.stringify({ name: row.name, disabled: row.disabled ?? null, config: sorted });
}

/** 差异集：`id:kind` 集合，外加人可读明细。 */
function diffAgainstBaseline(ours, baseline) {
  const mine = new Map(ours.map((row) => [row.id, row]));
  const base = new Map(baseline.map((row) => [row.id, row]));
  const keys = new Set();
  const details = [];
  for (const id of mine.keys()) {
    if (!base.has(id)) {
      keys.add(`${id}:only-here`);
      details.push(`+ ${id}（只本 preset 有）`);
    }
  }
  for (const id of base.keys()) {
    if (!mine.has(id)) {
      keys.add(`${id}:only-baseline`);
      details.push(`- ${id}（只官方 standard 有）`);
    }
  }
  for (const [id, row] of mine) {
    const other = base.get(id);
    if (other === undefined) continue;
    if (fingerprint(row) !== fingerprint(other)) {
      keys.add(`${id}:config`);
      details.push(`~ ${id}（同名，取值不同）`);
    }
  }
  return { keys, details };
}

async function main() {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  } catch (error) {
    fail("读取 package.json", String(error));
    return report();
  }

  const dshDir = findDshPackageDir();
  if (dshDir === undefined) {
    skip("定位 dsh 运行时", "PATH 上没有 dsh，也没有 --dsh/$DSH_BIN；只能做静态结构检查");
  } else {
    pass("定位 dsh 运行时", dshDir);
  }

  const yaml = dshDir === undefined ? undefined : borrowFromDsh(dshDir, "js-yaml");
  if (yaml === undefined) {
    fail("借 js-yaml", "dsh 运行时里没有可用的 js-yaml——无法解析组合，检查无法进行");
    return report();
  }
  const schema = makeYamlSchema(yaml);

  // ---- 1. 结构自洽 --------------------------------------------------------
  let declaration;
  let rows;
  try {
    const doc = yaml.load(readFileSync(PATCH_PATH, "utf8"), { schema });
    declaration = doc?.[0]?.insert?.[0];
    if (declaration === undefined) throw new Error("顶层不是 `- insert: [...]` 补丁层");
    if (declaration.id !== "preset-router-flash") {
      throw new Error(`声明行 id 应为 preset-router-flash，实际 ${JSON.stringify(declaration.id)}`);
    }
    if (declaration.name !== "@deepseek-ai/dsh-agent-preset") {
      throw new Error(`声明行 name 应为 @deepseek-ai/dsh-agent-preset，实际 ${JSON.stringify(declaration.name)}`);
    }
    const config = declaration.config ?? {};
    if (config.id !== "router-flash") {
      throw new Error(`config.id 应为 router-flash（会话身份），实际 ${JSON.stringify(config.id)}`);
    }
    for (const field of ["name", "description"]) {
      if (typeof config[field] !== "string" || config[field].trim() === "") {
        throw new Error(`config.${field} 不能为空（preset 选择器要显示它）`);
      }
    }
    if (!Number.isFinite(config.order)) throw new Error("config.order 必须是数字");
    rows = flattenRows(config.plugins);
    if (rows.length === 0) throw new Error("config.plugins 为空");
    const nameless = rows.filter((row) => typeof row.name !== "string" || row.name.trim() === "");
    if (nameless.length > 0) throw new Error(`${nameless.length} 行没有 name`);
    const duplicated = rows.map((row) => row.id).filter((id, i, all) => all.indexOf(id) !== i);
    if (duplicated.length > 0) throw new Error(`行 id 重复：${[...new Set(duplicated)].join(", ")}`);
    pass("1. 结构自洽", `声明 preset-router-flash / config.id=router-flash / ${rows.length} 个叶子行`);
  } catch (error) {
    fail("1. 结构自洽", error instanceof Error ? error.message : String(error));
    return report();
  }

  // ---- 2. 自有引用必须由 package.json exports 提供 --------------------------
  const ownRows = rows.filter((row) => row.name.startsWith(`${manifest.name}/`));
  const exportsMap = manifest.exports ?? {};
  const ownProblems = [];
  for (const row of ownRows) {
    const subpath = `.${row.name.slice(manifest.name.length)}`;
    const target = exportsMap[subpath];
    if (typeof target !== "string") ownProblems.push(`${row.id}: exports 缺 ${subpath}`);
    else if (!existsSync(join(PACKAGE_DIR, target))) ownProblems.push(`${row.id}: exports${subpath} 指向的 ${target} 不存在`);
  }
  if (ownRows.length === 0) ownProblems.push("组合里没有任何自有插件行（路由器没挂上？）");
  if (ownProblems.length > 0) fail("2. 自有引用", ownProblems.join("；"));
  else pass("2. 自有引用", ownRows.map((row) => row.name).join(", "));

  // ---- 3. 宿主包可解析（改名/删除的拦网）-----------------------------------
  const foreignNames = [...new Set(rows.map((row) => row.name).filter((name) => !name.startsWith(manifest.name + "/") && name !== "cordis:group"))];
  if (dshDir === undefined) {
    skip("3. 宿主包可解析", `需要 dsh 运行时；待查 ${foreignNames.length} 个行名`);
  } else {
    const requireFromDsh = createRequire(join(dshDir, "package.json"));
    const unresolvable = [];
    for (const name of foreignNames) {
      const pkg = name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : name.split("/")[0];
      try {
        requireFromDsh.resolve(`${pkg}/package.json`);
      } catch {
        unresolvable.push(`${name}（包 ${pkg} 在 dsh ${runtimeVersionOf(dshDir)} 里找不到）`);
      }
    }
    if (unresolvable.length > 0) fail("3. 宿主包可解析", unresolvable.join("；"));
    else pass("3. 宿主包可解析", `${foreignNames.length} 个行名全部命中当前 dsh 运行时`);
  }

  // ---- 4. 与官方 standard 的差异必须在白名单里 -----------------------------
  const baselinePath = dshDir === undefined ? undefined : locateBaseline(dshDir);
  if (baselinePath === undefined) {
    const message = "找不到官方 standard.patch.yml，无法做基线比对";
    if (STRICT) fail("4. 基线差异白名单", message + "（--strict 下不算通过）");
    else skip("4. 基线差异白名单", message);
  } else {
    try {
      const baselineDoc = yaml.load(readFileSync(baselinePath, "utf8"), { schema });
      const baselineDecl = baselineDoc?.[0]?.insert?.[0];
      const baselineRows = flattenRows(baselineDecl?.config?.plugins);
      if (baselineRows.length === 0) throw new Error("基线里没有插件行");
      const { keys, details } = diffAgainstBaseline(rows, baselineRows);
      const allowed = new Set(ALLOWED_DIFFS.map((entry) => `${entry.id}:${entry.kind}`));
      const unexplained = [...keys].filter((key) => !allowed.has(key));
      const stale = [...allowed].filter((key) => !keys.has(key));
      const problems = [];
      if (unexplained.length > 0) problems.push(`未解释的差异：${unexplained.join(", ")}`);
      if (stale.length > 0) problems.push(`白名单里已失效的条目（差异不存在了，请删掉）：${stale.join(", ")}`);
      if (problems.length > 0) fail("4. 基线差异白名单", problems.join("；"));
      else pass("4. 基线差异白名单", `与官方 standard 差异 ${keys.size} 处，全部已在白名单中解释（${details.join("，")}）`);
    } catch (error) {
      fail("4. 基线差异白名单", error instanceof Error ? error.message : String(error));
    }
  }

  return report();
}

/** 官方 standard preset 的位置随安装形态而变，按可能的位置找一遍。 */
function locateBaseline(dshDir) {
  const candidates = [];
  try {
    const webApp = dirname(createRequire(join(dshDir, "package.json")).resolve("@deepseek-ai/dsh-web-app/package.json"));
    candidates.push(join(webApp, "presets", "standard.patch.yml"));
  } catch {
    // 忽略：下面还有兜底路径。
  }
  candidates.push(join(dshDir, "node_modules", "@deepseek-ai", "dsh-web-app", "presets", "standard.patch.yml"));
  return candidates.find((path) => existsSync(path));
}

function runtimeVersionOf(dshDir) {
  try {
    return JSON.parse(readFileSync(join(dshDir, "package.json"), "utf8")).version;
  } catch {
    return "unknown";
  }
}

function report() {
  const failed = results.filter((item) => item.ok === false);
  const skipped = results.filter((item) => item.ok === null);
  process.stdout.write("\n组合体检 · presets/router-flash.patch.yml\n");
  process.stdout.write("─".repeat(64) + "\n");
  for (const item of results) {
    const mark = item.ok === true ? "PASS" : item.ok === false ? "FAIL" : "SKIP";
    process.stdout.write(`${mark}  ${item.title}${item.detail === "" ? "" : `\n      ${item.detail}`}\n`);
  }
  process.stdout.write("─".repeat(64) + "\n");
  const summary = `${results.length} 项：${results.length - failed.length - skipped.length} 通过，${failed.length} 失败，${skipped.length} 跳过`;
  process.stdout.write(`${summary}\n`);
  process.exitCode = failed.length > 0 ? 1 : 0;
}

await main();
