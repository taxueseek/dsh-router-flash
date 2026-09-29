// dsh-router-flash client bundle（标准双面占位）。
// 本 bundle 没有浏览器 UI：preset 的交付与路由逻辑全在宿主端，这里保持空实现，
// 只为满足 DSH bundle 的双面结构。
//
// 关于 `dsh.client.inject: []`：形态检查（forge_audit 的 client-inject 规则）见到
// 空 inject 会提示「可能有服务没声明」。这里不是遗漏——`apply()` 不读任何服务，
// 空数组是事实声明。真要使用 slots / settingsScope / UI 原语时，必须同步把提供包
// 写进 inject，否则加载顺序错、服务未就绪即崩。
window.__ModuleLoader__.load({
  id: "dsh-router-flash",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    function apply() {}
    exports.apply = apply;
    return module.exports;
  }
});
