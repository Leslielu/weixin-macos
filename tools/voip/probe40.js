// 探针 v40 — 不碰任何音频函数, 只观察「通话状态机」是否在程序化拨号时运行
// 依据 v39 抓到的链路: 拨号后主 runloop 定时任务 → 0x4350030 → 0x434dc00(x1=状态)
//   → 0x546a558/0x5470f7c/0x54704e4/0x5470644/0x5470688 建引擎起采集。
// v37/v39 两次 UI 拨号都崩在 AudioIOThread(PAC, 0xac44xxxx), 因此本版 **完全
// 不挂 0x546xxxx 集群**, 只挂控制器层入口和信令分发器。
// 判定: 程序化 vt[6] 拨号时 0x434dc00 是否被调用、x1 状态序列走到哪。
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
    try {
        var m = Process.findModuleByAddress(addr);
        return m ? m.name + "+0x" + addr.sub(m.base).toString(16) : String(addr);
    } catch (e) { return String(addr); }
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

// ---------- 控制器层(仅这 4 个入口) ----------
var CTRL = { "0x4350030": "timerTask", "0x434dc00": "callState", "0x1fe14a8": "uiCallHandler" };
Object.keys(CTRL).forEach(function (off) {
    Interceptor.attach(BASE.add(off), {
        onEnter: function () {
            var c = this.context;
            send({ type: "ctrl", off: off, name: CTRL[off], ts: Date.now(),
                   x0: String(c.x0), x1: String(c.x1), x2: String(c.x2), x3: String(c.x3),
                   bt: btOnce(c, 5) });
        }
    });
});

// ---------- UI 拨号入口 + 信令分发 ----------
Interceptor.attach(BASE.add("0x1fc07f4"), {
    onEnter: function () {
        var c = this.context, callee = null;
        try { callee = c.x1.readUtf8String(); } catch (e) {}
        send({ type: "uidial", callee: callee, ts: Date.now(), x0: String(c.x0) });
    }
});
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

log("=== v40 就绪(不碰音频函数) ===");
