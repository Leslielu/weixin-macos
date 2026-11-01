// 探针 v61 — 只读：把 ConfSDK 引擎对象的「音频设备格式」字段全量打印
// 目的：对比「好通话 / 坏通话」协商出来的 rec/play 采样率、声道、帧长(ms)。
// 铁律：只读内存，不挂任何 hook，不调用任何会改状态的 API。
// 用法（可作第二个会话挂在已运行的 probe 旁边）：
//   python3 tools/voip/run_probe.py tools/voip/probe61_fmt.js /tmp/fmt.log
var CONF = Process.enumerateModules().filter(function (m) {
    return m.name.indexOf("ConfSDKdyn") !== -1 && m.size > 100 * 1024;
})[0];
if (!CONF) { send({ type: "err", msg: "ConfSDKdyn not loaded" }); }
else {
    var getter = CONF.enumerateExports().filter(function (e) { return e.name === "GetWXConfService"; })[0];
    var svc = new NativeFunction(getter.address, "pointer", ["int"])(0x1352707);
    send({ type: "base", conf: CONF.base.toString(), svc: svc.toString(), ts: Date.now() });
    var inner = null;
    try { inner = svc.add(8).readPointer(); } catch (e) { send({ type: "err", msg: "svc+8 " + e }); }
    send({ type: "svc8", ptr: inner ? inner.toString() : "null" });
    if (inner && !inner.isNull()) {
        // 引擎对象 + 录音对象
        var engine = inner.add(0xa10);
        var obj = null;
        try { obj = engine.add(8).readPointer(); } catch (e) { send({ type: "err", msg: "engine+8 " + e }); }
        send({ type: "engine", ptr: engine.toString(), obj: obj ? obj.toString() : "null" });
        function dump(ptr, from, to, tag) {
            if (!ptr || ptr.isNull()) return;
            var d = {};
            for (var off = from; off <= to; off += 4) {
                try { d["0x" + off.toString(16)] = ptr.add(off).readU32(); } catch (e) {}
            }
            send({ type: tag, ptr: ptr.toString(), dump: d, ts: Date.now() });
        }
        if (obj && !obj.isNull()) dump(obj, 0x200, 0x2c0, "obj");
        dump(engine, 0, 0x80, "engineHdr");
        // 引擎对象里几个可疑指针也展开一层
        if (obj && !obj.isNull()) {
            [0x278, 0x270, 0x268, 0x260].forEach(function (off) {
                try {
                    var p = obj.add(off).readPointer();
                    if (p && !p.isNull() && p.compare(ptr(1)) > 0) {
                        dump(p, 0, 0x80, "sub+" + off.toString(16));
                    }
                } catch (e) {}
            });
        }
    }
    send({ type: "done", ts: Date.now() });
}
