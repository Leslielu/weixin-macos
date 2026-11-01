// 探针 v41 — 抓 UI 拨号函数 0x1fc07f4 的完整入参, 然后**用同一对象回放拨号**
// 背景: v40 证实程序化 vt[6] 拨号完全不触发通话状态机(0x434dc00 零调用),
//   说明 ConfSDK 只是传输层; 微信自己的 VoIP 客户端层(0x1fc07f4 所在)才负责
//   建窗口/跑状态机/起音频。本探针把 UI 调 0x1fc07f4 时的 x0(客户端对象)、
//   x2(participants 向量)、x5(scene) 抄下来, 再用这些值回调 0x1fc07f4。
// 安全: 不挂任何 0x546xxxx 音频函数(v37/v39 的崩溃源), 只挂 0x1fc07f4 与信令分发器。
// 触发: /tmp/voip_replay.req  → vt[6] 直调(对照组)
//       /tmp/voip_uidial.req  → 0x1fc07f4 回放(实验组, 需先有一次 UI 拨号抓到对象)
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
function hexs(b) { return Array.from(b).map(function (x) { return ("0" + x.toString(16)).slice(-2); }).join(""); }
function readCStr(p) { try { return p.readUtf8String(); } catch (e) { return "<" + e + ">"; } }

// libc++ std::string -> 文本(短串内联 / 长串指针)
function strAt(st) {
    try {
        var flag = st.add(0x17).readU8();
        if (flag & 0x80) {                       // 长串: {cap,size,ptr}
            var sz = st.add(8).readU64().toNumber();
            if (sz > 4096) return null;
            return st.add(0x10).readPointer().readUtf8String(sz);
        }
        var n = flag >> 1;                        // 短串: 长度在 0x17 高7位
        if (n > 22) return null;
        return st.readUtf8String(n);
    } catch (e) { return null; }
}
function vecDump(vp) {
    try {
        var beg = vp.readPointer(), end = vp.add(8).readPointer();
        var n = end.sub(beg).toInt32() / 24;
        var out = [];
        for (var i = 0; i < Math.min(n, 8); i++) out.push(strAt(beg.add(i * 24)));
        return "vec[" + n + "]=" + JSON.stringify(out);
    } catch (e) { return "vec?" + e; }
}
function readText(p) {
    try { var f = new File(p, "r"); var t = f.readText(); f.close(); return t; } catch (e) { return null; }
}

log("BASE=" + BASE);

// ---------- UI 拨号入口: 抓参 ----------
var cap = null;
Interceptor.attach(BASE.add("0x1fc07f4"), {
    onEnter: function () {
        var c = this.context;
        var vt = null;
        try { vt = c.x0.readPointer(); } catch (e) {}
        cap = { obj: c.x0, vec: c.x2, x3: c.x3, x4: c.x4, x5: c.x5 };
        send({ type: "uidial", callee: readCStr(c.x1), ts: Date.now(),
               x0: String(c.x0), vt: vt ? String(vt) : null,
               vtOff: vt ? "0x" + vt.sub(BASE).toString(16) : null,
               x2: String(c.x2), vec: vecDump(c.x2),
               x3: String(c.x3), x4: String(c.x4), x5: String(c.x5) });
    }
});

// ---------- ConfSDK 信令分发 ----------
Interceptor.attach(BASE.add("0x1fcaf64"), {
    onEnter: function () {
        var c = this.context;
        send({ type: "sel", sel: c.x1.toUInt32(), len: c.x4.toUInt32(), ts: Date.now() });
    }
});

// ---------- 对照组: vt[6] 直调 ----------
var CONF = Process.enumerateModules().filter(function (m) {
    return m.name.indexOf("ConfSDKdyn") !== -1 && m.size > 100 * 1024;
})[0];
var svc = null, vt6 = null, vt12 = null, dialFn = null;
if (CONF) {
    try {
        var getter = CONF.enumerateExports().filter(function (e) { return e.name === "GetWXConfService"; })[0];
        svc = new NativeFunction(getter.address, "pointer", ["int"])(0x1352707);
        var vt = svc.readPointer();
        vt6 = vt.add(6 * 8).readPointer();
        vt12 = vt.add(12 * 8).readPointer();
        log("svc=" + svc + " vt[6]=" + modOf(vt6) + " vt[12]=" + modOf(vt12));
    } catch (e) { log("取服务失败: " + e); }
    dialFn = new NativeFunction(BASE.add("0x1fc07f4"), "pointer",
                                ["pointer", "pointer", "pointer", "int", "int", "int"]);
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
// 构造 libc++ std::vector<std::string>, 装一个短串
function buildVec(wxid) {
    var sb = Memory.alloc(24);
    var bytes = [];
    for (var i = 0; i < wxid.length; i++) bytes.push(wxid.charCodeAt(i) & 0xff);
    while (bytes.length < 23) bytes.push(0);
    bytes[23] = (wxid.length << 1) & 0x7f;      // 短串长度标记
    sb.writeByteArray(bytes);
    var vec = Memory.alloc(24);
    vec.writePointer(sb);
    vec.add(8).writePointer(sb.add(24));
    vec.add(16).writePointer(sb.add(24));
    return vec;
}

var lastDial = null, lastUID = null;
setInterval(function () {
    var target = (readText("/tmp/voip_target.txt") || "").trim();

    var tag = readText("/tmp/voip_replay.req");
    if (tag && (tag = tag.trim()) && tag !== lastDial) {
        lastDial = tag;
        if (!target || !svc || svc.isNull() || !vt6) { send({ type: "skip", reason: "no target/svc" }); return; }
        var pb = buildPb(target), mem = Memory.alloc(pb.length);
        mem.writeByteArray(pb);
        var r = null, err = null;
        try { r = new NativeFunction(vt6, "int", ["pointer", "pointer", "int"])(svc, mem, pb.length); }
        catch (e) { err = String(e); }
        send({ type: "dial", mode: "vt6", wxid: target, ret: r, err: err, ts: Date.now() });
    }

    var tag2 = readText("/tmp/voip_uidial.req");
    if (tag2 && (tag2 = tag2.trim()) && tag2 !== lastUID) {
        lastUID = tag2;
        if (!cap) { send({ type: "skip", reason: "还没抓到 UI 拨号对象, 请先在微信里手动拨一次" }); return; }
        if (!target) { send({ type: "skip", reason: "no target" }); return; }
        var cstr = Memory.allocUtf8String(target);
        var vec = buildVec(target);
        var r2 = null, e2 = null;
        try {
            r2 = dialFn(cap.obj, cstr, vec, cap.x3.toInt32(), cap.x4.toInt32(), cap.x5.toInt32());
        } catch (e) { e2 = String(e); }
        send({ type: "dial", mode: "uidial-replay", wxid: target, ret: String(r2), err: e2,
               usedObj: String(cap.obj), usedX3: String(cap.x3), usedX4: String(cap.x4),
               usedX5: String(cap.x5), ts: Date.now() });
    }
}, 800);

log("=== v41 就绪: 先手动 UI 拨一次(抓对象), 之后可写 /tmp/voip_uidial.req 回放 ===");
