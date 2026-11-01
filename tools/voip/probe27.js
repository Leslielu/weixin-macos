// 探针 v27 — 挂 ConfSDKdyn 导出函数 _GetWXConfService / _GetWXAIConfService / _GetWaveLink
// 目的: 点「语音通话」时 wechat.dylib 会先取服务对象 → 抓 wechat.dylib 侧调用栈 + 返回的 service/vtable
var REAL_MOD = Process.enumerateModules().filter(function (m) {
    return /wechat\.dylib/i.test(m.name) && m.size > 100 * 1024 * 1024;
})[0];
if (!REAL_MOD) throw new Error("wechat.dylib real image not found");
var BASE = REAL_MOD.base;
var CONF = Process.enumerateModules().filter(function (m) {
    return /ConfSDKdyn/i.test(m.name) && m.size > 100 * 1024;
})[0];
if (!CONF) throw new Error("ConfSDKdyn real image not found");

function log(s) { send({ type: "log", msg: s, ts: Date.now() }); }
function modOf(addr) {
    var m = Process.findModuleByAddress(addr);
    return m ? m.name + "+0x" + addr.sub(m.base).toString(16) : String(addr);
}

var EXPORTS = CONF.enumerateExports();
log("ConfSDKdyn 导出数=" + EXPORTS.length + " 样例=" + EXPORTS.slice(0, 5).map(function (e) { return e.name + "@" + e.address; }).join(","));

["_GetWXConfService", "_GetWXAIConfService", "_GetWaveLink"].forEach(function (name) {
    var addr = null;
    var hit = EXPORTS.filter(function (e) { return e.name === name || e.name === name.replace(/^_/, ""); })[0];
    if (hit) addr = hit.address;
    if (!addr) { log(name + " 未在导出表"); return; }
    log("hook " + name + " @ " + addr + " (" + modOf(addr) + ")");
    Interceptor.attach(addr, {
        onEnter: function () {
            var c = this.context;
            this.args_ = ["x0", "x1", "x2"].map(function (r) { return String(c[r]); }).join(" ");
            try { this.bt_ = Thread.backtrace(this.context, Backtracer.ACCURATE).slice(0, 18).map(modOf).join(" <- "); }
            catch (e) { this.bt_ = "<no bt>"; }
        },
        onLeave: function (retval) {
            var vt = "";
            try { vt = String(retval.readPointer()) + " (wechat+" + retval.readPointer().sub(BASE).toString(16) + ")"; } catch (e) { vt = "<n/a>"; }
            send({ type: "call", fn: name, ts: Date.now(), args: this.args_, ret: String(retval), vtable: vt, bt: this.bt_ });
        }
    });
});
log("=== v27 就绪 请点一次语音通话(响铃后挂断) ===");
