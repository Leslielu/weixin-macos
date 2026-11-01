// 探针 v54 — 反汇编 MultiMediaDyn 录音槽 +0x300 的真实实现, 并 dump 关键字段
// slot96(+0x300)=record push -> thunk sub x0,#8; b <target>
// slot97(+0x308)=play push
var CONF = Process.enumerateModules().filter(function (m) {
    return m.name.indexOf("ConfSDKdyn") !== -1 && m.size > 100 * 1024;
})[0];
var getter = CONF.enumerateExports().filter(function (e) { return e.name === "GetWXConfService"; })[0];
var svc = new NativeFunction(getter.address, "pointer", ["int"])(0x1352707);
var engine = svc.add(8).readPointer().add(0xa10);
var obj = engine.add(8).readPointer();
var vt = obj.readPointer();

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
function followThunk(addr, depth) {
    var a = addr, hops = [];
    for (var d = 0; d < (depth || 3); d++) {
        var ins = Instruction.parse(a), target = null;
        for (var k = 0; k < 5; k++) {
            if (ins.mnemonic === "b") {
                try { target = ptr(ins.opStr.replace("#", "")); } catch (e) {}
                break;
            }
            ins = Instruction.parse(ins.next);
        }
        if (!target) break;
        hops.push(where(target));
        a = target;
    }
    return { addr: a, hops: hops };
}

[96, 97].forEach(function (i) {
    var fn = vt.add(i * 8).readPointer();
    var r = followThunk(fn, 4);
    send({ type: "impl", slot: i, start: where(fn), hops: r.hops, final: where(r.addr),
           lines: dis(r.addr, 120), ts: Date.now() });
});

// 关键字段
var fields = {};
[0x218, 0x234, 0x248, 0x24c, 0x25c, 0x260, 0x280].forEach(function (off) {
    try { fields["+0x" + off.toString(16)] = obj.add(off).readU32() + " (0x" + obj.add(off).readU32().toString(16) + ")"; }
    catch (e) { fields["+0x" + off.toString(16)] = "err"; }
});
send({ type: "fields", obj: obj.toString(), dump: fields, ts: Date.now() });
try {
    send({ type: "byte5418", v: obj.add(0x5418).readU8(), ts: Date.now() });
    send({ type: "objminus8", hex: Array.from(new Uint8Array(obj.sub(8).readByteArray(32))).map(function (b) { return ("0" + b.toString(16)).slice(-2); }).join(""), ts: Date.now() });
} catch (e) { send({ type: "err", msg: String(e) }); }
send({ type: "done", ts: Date.now() });
