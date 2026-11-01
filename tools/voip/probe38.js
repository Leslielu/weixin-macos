// 探针 v38 — 最小风险: 只挂 §5 已验证的 4 个音频引擎函数入口 + UI 拨号入口
// 目的: 判定「程序化 vt[6] 拨号会不会启动本机音频引擎」。
//   v37 事故: 额外挂了 0x5470600 / 0x5470f74 两个靠位置猜的「邻居」,
//   很可能是函数中段 → 改坏了音频回调的 PAC 指针 → AudioIOThread SIGBUS。
//   本版只保留文档验证过的入口, 且不做 ACCURATE backtrace(改 FUZZY, 只渲染一次)。
// 触发: /tmp/voip_replay.req (拨出) + /tmp/voip_target.txt (被叫) / /tmp/voip_hangup.req
var REAL_MOD = Process.enumerateModules().filter(function (m) {
    return /wechat\.dylib/i.test(m.name) && m.size > 100 * 1024 * 1024;
})[0];
if (!REAL_MOD) throw new Error("wechat.dylib real image not found");
var BASE = REAL_MOD.base;

function log(s, extra) {
    var m = { type: "log", msg: s, ts: Date.now() };
    if (extra) for (var k in extra) m[k] = extra[k];
    send(m);
}
function modOf(addr) {
    var m = Process.findModuleByAddress(addr);
    return m ? m.name + "+0x" + addr.sub(m.base).toString(16) : String(addr);
}
function btOnce(ctx, n) {
    try { return Thread.backtrace(ctx, Backtracer.FUZZY).slice(0, n).map(modOf).join(" <- "); }
    catch (e) { return "<bt err>"; }
}
function encVarint(n) {
    var out = [];
    while (true) { var b = n & 0x7f; n = Math.floor(n / 128); if (n) out.push(b | 0x80); else { out.push(b); return out; } }
}
function buildPb(wxid) {
    var w = [];
    for (var i = 0; i < wxid.length; i++) w.push(wxid.charCodeAt(i) & 0xff);
    var tail = [0x10, 0x02, 0x18, 0x00, 0x20, 0x04, 0x38, 0x00,
                0x42, 0x06, 0x77, 0x65, 0x63, 0x68, 0x61, 0x74,
                0x4a, 0x07, 0x76, 0x6f, 0x69, 0x70, 0x2d, 0x32, 0x70];
    return [0x0a].concat(encVarint(w.length), w, tail);
}
function readText(p) {
    try { var f = new File(p, "r"); var t = f.readText(); f.close(); return t; } catch (e) { return null; }
}

// ---------- §5 音频引擎入口(仅这 4 个, 都是函数起始) ----------
var AUDIO = { "0x5470644": "engineStart容器", "0x5470688": "engineStart",
              "0x547070c": "engineStop", "0x54704e4": "engineCtor" };
var audioSeen = {};
Object.keys(AUDIO).forEach(function (off) {
    Interceptor.attach(BASE.add(off), {
        onEnter: function () {
            var first = !audioSeen[off];
            audioSeen[off] = (audioSeen[off] || 0) + 1;
            var m = { type: "audio", off: off, name: AUDIO[off], n: audioSeen[off],
                      a0: String(this.context.x0), ts: Date.now() };
            if (first) m.bt = btOnce(this.context, 8);
            send(m);
        }
    });
});

// ---------- UI 拨号入口 ----------
var uiDials = 0;
Interceptor.attach(BASE.add("0x1fc07f4"), {
    onEnter: function () {
        var c = this.context, callee = null;
        try { callee = c.x1.readUtf8String(); } catch (e) {}
        send({ type: "uidial", callee: callee, n: ++uiDials, ts: Date.now(), bt: btOnce(c, 6) });
    }
});

// ---------- ConfSDK 信令分发(判接通用) ----------
Interceptor.attach(BASE.add("0x1fcaf64"), {
    onEnter: function () {
        var c = this.context;
        send({ type: "sel", sel: c.x1.toUInt32(), len: c.x4.toUInt32(), ts: Date.now() });
    }
});

// ---------- 程序化拨号/挂断 ----------
var CONF = Process.enumerateModules().filter(function (m) {
    return m.name.indexOf("ConfSDKdyn") !== -1 && m.size > 100 * 1024;
})[0];
var svc = null, startFn = null, endFn = null;
if (CONF) {
    try {
        var getter = CONF.enumerateExports().filter(function (e) { return e.name === "GetWXConfService"; })[0];
        svc = new NativeFunction(getter.address, "pointer", ["int"])(0x1352707);
        var vt = svc.readPointer();
        startFn = vt.add(6 * 8).readPointer();
        endFn = vt.add(12 * 8).readPointer();
        log("svc=" + svc + " vt[6]=" + modOf(startFn) + " vt[12]=" + modOf(endFn));
    } catch (e) { log("取服务失败: " + e); }
} else { log("ConfSDKdyn 未加载"); }

var lastDial = null, lastHang = null;
setInterval(function () {
    var tag = readText("/tmp/voip_replay.req");
    if (tag && (tag = tag.trim()) && tag !== lastDial) {
        lastDial = tag;
        var wxid = (readText("/tmp/voip_target.txt") || "").trim();
        if (!wxid || !svc || svc.isNull() || !startFn) { send({ type: "skip", reason: "no target/svc" }); return; }
        var pb = buildPb(wxid), mem = Memory.alloc(pb.length);
        mem.writeByteArray(pb);
        var r = null, err = null;
        try { r = new NativeFunction(startFn, "int", ["pointer", "pointer", "int"])(svc, mem, pb.length); }
        catch (e) { err = String(e); }
        send({ type: "dial", wxid: wxid, ret: r, err: err, ts: Date.now() });
    }
    var h = readText("/tmp/voip_hangup.req");
    if (h && (h = h.trim()) && h !== lastHang) {
        lastHang = h;
        if (!svc || svc.isNull() || !endFn) { send({ type: "skip", reason: "no svc" }); return; }
        var r2 = null, e2 = null;
        try { r2 = new NativeFunction(endFn, "int", ["pointer", "int", "int"])(svc, 1, 0); }
        catch (e) { e2 = String(e); }
        send({ type: "hangup", ret: r2, err: e2, ts: Date.now() });
    }
}, 800);

log("=== v38 就绪(只挂已验证入口) ===");
