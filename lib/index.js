/**
 * dsh-router-flash host 插件（bundle 宿主端）
 *
 * 0.4.0 起本插件**不再写盘**。preset 的交付改由 bundle patch 里的
 * `@deepseek-ai/dsh-agent-preset` 声明行完成（见 presets/router-flash.patch.yml），
 * 宿主读的是组合层，不是目录。
 *
 * 为什么改：DSH 0.2.0-rc.2 移除了目录形态的 preset 发现。旧形态
 * `$DSH_HOME/.agent-presets/<id>/{preset.yml,agent.cordis.yml}` 的全树检索为
 * 0 命中（288 个 @deepseek-ai 包），rc.2 自带文档 `editing-cordis-compositions`
 * 的原话是 "Nothing reads that directory any more."。0.3.1 及以前，本插件每次
 * 启动都把 4 个文件同步进那个目录——在 rc.2 上纯属无人消费的写入。
 *
 * 那为什么还留这一行宿主插件：**升级者会带着旧目录来**。一个从 0.1.5 升上来的
 * 机器，`~/.dsh/.agent-presets/router-flash/` 还在，里面是旧版组合；它现在既不被
 * 读取、也不会自己消失，容易让人误判「preset 装着但没生效」。这里只做只读体检：
 * 在就在日志里说清楚它已失效、可安全删除，并指出真正的生效位置。不删、不改、
 * 不写——升级路径上的破坏性动作不该由插件在启动时替用户做。
 *
 * 失败一律降级为日志：一个「说明性」插件绝不该让 DSH 起不来。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

export const name = "dsh-router-flash";

/** 旧形态目录名（等于 preset id），仅用于体检。 */
const LEGACY_PRESET_ID = "router-flash";

/** 声明行所在的 Loader entry id；写进日志方便用户核对。 */
const DECLARATION_ENTRY_ID = "preset-router-flash";

/** $DSH_HOME 未设置时回退到 ~/.dsh。 */
function dshHome() {
  return process.env.DSH_HOME || join(os.homedir(), ".dsh");
}

/** ctx.logger 缺席时退回 console，日志不是致命路径。 */
function logger(ctx) {
  const fallback = {
    info: (message) => console.log(message),
    warn: (message) => console.warn(message),
  };
  return ctx?.logger ?? fallback;
}

export function apply(ctx) {
  try {
    const legacyDir = join(dshHome(), ".agent-presets", LEGACY_PRESET_ID);
    const log = logger(ctx);

    if (existsSync(legacyDir)) {
      log.warn(
        `${name}: 旧形态 preset 目录仍在 ${legacyDir}，DSH 0.2.0-rc.2 起已不再读取它` +
          `（本插件的 preset 现在由 Loader 行 "${DECLARATION_ENTRY_ID}" 交付）。` +
          "该目录可安全删除，删除前请确认 0.4.0 已安装并重启。",
      );
    } else {
      log.info(
        `${name}: preset "${LEGACY_PRESET_ID}" 由 Loader 行 "${DECLARATION_ENTRY_ID}" 交付，无需落盘同步。`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      logger(ctx).warn(`${name}: legacy preset check skipped: ${message}`);
    } catch {
      // 连日志都失败时保持沉默：宿主平面的问题不该升级成启动失败。
    }
  }
}
