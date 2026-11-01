// 探针 v68 — 不过滤, 记录所有 sendto 的 (相对ms, 长度, 地址族/255=空地址), 触发落盘
var st = (typeof Module.getGlobalExportByName === "function")
    ? Module.getGlobalExportByName("sendto") : Module.findExportByName(null, "sendto");
var buf = [], CAP = 8000;
Interceptor.attach(st, { onEnter: function (a) {
    try {
        var size = a[2].toInt32();
        var ad = a[4], fam = 255;
        if (!ad.isNull()) { try { fam = ad.readU8(); } catch (e) { fam = 254; } }
        buf.push([Date.now(), size, fam]);
        if (buf.length > CAP) buf.splice(0, buf.length - CAP);
    } catch (e) {}
}});
function readText(p) { try { var f = new File(p, "r"); var t = f.readText(); f.close(); return t; } catch (e) { return null; } }
setInterval(function () {
    var s = readText("/tmp/udp.dump");
    if (!s) return;
    s = s.trim();
    if (s === globalThis.__last) return;
    globalThis.__last = s;
    try {
        var f = new File("/tmp/sendall.txt", "w");
        var base = buf.length ? buf[0][0] : Date.now();
        f.write("n " + buf.length + "\n");
        for (var i = 0; i < buf.length; i++)
            f.write((buf[i][0] - base) + " " + buf[i][1] + " " + buf[i][2] + "\n");
        f.flush(); f.close();
        send({ type: "dumped", n: buf.length });
    } catch (e) { send({ type: "err", msg: String(e) }); }
}, 200);
send({ type: "ready" });
