// 探针 v18 — 在原始调用线程抓 ctx 发送入口 backtrace，定位 UI 侧虚调用上游
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
            .slice(0, 32).map(off);
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
function inlineString(p) {
    try {
        var s = p.readUtf8String(100);
        if (s && /^[\x20-\x7e]+$/.test(s)) return s;
    } catch (e) { }
    return null;
}
function ptrFields(p, n) {
    var out = [];
    for (var i = 0; i < n; i += 8) {
        try {
            var q = p.add(i).readPointer();
            if (!q.isNull()) out.push({ off: "0x" + i.toString(16), value: off(q) });
        } catch (e) { }
    }
    return out;
}

var sendCount = 0;
Interceptor.attach(BASE.add("0x1fdac00"), {
    onEnter: function () {
        if (++sendCount > 8) return;
        var c = this.context;
        var ctx = c.x0;
        var rec = {
            type: "ctxSend", n: sendCount, ts: Date.now(), tid: this.threadId,
            ctx: String(ctx), cmdid: "0x" + ctx.add(0x1c).readU32().toString(16),
            ctxRaw: safeHex(ctx, 0x60), ctxPtrs: ptrFields(ctx, 0x60),
            btAccurate: bt(c, true), btFuzzy: bt(c, false)
        };
        try { rec.uri = cppString(ctx.add(0x20).readPointer()); } catch (e) { }
        try {
            var payload = ctx.add(0x10).readPointer();
            rec.payload = String(payload);
            rec.payloadRaw = safeHex(payload, 0x100);
            rec.payloadPtrs = ptrFields(payload, 0x100);
            rec.payloadStrings = {
                first: inlineString(payload.add(8)),
                second: inlineString(payload.add(0x28))
            };
        } catch (e) { }
        send(rec);
    }
});

var enqueueCount = 0;
Interceptor.attach(BASE.add("0x1fdaff0"), {
    onEnter: function () {
        if (++enqueueCount > 8) return;
        var c = this.context;
        send({
            type: "enqueue", n: enqueueCount, ts: Date.now(), tid: this.threadId,
            cmdid: "0x" + (c.x2 & 0xffffffff).toString(16),
            x0: String(c.x0), x1: String(c.x1), x3: String(c.x3), x4: String(c.x4),
            x1raw: safeHex(c.x1, 0x80), x1ptrs: ptrFields(c.x1, 0x80),
            uri: cppString(c.x3), extra: cppString(c.x4),
            btAccurate: bt(c, true), btFuzzy: bt(c, false)
        });
    }
});
log("=== v18 就绪(base=" + BASE + "): 请点一次语音通话，几秒后挂断 ===");
