// 探针 v58 — 广谱搜索: engine 与 obj 的所有候选子对象, 找出注入期间真正变化的结构
var CONF = Process.enumerateModules().filter(function (m) {
    return m.name.indexOf("ConfSDKdyn") !== -1 && m.size > 100 * 1024;
})[0];
var getter = CONF.enumerateExports().filter(function (e) { return e.name === "GetWXConfService"; })[0];
var svc = new NativeFunction(getter.address, "pointer", ["int"])(0x1352707);
var engine = svc.add(8).readPointer().add(0xa10);
var obj = engine.add(8).readPointer();

function readable(p) {
    try { var r = Process.findRangeByAddress(p); return !!(r && r.protection.indexOf("r") !== -1); } catch (e) { return false; }
}
var cands = [];
function scanPtrs(base, from, to, label) {
    for (var o = from; o < to; o += 8) {
        var p = null;
        try { p = base.add(o).readPointer(); } catch (e) { continue; }
        if (p.isNull()) continue;
        var s = p.toString();
        if (s.indexOf("0x8") !== 0 || s.length < 10) continue;
        var lo = parseInt(s.slice(-8), 16);
        if (lo > 0x1000 && readable(p) && cands.length < 60) {
            cands.push({ label: label + "+0x" + o.toString(16), p: p });
        }
    }
}
scanPtrs(engine, 0, 0x120, "eng");
scanPtrs(obj, 0, 0x2e0, "obj");
send({ type: "cands", n: cands.length, list: cands.map(function (c) { return c.label + "=" + c.p; }).join(" "), ts: Date.now() });

var rows = [], n = 0, t0 = Date.now();
var it = setInterval(function () {
    if (n >= 1800) {
        clearInterval(it);
        send({ type: "series", t0: t0, rows: rows.join("|"), ts: Date.now() });
        send({ type: "done", ts: Date.now() });
        return;
    }
    var parts = [Date.now() - t0];
    for (var k = 0; k < cands.length; k++) {
        var h = "";
        try {
            var a = cands[k].p.readByteArray(32);
            h = Array.from(new Uint8Array(a)).map(function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
        } catch (e) { h = "ERR"; }
        parts.push(h);
    }
    rows.push(parts.join(","));
    n++;
}, 10);
