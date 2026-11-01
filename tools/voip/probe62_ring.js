// 探针 v62 — 只读：dump 录音对象全量内存两遍, 找随通话推进的计数器/读写指针
// 只在通话中有效(obj = [[svc+8]+0xa10+8] 非空)
var CONF = Process.enumerateModules().filter(function (m) {
    return m.name.indexOf("ConfSDKdyn") !== -1 && m.size > 100 * 1024;
})[0];
var getter = CONF.enumerateExports().filter(function (e) { return e.name === "GetWXConfService"; })[0];
var svc = new NativeFunction(getter.address, "pointer", ["int"])(0x1352707);
function snap(tag) {
    var engine = svc.add(8).readPointer().add(0xa10);
    var obj = engine.add(8).readPointer();
    if (!obj.isNull()) {
        var out = {};
        for (var off = 0; off < 0x400; off += 4) {
            try { out[off] = obj.add(off).readU32(); } catch (e) { out[off] = -1; }
        }
        send({ type: "snap", tag: tag, ptr: obj.toString(), t: Date.now(), dump: out });
        // 指针字段也记一份, 后面单独展开
        var ptrs = {};
        for (var off2 = 0; off2 < 0x400; off2 += 8) {
            try {
                var p = obj.add(off2).readPointer();
                if (p.compare(ptr(0x1000000)) > 0 && p.compare(ptr(0x8000000000)) < 0) {
                    ptrs["0x" + off2.toString(16)] = p.toString();
                }
            } catch (e) {}
        }
        send({ type: "ptrs", tag: tag, ptrs: ptrs });
    } else {
        send({ type: "snap", tag: tag, msg: "obj null (无通话)", t: Date.now() });
    }
}
snap("t0");
setTimeout(function () { snap("t1"); }, 2000);
setTimeout(function () { snap("t2"); send({ type: "done" }); }, 4000);
