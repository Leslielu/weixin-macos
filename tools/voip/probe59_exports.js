// 探针 v59 — 枚举 ConfSDKdyn 中与 External/Play/Record/Audio/Pcm 相关的导出符号
var mods = Process.enumerateModules().filter(function (m) {
    return m.name.indexOf("ConfSDKdyn") !== -1 && m.size > 100 * 1024;
});
var out = [];
mods.forEach(function (m) {
    var ex = m.enumerateExports();
    out.push({ type: "mod", name: m.name, path: m.path, base: m.base.toString(), size: m.size, nExports: ex.length, ts: Date.now() });
    var hits = ex.filter(function (e) {
        var n = (e.name || "").toLowerCase();
        return /external|play|record|audio|pcm|mic|voice|codec|encode|decode/.test(n);
    });
    send({ type: "hits", module: m.name, n: hits.length,
           list: hits.slice(0, 200).map(function (e) { return e.name + "@" + e.address.sub(m.base); }).join("\n"), ts: Date.now() });
});
// 也看看 MultiMediaDyn
Process.enumerateModules().filter(function (m) { return m.name.indexOf("MultiMedia") !== -1; }).forEach(function (m) {
    var ex = m.enumerateExports();
    var hits = ex.filter(function (e) { return /external|put|get|push|pull|record|play/i.test(e.name || ""); });
    send({ type: "mmhits", module: m.name, base: m.base.toString(), size: m.size, n: ex.length, nHit: hits.length,
           list: hits.slice(0, 200).map(function (e) { return e.name + "@" + e.address.sub(m.base); }).join("\n"), ts: Date.now() });
});
send({ type: "done", ts: Date.now() });
