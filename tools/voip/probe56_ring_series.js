// 探针 v56 — 录音对象环形缓冲占用时间序列采样 (10ms x 2000 = 20s)
// 目的: 判定 50% 缺口发生在发送侧(环形缓冲被取空后可复填) 还是其它路径(缓冲不变化)
var CONF = Process.enumerateModules().filter(function (m) {
    return m.name.indexOf("ConfSDKdyn") !== -1 && m.size > 100 * 1024;
})[0];
var getter = CONF.enumerateExports().filter(function (e) { return e.name === "GetWXConfService"; })[0];
var svc = new NativeFunction(getter.address, "pointer", ["int"])(0x1352707);
var engine = svc.add(8).readPointer().add(0xa10);
var obj = engine.add(8).readPointer();
var ring = obj.add(0x278).readPointer();
send({ type: "init", obj: obj.toString(), ring: ring.toString(), ts: Date.now() });

// 宽 dump: obj+0x1c0..0x320 按 u32, 便于识别指针/计数
var wide = [];
for (var o = 0x1c0; o < 0x320; o += 4) {
    var v = 0;
    try { v = obj.add(o).readU32(); } catch (e) {}
    wide.push(o.toString(16) + ":" + v);
}
send({ type: "wide", dump: wide.join(" "), ts: Date.now() });

var rows = [];
var n = 0;
var t0 = Date.now();
var it = setInterval(function () {
    if (n >= 2000) { clearInterval(it); send({ type: "series", t0: t0, rows: rows.join("|"), ts: Date.now() }); send({ type: "done", ts: Date.now() }); return; }
    var parts = [Date.now() - t0];
    try {
        for (var i = 0; i < 8; i++) parts.push(ring.add(i * 4).readU32());
    } catch (e) { parts.push("E"); }
    try {
        parts.push(obj.add(0x260).readU32());
        parts.push(obj.add(0x274).readU32());
        parts.push(obj.add(0x27c).readU32());
        parts.push(obj.add(0x280).readU32());
        parts.push(obj.add(0x284).readU32());
    } catch (e) {}
    rows.push(parts.join(","));
    n++;
}, 10);
