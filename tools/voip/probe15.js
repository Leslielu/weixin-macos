// 探针 v15 — 补齐 x3(string)/x1(ctx) 原始字节, replay 素材收口
var REAL_MOD = Process.enumerateModules().filter(function (m) {
    return /wechat\.dylib/i.test(m.name) && m.size > 100 * 1024 * 1024;
})[0];
var BASE = REAL_MOD.base;
function log(s) { send({ type: "log", msg: s }); }
function hex(b) { return Array.from(new Uint8Array(b)).map(function (x) { return ("0" + x.toString(16)).slice(-2); }).join(""); }
var n = 0;
Interceptor.attach(BASE.add("0x1fdc80c"), {
    onEnter: function () {
        if (++n > 10) return;
        var c = this.context;
        var rec = { type: "dialreq", n: n, cmdid: "0x" + (c.x2 & 0xffffffff).toString(16), svc: String(c.x0) };
        try { rec.x3raw = hex(c.x3.readByteArray(32)); } catch (e) { }
        // 长串时 ptr=*x3 size=*(x3+8)
        try {
            var flag = c.x3.add(0x17).readU8();
            if (flag & 0x80) {
                rec.x3long = { ptr: String(c.x3.readPointer()), size: c.x3.add(8).readU64().toString() };
                var p = c.x3.readPointer();
                var sz = Number(c.x3.add(8).readU64());
                if (sz < 4096) rec.x3value = p.readUtf8String(sz);
            } else {
                var ssz = c.x3.readU8() >> 1;
                if (ssz > 0 && ssz < 23) rec.x3value = c.x3.add(1).readUtf8String(ssz);
            }
        } catch (e) { }
        try { rec.x1raw = hex(c.x1.readByteArray(0x80)); } catch (e) { }
        send(rec);
    }
});
[["0x5470688", "audioStart"]].forEach(function (p) {
    try {
        var c2 = 0;
        Interceptor.attach(BASE.add(p[0]), {
            onEnter: function () { if (++c2 <= 5) send({ type: "hit", hook: "audioStart", ts: Date.now() }); }
        });
    } catch (e) { }
});
log("=== v15 就绪: 点语音通话(最后一次抓取) ===");
