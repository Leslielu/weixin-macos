// 探针 v36 — vt[6] 拨号, field7(本机标识)填 0, 验证该字段是否必需
//   拨出: ConfSDKdyn+0x79ab4(svc, pb, len)   pb = 0a13<被叫wxid> 1002 1800 2004 38<uin> 4206"wechat" 4a07"voip-2p"
//   挂断: ConfSDKdyn+0x79dfc(svc, code, 0)   观测到 UI 挂断用的是 (svc, 1, 0)
// 触发: /tmp/voip_replay.req 内容变化=拨出; /tmp/voip_hangup.req 内容变化=挂断
var REAL_MOD = Process.enumerateModules().filter(function (m) {
    return /wechat\.dylib/i.test(m.name) && m.size > 100 * 1024 * 1024;
})[0];
if (!REAL_MOD) throw new Error("wechat.dylib real image not found");
var BASE = REAL_MOD.base;
var CONF = Process.enumerateModules().filter(function (m) {
    return /ConfSDKdyn/i.test(m.name) && m.size > 100 * 1024;
})[0];
if (!CONF) throw new Error("ConfSDKdyn real image not found");

var TPL_HEX = "0a13777869645f3364706f64757131377476633132100218002004380042067765636861744a07766f69702d3270";
              "38f3c1a4f30242067765636861744a07766f69702d3270";
var TPL = hex2bytes(TPL_HEX);
var REST = TPL.slice(2 + TPL[1]);

function log(s) { send({ type: "log", msg: s, ts: Date.now() }); }
function hex2bytes(h) {
    var o = [];
    for (var i = 0; i < h.length; i += 2) o.push(parseInt(h.substr(i, 2), 16));
    return o;
}
function hexs(b) { return Array.from(b).map(function (x) { return ("0" + x.toString(16)).slice(-2); }).join(""); }
function modOf(addr) {
    var m = Process.findModuleByAddress(addr);
    return m ? m.name + "+0x" + addr.sub(m.base).toString(16) : String(addr);
}
function encVarint(n) {
    var out = [];
    while (true) { var b = n & 0x7f; n = Math.floor(n / 128); if (n) out.push(b | 0x80); else { out.push(b); return out; } }
}
function buildPb(wxid) {
    var w = [];
    for (var i = 0; i < wxid.length; i++) w.push(wxid.charCodeAt(i) & 0xff);
    return [0x0a].concat(encVarint(w.length), w, REST);
}
function readText(p) {
    try { var f = new File(p, "r"); var t = f.readText(); f.close(); return t; } catch (e) { return null; }
}

var svc = null, startFn = null, endFn = null;
try {
    var getter = CONF.enumerateExports().filter(function (e) { return e.name === "GetWXConfService"; })[0];
    svc = new NativeFunction(getter.address, "pointer", ["int"])(0x1352707);
    var vt = svc.readPointer();
    startFn = vt.add(6 * 8).readPointer();
    endFn = vt.add(12 * 8).readPointer();
    log("svc=" + svc + " vtable=" + modOf(vt) +
        " vt[6]=" + modOf(startFn) + (startFn.equals(CONF.base.add(0x79ab4)) ? " OK" : " 不符!") +
        " vt[12]=" + modOf(endFn) + (endFn.equals(CONF.base.add(0x79dfc)) ? " OK" : " 不符!"));
} catch (e) { log("取服务失败: " + e); }

Interceptor.attach(BASE.add("0x1fcaf64"), {
    onEnter: function () {
        var c = this.context;
        var bt = "";
        try { bt = Thread.backtrace(this.context, Backtracer.ACCURATE).slice(0, 3).map(modOf).join(" <- "); } catch (e) {}
        send({ type: "sel", sel: c.x1.toUInt32(), len: c.x4.toUInt32(), ts: Date.now(), bt: bt });
    }
});

var lastDial = null, lastHang = null;
setInterval(function () {
    var tag = readText("/tmp/voip_replay.req");
    if (tag && (tag = tag.trim()) && tag !== lastDial) {
        lastDial = tag;
        var wxid = (readText("/tmp/voip_target.txt") || "").trim();
        if (!wxid) { send({ type: "skip", reason: "no target" }); return; }
        if (!svc || svc.isNull() || !startFn) { send({ type: "skip", reason: "no svc" }); return; }
        var pb = buildPb(wxid);
        var mem = Memory.alloc(pb.length);
        mem.writeByteArray(pb);
        var r = null, err = null;
        try { r = new NativeFunction(startFn, "int", ["pointer", "pointer", "int"])(svc, mem, pb.length); }
        catch (e) { err = String(e); }
        send({ type: "dial", wxid: wxid, pb: hexs(pb), ret: r, err: err, ts: Date.now() });
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
log("=== v31 就绪 拨出: 写 /tmp/voip_replay.req   挂断: 写 /tmp/voip_hangup.req ===");
