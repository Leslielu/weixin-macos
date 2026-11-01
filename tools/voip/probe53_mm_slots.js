// 探针 v53 — 定位 MultiMediaDyn 内层媒体对象的 vtable 槽 +0x300/+0x308 并反汇编
// 链路: [svc+8]+0xa10 = engine, [engine+8] = obj (MultiMediaDyn), vt=obj[0]
// 目标: 弄清 +0x300 (外部录音数据入口) 的真实契约: 帧长/采样率/队列行为
var CONF = Process.enumerateModules().filter(function (m) {
    return m.name.indexOf("ConfSDKdyn") !== -1 && m.size > 100 * 1024;
})[0];
if (!CONF) throw new Error("ConfSDKdyn not found");
var getter = CONF.enumerateExports().filter(function (e) { return e.name === "GetWXConfService"; })[0];
var svc = new NativeFunction(getter.address, "pointer", ["int"])(0x1352707);
if (svc.isNull()) { send({ type: "log", msg: "svc NULL (call ended?)", ts: Date.now() }); }
var inner = svc.add(8).readPointer();
var engine = inner.add(0xa10);
var obj = engine.add(8).readPointer();
var vt = obj.readPointer();

var MM = Process.enumerateModules().filter(function (m) { return m.name.indexOf("MultiMediaDyn") !== -1; })[0];
send({ type: "log", msg: "MM=" + (MM ? MM.base + " size=0x" + MM.size.toString(16) : "?"), ts: Date.now() });

function where(p) {
    var m = Process.findModuleByAddress(p);
    if (!m) return "?(" + p + ")";
    return m.name + "+0x" + p.sub(m.base).toString(16);
}
function dis(addr, n) {
    var out = [], ins = Instruction.parse(addr);
    for (var i = 0; i < n; i++) {
        out.push(where(ins.address) + "  " + ins.mnemonic + " " + ins.opStr);
        ins = Instruction.parse(ins.next);
    }
    return out;
}

send({ type: "log", msg: "svc=" + svc + " engine=" + engine + " obj=" + obj + " vt=" + vt, ts: Date.now() });
for (var i = 92; i <= 100; i++) {
    var fn = null;
    try { fn = vt.add(i * 8).readPointer(); } catch (e) {}
    if (fn && !fn.isNull()) send({ type: "slot", i: i, fn: fn.toString(), where: where(fn), ts: Date.now() });
}
[96, 97].forEach(function (i) {
    var fn = null;
    try { fn = vt.add(i * 8).readPointer(); } catch (e) { return; }
    if (!fn || fn.isNull()) return;
    try { send({ type: "impl", slot: i, lines: dis(fn, 90), ts: Date.now() }); }
    catch (e) { send({ type: "err", msg: String(e) }); }
});
send({ type: "done", ts: Date.now() });
