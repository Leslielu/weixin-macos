// 探针 v30 — 走 ConfSDK 原生发起入口 vt[6] = ConfSDKdyn+0x79ab4(svc, pb, len)
// pb 模板抓自 2026-11-01 09:12 手动拨号:
//   0a13 <被叫wxid> 1002 1800 2004 38<uin> 4206 "wechat" 4a07 "voip-2p"
// 触发: /tmp/voip_replay.req 内容变化; 被叫: /tmp/voip_target.txt
var REAL_MOD = Process.enumerateModules().filter(function (m) {
    return /wechat\.dylib/i.test(m.name) && m.size > 100 * 1024 * 1024;
})[0];
if (!REAL_MOD) throw new Error("wechat.dylib real image not found");
var BASE = REAL_MOD.base;
var CONF = Process.enumerateModules().filter(function (m) {
    return /ConfSDKdyn/i.test(m.name) && m.size > 100 * 1024;
})[0];
if (!CONF) throw new Error("ConfSDKdyn real image not found");

// 09:12 手动拨号抓到的 50B 模板（被叫 wxid_3dpoduq17tvc12）
var TPL_HEX = "0a13777869645f3364706f64757131377476633132100218002004" +
              "38f3c1a4f30242067765636861744a07766f69702d3270";
var TPL = hex2bytes(TPL_HEX);
var WXID_LEN = TPL[1];
var REST = TPL.slice(2 + WXID_LEN);

function log(s) { send({ type: "log", msg: s, ts: Date.now() }); }
function hex2bytes(h) {
    var o = [];
    for (var i = 0; i < h.length; i += 2) o.push(parseInt(h.substr(i, 2), 16));
    return o;
}
function hexs(b) {
    return Array.from(b).map(function (x) { return ("0" + x.toString(16)).slice(-2); }).join("");
}
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

// ——— 拿 ConfSDK 服务对象 ———
var svc = null, startFn = null;
try {
    var getter = CONF.enumerateExports().filter(function (e) { return e.name === "GetWXConfService"; })[0];
    svc = new NativeFunction(getter.address, "pointer", ["int"])(0x1352707);
    var vt = svc.readPointer();
    startFn = vt.add(6 * 8).readPointer();
    log("svc=" + svc + " vtable=" + modOf(vt) + " vt[6]=" + modOf(startFn) +
        (startFn.equals(CONF.base.add(0x79ab4)) ? " (校验 OK)" : " (校验 不符!)"));
} catch (e) { log("取服务失败: " + e); }

// ——— 观测: wechat.dylib 分发器 / 音频 / ConfSDK vtable ———
Interceptor.attach(BASE.add("0x1fcaf64"), {
    onEnter: function () {
        var c = this.context;
        var bt = "";
        try { bt = Thread.backtrace(this.context, Backtracer.ACCURATE).slice(0, 4).map(modOf).join(" <- "); } catch (e) {}
        send({ type: "sel", sel: c.x1.toUInt32(), len: c.x4.toUInt32(), ts: Date.now(), bt: bt });
    }
});
[["0x5470688", "audioStart"], ["0x547070c", "audioStop"]].forEach(function (p) {
    Interceptor.attach(BASE.add(p[0]), {
        onEnter: function () { send({ type: "audio", hook: p[1], ts: Date.now() }); }
    });
});
if (startFn) {
    try {
        Interceptor.attach(startFn, {
            onEnter: function () {
                var c = this.context;
                send({ type: "vt6in", ts: Date.now(), buf: hexs(new Uint8Array(c.x1.readByteArray(c.x2.toUInt32()))),
                       bt: Thread.backtrace(this.context, Backtracer.ACCURATE).slice(0, 3).map(modOf).join(" <- ") });
            }
        });
    } catch (e) { log("挂 vt6 失败: " + e); }
}

log("v30 就绪 模板 " + TPL.length + "B 去掉被叫后 rest " + REST.length + "B");
var lastTag = null;
setInterval(function () {
    var tag = readText("/tmp/voip_replay.req");
    if (!tag) return;
    tag = tag.trim();
    if (!tag || tag === lastTag) return;
    lastTag = tag;
    var wxid = (readText("/tmp/voip_target.txt") || "").trim();
    if (!wxid) { send({ type: "skip", reason: "no target" }); return; }
    if (!svc || svc.isNull() || !startFn) { send({ type: "skip", reason: "no svc" }); return; }
    var pb = buildPb(wxid);
    var mem = Memory.alloc(pb.length);
    mem.writeByteArray(pb);
    var fn = new NativeFunction(startFn, "int", ["pointer", "pointer", "int"]);
    var r = null, err = null;
    try { r = fn(svc, mem, pb.length); } catch (e) { err = String(e); }
    send({ type: "dial", wxid: wxid, pb: hexs(pb), len: pb.length, ret: r, err: err, ts: Date.now() });
}, 800);
