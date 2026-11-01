// 探针 v52 — 定位 ConfSDK 引擎内部真正的媒体对象
// 链路: thunk(svc) -> [svc+8] -> +0x38424: engine = [svc+8]+0xa10 -> +0x65cd4 再转发 [engine+8] 的 vtable+0x300
// 目标: 找出 [engine+8] 属于哪个模块/什么对象, 以便判断真正的帧语义与队列容量。
var CONF = Process.enumerateModules().filter(function (m) {
    return m.name.indexOf("ConfSDKdyn") !== -1 && m.size > 100 * 1024;
})[0];
if (!CONF) throw new Error("ConfSDKdyn not found");
var getter = CONF.enumerateExports().filter(function (e) { return e.name === "GetWXConfService"; })[0];
var svc = new NativeFunction(getter.address, "pointer", ["int"])(0x1352707);
var inner = svc.add(8).readPointer();
var engine = inner.add(0xa10);
var obj = engine.add(8).readPointer();
var vt = obj.readPointer();

function where(p) {
    var m = Process.findModuleByAddress(p);
    if (!m) return "?";
    var off = p.sub(m.base);
    var sym = null;
    try {
        var ex = m.enumerateExports().filter(function (e) { return e.address.equals(p); })[0];
        if (ex) sym = ex.name;
    } catch (e) {}
    return m.name + "+0x" + off.toString(16) + (sym ? " <" + sym + ">" : "");
}

send({ type: "log", msg: "svc=" + svc + " inner=[svc+8]=" + inner + " engine=" + engine + " obj=[engine+8]=" + obj, ts: Date.now() });
send({ type: "vtable", at: vt.toString(), module: where(vt), ts: Date.now() });

for (var i = 0; i < 40; i++) {
    var fn = null;
    try { fn = vt.add(i * 8).readPointer(); } catch (e) {}
    if (!fn || fn.isNull()) continue;
    send({ type: "slot", i: i, fn: fn.toString(), where: where(fn), ts: Date.now() });
}
// 头部内存 (对象头/字段)
try {
    send({ type: "objhead", hex: Array.from(new Uint8Array(obj.readByteArray(64))).map(function (b) { return ("0" + b.toString(16)).slice(-2); }).join(""), ts: Date.now() });
    send({ type: "enginehead", hex: Array.from(new Uint8Array(engine.readByteArray(64))).map(function (b) { return ("0" + b.toString(16)).slice(-2); }).join(""), ts: Date.now() });
} catch (e) { send({ type: "err", msg: String(e) }); }
