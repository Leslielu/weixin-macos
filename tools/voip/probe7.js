// VoIP 探针 v7 — 单点: 0x17f928 (引用 P2PVOIPViewModel typeinfo 页的唯一代码点)
var REAL_MOD = Process.enumerateModules().filter(function (m) {
    return /wechat\.dylib/i.test(m.name) && m.size > 100 * 1024 * 1024;
})[0];
var BASE = REAL_MOD.base;
function log(s) { send({ type: "log", msg: s }); }
function bt(ctx, tag) {
    try {
        var frames = Thread.backtrace(ctx, Backtracer.FUZZY).map(DebugSymbol.fromAddress);
        send({ type: "bt", tag: tag, frames: frames.slice(0, 30).map(String) });
    } catch (e) { log("bt fail " + e); }
}
var n = 0;
Interceptor.attach(BASE.add("0x17f928"), {
    onEnter: function () {
        if (++n > 6) return;
        send({ type: "hit", hook: "rtti_ref_0x17f928", tid: this.threadId,
            x0: String(this.context.x0), x1: String(this.context.x1), x2: String(this.context.x2) });
        bt(this.context, "rtti_ref");
    }
});
[["0x5470688", "audioStart"], ["0x547070c", "audioStop"]].forEach(function (p) {
    try {
        var c = 0, self = p[1];
        Interceptor.attach(BASE.add(p[0]), {
            onEnter: function () { if (++c <= 30) send({ type: "hit", hook: self, ts: Date.now() }); }
        });
    } catch (e) { }
});
log("=== v7就绪: 请点「语音通话」 ===");
