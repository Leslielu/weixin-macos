// 探针 v14 — 0x1fdc80c(action, string, params) 参数全dump = replay素材
var REAL_MOD = Process.enumerateModules().filter(function (m) {
    return /wechat\.dylib/i.test(m.name) && m.size > 100 * 1024 * 1024;
})[0];
var BASE = REAL_MOD.base;
function log(s) { send({ type: "log", msg: s }); }
function hex(b) { return Array.from(new Uint8Array(b)).map(function (x) { return ("0" + x.toString(16)).slice(-2); }).join(""); }
function readCppStr(p) {
    try {
        // libc++: {ptr,size,cap@24B} SSO时size在首字节>>1; 长串旗标 cap 高位
        var b0 = p.readU8();
        if (b0 & 1) {  // 长串(size首字节低位置1? 用老格式: cap bit63) — 两种都试
            var ptr = p.readPointer();
            var size = p.add(8).readU64();
            if (size > 0 && size < 4096 && !ptr.isNull()) return ptr.readUtf8String(Number(size));
        }
        var size2 = b0 >> 1;
        if (size2 > 0 && size2 < 23) return p.add(1).readUtf8String(size2);
        // 长串老格式 {size,ptr,cap}? 再试 ptr@+8
        var ptr2 = p.add(8).readPointer();
        if (!ptr2.isNull()) {
            try { return ptr2.readUtf8String(64); } catch (e) { }
        }
    } catch (e) { }
    return null;
}
var n = 0;
Interceptor.attach(BASE.add("0x1fdc80c"), {
    onEnter: function () {
        if (++n > 10) return;
        var c = this.context;
        var rec = { type: "dialreq", n: n, x0: String(c.x0), x1: String(c.x1), x2: "0x" + (c.x2 & 0xffffffff).toString(16),
            x3: String(c.x3), x4: String(c.x4), tid: this.threadId };
        rec.x3str = readCppStr(c.x3);
        try { rec.x1hex = hex(c.x1.readByteArray(48)); } catch (e) { }
        try { rec.x4hex = hex(c.x4.readByteArray(96)); } catch (e) { }
        try { rec.x0hex = hex(c.x0.readByteArray(48)); } catch (e) { }
        send(rec);
    }
});
[["0x5470688", "audioStart"], ["0x547070c", "audioStop"]].forEach(function (p) {
    try {
        var c2 = 0, self = p[1];
        Interceptor.attach(BASE.add(p[0]), {
            onEnter: function () { if (++c2 <= 20) send({ type: "hit", hook: self, ts: Date.now() }); }
        });
    } catch (e) { }
});
log("=== v14 就绪: 点语音通话 ===");
