// 探针 v69 — 记录 sendto 每包的 (相对ms, 长度, 载荷哈希, 首4字节hex), 触发落盘
// 用途: 分清哪一路流是我们的注入音频, 并数出"静音帧"占比
var st = (typeof Module.getGlobalExportByName === "function")
    ? Module.getGlobalExportByName("sendto") : Module.findExportByName(null, "sendto");
var buf = [], CAP = 8000;
function h32(p, n) {              // FNV-1a 32bit
    var h = 0x811c9dc5;
    for (var i = 0; i < n; i++) {
        h ^= p.add(i).readU8();
        h = (h * 0x01000193) >>> 0;
    }
    return h;
}
Interceptor.attach(st, { onEnter: function (a) {
    try {
        var n = a[2].toInt32();
        if (n < 40 || n > 300) return;
        var p = a[1];
        if (p.isNull()) return;
        var head = "";
        for (var i = 0; i < 4 && i < n; i++) head += ("0" + p.add(i).readU8().toString(16)).slice(-2);
        buf.push([Date.now(), n, h32(p, n), head]);
        if (buf.length > CAP) buf.splice(0, buf.length - CAP);
    } catch (e) {}
}});
function readText(p) { try { var f = new File(p, "r"); var t = f.readText(); f.close(); return t; } catch (e) { return null; } }
globalThis.__last = readText("/tmp/udp.dump");
setInterval(function () {
    var s = readText("/tmp/udp.dump");
    if (!s) return;
    s = s.trim();
    if (s === globalThis.__last) return;
    globalThis.__last = s;
    try {
        var f = new File("/tmp/payload.txt", "w");
        var base = buf.length ? buf[0][0] : Date.now();
        f.write("tag " + s + " n " + buf.length + "\n");
        for (var i = 0; i < buf.length; i++)
            f.write((buf[i][0] - base) + " " + buf[i][1] + " " + buf[i][2] + " " + buf[i][3] + "\n");
        f.flush(); f.close();
        send({ type: "dumped", n: buf.length });
    } catch (e) { send({ type: "err", msg: String(e) }); }
}, 200);
send({ type: "ready" });
