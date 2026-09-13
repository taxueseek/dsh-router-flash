/**
 * dsh-router-flash host plugin（bundle 宿主端）
 *
 * 职责：把随包分发的 agent preset（preset/ 目录）同步安装到
 * `$DSH_HOME/.agent-presets/router-flash`。这是对原 install.sh 手动安装的
 * 自动化替代——安装本 bundle 后，重启 DSH 即自动完成 preset 落地，
 * 之后在 ~/.dsh/settings.yaml 里把 agent-presets.default 指向 router-flash 即可。
 *
 * 同步策略（幂等，可安全重启）：
 *   - 逐文件内容比对，目标缺失或内容与包内不一致时才写入；
 *   - 版本升级（重装新 tag）时，包内变更的文件会被覆盖；
 *   - 用户在 ~/.dsh/.agent-presets/router-flash 的手工修改，只要与包内
 *     内容一致就保留；升级导致包内文件变化时会被新版本覆盖；
 *   - 只同步 preset 运行时要读的文件：`agent.cordis.yml`、`preset.yml`，
 *     以及组合里点名引用的相对模块（`./*.mjs`）。自检、映射表、类型声明
 *     这类只有本仓库开发时才用得上的文件不进 preset 目录——preset 目录是
 *     订阅面，不是包的镜像。
 *
 * 为什么是同步写入（而不是 `ctx.fs.writeText` + 返回 promise）：
 * 本包此前用异步写、并靠 `apply()` 返回的 promise 让组合层等待。实测该等待
 * 不足以覆盖这一写入——冷启动时 `apply()` 的 promise 尚未落盘，名册已经扫描
 * 到目录并去读 `agent.cordis.yml`，读到的是半成品：目录存在、组合文件还在
 * `.tmpdir` 里，于是整份 preset 报 "the composition file agent.cordis.yml is
 * missing — the directory still occupies the id"，会话直接挂不出来。
 * `apply()` 是同步函数时，插件入口只有在它返回后才算就绪，写入因此在任何
 * 读取之前就已完成；这是唯一不依赖调度顺序的保证。
 * 代价是绕开了宿主 `ctx.fs` 的沙箱裁决——但本写入本来就在宿主平面（无会话）
 * 并显式声明 `danger-full-access`，策略上等价，只是不再借道那条异步 API。
 *
 * 发布顺序（目录内就地原子替换）：
 *   1. 先落地模块与 `preset.yml`（各自 tmp + rename）；
 *   2. 最后落地 `agent.cordis.yml`——它是发现逻辑判定「这个目录是不是 preset」
 *      的标记文件，最后发布意味着任何观察者要么看到旧版本、要么看到完整的一套，
 *      不会看到缺文件的新目录。
 * 说明：不删除目标目录中包内没有的文件，避免破坏用户可能手工加入的附属文件。
 */
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";

export const name = "dsh-router-flash";

/** 目标 preset id：安装后目录名为 ~/.dsh/.agent-presets/router-flash。 */
const PRESET_ID = "router-flash";

/** 包内 preset 源码目录（本文件位于 lib/，preset 在上级目录）。 */
const PRESET_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "preset");

/** 组合必读的文件名，以及组合点名引用的本地模块扩展名。 */
const COMPOSITION_FILE = "agent.cordis.yml";
const METADATA_FILE = "preset.yml";
const MODULE_EXTENSIONS = new Set([".mjs", ".js"]);

/** $DSH_HOME 未设置时回退到 ~/.dsh。 */
function dshHome() {
  return process.env.DSH_HOME || join(os.homedir(), ".dsh");
}

/**
 * 这个文件是否属于 preset 运行时（安装到用户目录的那份）。
 * 判据是预设名册与组合读取面的并集，与文件名无关，不会因为将来加了
 * `foo.test.mjs` 之外的开发产物就漏掉或误装。
 */
function isRuntimeFile(name) {
  if (name === COMPOSITION_FILE || name === METADATA_FILE) return true;
  if (name.endsWith(".test.mjs")) return false;
  return MODULE_EXTENSIONS.has(extname(name));
}

/** 内容相同就不动；不同才写。返回是否真的写了。 */
function publishFile(targetDir, file, contents) {
  const target = join(targetDir, file);
  try {
    if (readFileSync(target, "utf8") === contents) return false;
  } catch {
    // 目标不存在或不可读：按需要写入处理。
  }

  // 同目录 tmp + rename：rename 是原子的，读者永远不会看到半截文件。
  const staged = join(targetDir, `.${file}.${process.pid}.tmp`);
  writeFileSync(staged, contents, "utf8");
  try {
    renameSync(staged, target);
  } catch {
    // Windows 上目标被占用时 rename 会失败（Node 的 rename 一般可覆盖文件）。
    // 退一步：删掉目标再改名。
    rmSync(target, { force: true });
    try {
      renameSync(staged, target);
    } catch (error) {
      rmSync(staged, { force: true });
      throw error;
    }
  }
  return true;
}

/** 同步把 preset 发布到用户目录，返回本次真正写过的文件名。 */
function syncPreset(targetDir) {
  mkdirSync(targetDir, { recursive: true });

  const files = readdirSync(PRESET_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isRuntimeFile(entry.name))
    .map((entry) => entry.name)
    .sort();

  // 组合文件最后发布：它是发现逻辑的判定标记。
  const ordered = [
    ...files.filter((file) => file !== COMPOSITION_FILE),
    ...files.filter((file) => file === COMPOSITION_FILE),
  ];

  const updated = [];
  for (const file of ordered) {
    const contents = readFileSync(join(PRESET_DIR, file), "utf8");
    if (publishFile(targetDir, file, contents)) updated.push(file);
  }
  return updated;
}

export function apply(ctx) {
  const targetDir = join(dshHome(), ".agent-presets", PRESET_ID);

  // 同步完成后再返回：插件入口就绪 == preset 已在盘上（见文件头说明）。
  // 失败只记日志，不阻断 DSH 启动。
  try {
    const updated = syncPreset(targetDir);
    ctx.logger.info(
      `${name}: preset "${PRESET_ID}" ready at ${targetDir}` +
        (updated.length > 0 ? " (files: " + updated.join(", ") + ")" : " (up to date)"),
    );
  } catch (error) {
    ctx.logger.warn(`${name}: preset sync skipped: ${error && error.message ? error.message : error}`);
  }
}
