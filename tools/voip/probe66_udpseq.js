// 探针 v66 — 记录 sendto 原始序列(时刻+长度), 由 /tmp/udp.dump 触发落盘
var st = (typeof Module.getGlobalExportByName === "function")
    ? Module.getGlobalExportByName("sendto") : Module.findExportByName(null, "sendto");
var buf = [];              // [t, size]
var cap = 4000;
Interceptor.attach(st, { onEnter: function (a) {
    try {
        var size = a[2].toInt32();
        if (size < 40 || size > 1500) return;
        var ad = a[4];
        if (!ad.isNull()) { var f = ad.readU8(); if (f !== 2 && f !== 30) return; }
        buf.push([Date.now(), size]);
        if (buf.length > cap) buf.splice(0, buf.length - cap);
    } catch (e) {}
}});
function readText(p) { try { var f = new File(p, "r"); var t = f.readText(); f.close(); return t; } catch (e) { return null; } }
var last = (readText("/tmp/udp.dump") || "").trim();
setInterval(function () {
    var s = readText("/tmp/udp.dump");
    if (s && (s = s.trim()) && s !== last) {
        last = s;
        var base = buf.length ? buf[0][0] : Date.now();
        send({ type: "seq", tag: s, n: buf.length,
               data: buf.map(function (e) { return [e[0] - base, e[1]]; }) });
    }
}, 300);
send({ type: "ready" });
