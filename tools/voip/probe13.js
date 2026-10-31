// 探针 v13 — 终局: msg构造/序列化点 backtrace = 原生拨号链
var REAL_MOD = Process.enumerateModules().filter(function (m) {
    return /wechat\.dylib/i.test(m.name) && m.size > 100 * 1024 * 1024;
})[0];
var BASE = REAL_MOD.base;
function log(s) { send({ type: "log", msg: s }); }
function bt(ctx, tag) {
    try {
        var frames = Thread.backtrace(ctx, Backtracer.FUZZY).map(DebugSymbol.fromAddress);
        send({ type: "bt", tag: tag, frames: frames.slice(0, 32).map(String) });
    } catch (e) { log("bt fail " + e); }
}
var n13 = 0;
// msg 构造 (拨号链上, SubmitCgi 之前被原生同步调用)
Interceptor.attach(BASE.add("0x1fdd4c4"), {
    onEnter: function () {
        if (++n13 > 8) return;
        send({ type: "hit", hook: "msgCtor", tid: this.threadId,
            x0: String(this.context.x0), x1: String(this.context.x1), x2: String(this.context.x2) });
        bt(this.context, "msgCtor");
    }
});
// 序列化 (SubmitCgi 内部经虚表调用)
Interceptor.attach(BASE.add("0x1fdd64c"), {
    onEnter: function () {
        if (n13 > 0 && n13 <= 8) bt(this.context, "serFn");
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
log("=== v13 就绪(base=" + BASE + "): 请点语音通话 ===");
