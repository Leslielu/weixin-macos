// 探针 v57 — 找出录音对象里真正随时间变化的子对象 (注入期间对比)
// 对象: obj = [[svc+8]+0xa10+8]; 候选指针字段见 OFFS
var CONF = Process.enumerateModules().filter(function (m) {
    return m.name.indexOf("ConfSDKdyn") !== -1 && m.size > 100 * 1024;
})[0];
var getter = CONF.enumerateExports().filter(function (e) { return e.name === "GetWXConfService"; })[0];
var svc = new NativeFunction(getter.address, "pointer", ["int"])(0x1352707);
var engine = svc.add(8).readPointer().add(0xa10);
var obj = engine.add(8).readPointer();
var OFFS = [0x1c0, 0x1c8, 0x1d0, 0x218, 0x26c, 0x270, 0x278, 0x298, 0x2a0, 0x2a8, 0x2b0, 0x2b8];
var subs = [];
OFFS.forEach(function (o) {
    var p = null;
    try { p = obj.add(o).readPointer(); } catch (e) {}
    subs.push({ off: o, p: p });
});
send({ type: "init", obj: obj.toString(), subs: subs.map(function (s) { return "0x" + s.off.toString(16) + "=" + s.p; }).join(" "), ts: Date.now() });

var rows = [], n = 0, t0 = Date.now();
var it = setInterval(function () {
    if (n >= 2200) {
        clearInterval(it);
        send({ type: "series", t0: t0, rows: rows.join("|"), ts: Date.now() });
        send({ type: "done", ts: Date.now() });
        return;
    }
    var parts = [Date.now() - t0];
    for (var k = 0; k < subs.length; k++) {
        var p = subs[k].p, h = "";
        if (p && !p.isNull()) {
            try {
                var a = p.readByteArray(24);
                h = Array.from(new Uint8Array(a)).map(function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
            } catch (e) { h = "ERR"; }
        }
        parts.push(h);
    }
    rows.push(parts.join(","));
    n++;
}, 10);
