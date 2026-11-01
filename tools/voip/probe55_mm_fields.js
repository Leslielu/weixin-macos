// 探针 v55 — dump MultiMediaDyn 录音对象的关键字段与环形缓冲对象
// obj = [[svc+8]+0xa10+8]; 已知 +0x234=16000(rate) +0x248=20(frameMs)
var CONF = Process.enumerateModules().filter(function (m) {
    return m.name.indexOf("ConfSDKdyn") !== -1 && m.size > 100 * 1024;
})[0];
var getter = CONF.enumerateExports().filter(function (e) { return e.name === "GetWXConfService"; })[0];
var svc = new NativeFunction(getter.address, "pointer", ["int"])(0x1352707);
var engine = svc.add(8).readPointer().add(0xa10);
var obj = engine.add(8).readPointer();
function where(p) {
    var m = Process.findModuleByAddress(p);
    if (!m) return "?(" + p + ")";
    return m.name + "+0x" + p.sub(m.base).toString(16);
}
var d = {};
for (var off = 0x230; off <= 0x2a0; off += 4) {
    try { d["0x" + off.toString(16)] = obj.add(off).readU32(); } catch (e) {}
}
send({ type: "fields", dump: d, ts: Date.now() });
try {
    var ringPtr = obj.add(0x278).readPointer();
    var lines = [];
    for (var i = 0; i < 16; i++) {
        var v = ringPtr.add(i * 8).readU64();
        lines.push("ring+" + (i * 8).toString(16) + " = 0x" + v.toString(16) + "  (u32 " + v.and(0xffffffff).toNumber() + ")");
    }
    send({ type: "ring", ptr: ringPtr.toString(), where: where(ringPtr), lines: lines, ts: Date.now() });
    try { var vtp = ringPtr.readPointer(); send({ type: "ringvt", vt: vtp.toString(), where: where(vtp) }); } catch (e) {}
} catch (e) { send({ type: "err", msg: "ring " + e }); }
// 顶层 engine 对象里也可能有线索
send({ type: "eng", hex: Array.from(new Uint8Array(engine.readByteArray(0x60))).map(function (b) { return ("0" + b.toString(16)).slice(-2); }).join(""), ts: Date.now() });
send({ type: "done", ts: Date.now() });
