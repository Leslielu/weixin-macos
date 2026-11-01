// 探针 v32 — 抓 wechat.dylib+0x1fc07f4（拼 vt[6] 那个 50B pb 并投递的函数）的入参
// 目的: 确认它是否就是「(manager, 被叫信息...)」的原生拨号函数 → 生产用它能自动填本机标识
var REAL_MOD = Process.enumerateModules().filter(function (m) {
    return /wechat\.dylib/i.test(m.name) && m.size > 100 * 1024 * 1024;
})[0];
if (!REAL_MOD) throw new Error("wechat.dylib real image not found");
var BASE = REAL_MOD.base;

function log(s) { send({ type: "log", msg: s, ts: Date.now() }); }
function modOf(a) {
    var m = Process.findModuleByAddress(a);
    return m ? m.name + "+0x" + a.sub(m.base).toString(16) : String(a);
}
function readable(p, n) {
    try {
        var r = Process.findRangeByAddress(p);
        if (!r || r.protection.indexOf("r") < 0) return 0;
        var avail = r.base.add(r.size).sub(p).toInt32();
        return avail > 0 ? Math.min(n, avail) : 0;
    } catch (e) { return 0; }
}
function asc(b) {
    var s = "";
    for (var i = 0; i < b.length; i++) { var c = b[i]; s += (c >= 0x20 && c < 0x7f) ? String.fromCharCode(c) : "."; }
    return s;
}
function hexs(b) { return Array.from(b).map(function (x) { return ("0" + x.toString(16)).slice(-2); }).join(""); }
function probeReg(name, p) {
    var out = [];
    if (!p || p.isNull()) return name + " = null";
    var k = readable(p, 0x40);
    if (k) {
        try {
            var b = new Uint8Array(p.readByteArray(Math.min(k, 0x40)));
            out.push(name + "=" + p + " hex:" + hexs(b.slice(0, 0x20)) + " asc:" + asc(b.slice(0, 0x20)));
        } catch (e) { out.push(name + "=" + p + " <hex err>"); }
        // 当作 std::string {ptr,size} 解
        try {
            var sp2 = p.readPointer(), sz = p.add(8).readUInt32();
            if (sz > 0 && sz < 200 && readable(sp2, sz)) {
                var sb = new Uint8Array(sp2.readByteArray(sz));
                out.push("   " + name + " as std::string: len=" + sz + " '" + asc(sb) + "'");
            }
        } catch (e) {}
        // 当作 C 串
        try {
            var cs = p.readCString(64);
            if (cs && /^[\x20-\x7e]{3,60}$/.test(cs)) out.push("   " + name + " as C str: '" + cs + "'");
        } catch (e) {}
    }
    return out.join("\n");
}

var n = 0;
Interceptor.attach(BASE.add("0x1fc07f4"), {
    onEnter: function () {
        if (++n > 2) return;
        var c = this.context;
        var regs = ["x0", "x1", "x2", "x3", "x4", "x5", "x6", "x7"].map(function (r) { return r + "=" + c[r]; }).join(" ");
        var bt = "";
        try { bt = Thread.backtrace(this.context, Backtracer.ACCURATE).slice(0, 10).map(modOf).join(" <- "); } catch (e) {}
        send({
            type: "dialfn", ts: Date.now(), regs: regs, bt: bt,
            d: ["x0", "x1", "x2", "x3", "x4", "x5"].map(function (r) { return probeReg(r, c[r]); }).join("\n")
        });
    }
});
log("=== v32 就绪 请在 UI 上点一次语音通话(响铃后可挂断) ===");
