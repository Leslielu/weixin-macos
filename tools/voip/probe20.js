// 探针 v20 — 抓完整 invite payload，并在 10s 后原样重放（验证程序化拨打入口）
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
function ascii(b) {
    var out = "";
    for (var i = 0; i < b.length; i++) {
        var v = b[i];
        out += (v >= 0x20 && v < 0x7f) ? String.fromCharCode(v) : ".";
    }
    return out;
}
var cap = null;

Interceptor.attach(BASE.add("0x1fcaf64"), {
    onEnter: function () {
        var c = this.context;
        var selector = c.x1.toUInt32();
        if (selector !== 34 || cap) return;
        var len = c.x4.toUInt32();
        if (len === 0 || len > 2048) return;
        var bytes = new Uint8Array(c.x3.readByteArray(len));
        cap = { svc: c.x0, buf: bytes, ts: Date.now() };
        send({
            type: "captured", ts: cap.ts, svc: String(c.x0), len: len,
            hex: hex(bytes), ascii: ascii(bytes)
        });
        setTimeout(replay, 10000);
    }
});

function replay() {
    if (!cap) { log("replay: 无 payload"); return; }
    log("replay: 开始，svc=" + cap.svc + " len=" + cap.buf.length);
    try {
        var fn = new NativeFunction(BASE.add("0x1fcaf64"), "void",
            ["pointer", "int", "pointer", "pointer", "int", "pointer"]);
        var mem = Memory.alloc(cap.buf.length);
        mem.writeByteArray(Array.from(cap.buf));
        var t0 = Date.now();
        fn(cap.svc, 34, ptr(0), mem, cap.buf.length, ptr(0));
        send({ type: "replayDone", ok: true, ms: Date.now() - t0 });
    } catch (e) {
        send({ type: "replayDone", ok: false, error: String(e) });
    }
}

[["0x5470688", "audioStart"], ["0x547070c", "audioStop"]].forEach(function (p) {
    var n = 0;
    Interceptor.attach(BASE.add(p[0]), {
        onEnter: function () {
            if (++n <= 40) send({ type: "audio", hook: p[1], ts: Date.now() });
        }
    });
});
log("=== v20 就绪(base=" + BASE + "): 请点一次语音通话，响铃后挂断；10 秒后我会原样重放 ===");
