// 探针 v24 — 抓 SEL 39/5/20/21/22/25/26/29/34 的完整 payload(用于重建原生拨号序列)
var REAL_MOD = Process.enumerateModules().filter(function (m) {
    return /wechat\.dylib/i.test(m.name) && m.size > 100 * 1024 * 1024;
})[0];
if (!REAL_MOD) throw new Error("wechat.dylib real image not found");
var BASE = REAL_MOD.base;
var WANT = { 39: 1, 5: 1, 20: 1, 21: 1, 22: 1, 25: 1, 26: 1, 29: 1, 34: 1 };

function hex(a, n) {
    try {
        return Array.from(new Uint8Array(a.readByteArray(n)))
            .map(function (x) { return ("0" + x.toString(16)).slice(-2); }).join("");
    } catch (e) { return "<unreadable>"; }
}
function modOf(addr) {
    var m = Process.findModuleByAddress(addr);
    return m ? m.name + "+0x" + addr.sub(m.base).toString(16) : String(addr);
}
function log(s) { send({ type: "log", msg: s, ts: Date.now() }); }

var seen = {};   // selector -> 首包完整 hex（每个 selector 只存第一包）
Interceptor.attach(BASE.add("0x1fcaf64"), {
    onEnter: function () {
        var c = this.context;
        var sel = c.x1.toUInt32();
        if (!WANT[sel]) return;
        var len = c.x4.toUInt32();
        if (!len || len > 4096) return;
        if (seen[sel]) { send({ type: "again", sel: sel, len: len, ts: Date.now() }); return; }
        seen[sel] = 1;
        var bt = "";
        try { bt = Thread.backtrace(this.context, Backtracer.ACCURATE).slice(0, 5).map(modOf).join(" <- "); } catch (e) {}
        send({ type: "payload", sel: sel, len: len, hex: hex(c.x3, len), ts: Date.now(), bt: bt });
    }
});
[["0x5470688", "audioStart"], ["0x547070c", "audioStop"]].forEach(function (p) {
    Interceptor.attach(BASE.add(p[0]), {
        onEnter: function () { send({ type: "audio", hook: p[1], ts: Date.now() }); }
    });
});
log("=== v24 就绪: 请手动拨一次(响铃后可挂断)，抓各 selector 完整 payload ===");
