// 探针 v19 — selector 34 invite 服务虚函数：参数 + 原始 UI 调用栈
var REAL_MOD = Process.enumerateModules().filter(function (m) {
    return /wechat\.dylib/i.test(m.name) && m.size > 100 * 1024 * 1024;
})[0];
if (!REAL_MOD) throw new Error("wechat.dylib real image not found");
var BASE = REAL_MOD.base;
function log(s) { send({ type: "log", msg: s }); }
function hex(b) {
    return Array.from(new Uint8Array(b)).map(function (x) {
        return ("0" + x.toString(16)).slice(-2);
    }).join("");
}
function safeHex(p, n) { try { return hex(p.readByteArray(n)); } catch (e) { return null; } }
function off(a) {
    try {
        var d = a.sub(BASE);
        if (d.compare(0) >= 0 && d.compare(0x20000000) < 0) return "wechat+0x" + d.toString(16);
    } catch (e) { }
    return String(a);
}
function bt(ctx, accurate) {
    try {
        return Thread.backtrace(ctx, accurate ? Backtracer.ACCURATE : Backtracer.FUZZY)
            .slice(0, 40).map(off);
    } catch (e) { return ["bt-fail:" + e]; }
}
function cppString(p) {
    try {
        var long = (p.add(0x17).readU8() & 0x80) !== 0;
        var data = long ? p.readPointer() : p.add(1);
        var size = long ? Number(p.add(8).readU64()) : p.readU8() >> 1;
        if (size >= 0 && size < 4096) return data.readUtf8String(size);
    } catch (e) { }
    return null;
}
function args(c) {
    var r = {};
    ["x0", "x1", "x2", "x3", "x4", "x5"].forEach(function (k) { r[k] = String(c[k]); });
    return r;
}
var n = 0;
Interceptor.attach(BASE.add("0x1fcaf64"), {
    onEnter: function () {
        var c = this.context;
        var selector = c.x1.toUInt32();
        if (selector !== 34 || ++n > 4) return;
        send({
            type: "inviteDispatch", n: n, ts: Date.now(), tid: this.threadId,
            selector: selector, args: args(c),
            serviceRaw: safeHex(c.x0, 0x80),
            x2raw: safeHex(c.x2, 0x80), x2string: cppString(c.x2),
            x3raw: safeHex(c.x3, 0x60), x3string: cppString(c.x3),
            btAccurate: bt(c, true), btFuzzy: bt(c, false)
        });
    }
});
var f = 0;
Interceptor.attach(BASE.add("0x1fd7bac"), {
    onEnter: function () {
        if (++f > 4) return;
        var c = this.context;
        send({
            type: "inviteFactory", n: f, ts: Date.now(), tid: this.threadId,
            args: args(c), x2raw: safeHex(c.x2, 0x80), x2string: cppString(c.x2),
            btAccurate: bt(c, true), btFuzzy: bt(c, false)
        });
    }
});
log("=== v19 就绪(base=" + BASE + "): 请点一次语音通话，几秒后挂断 ===");
