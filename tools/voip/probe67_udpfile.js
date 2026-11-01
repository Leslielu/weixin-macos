// 探针 v67 — 把 sendto 原始序列((相对ms) 长度)直接写成文本文件, 避免大 JSON 走 IPC
// 触发: /tmp/udp.dump 内容变化 → 落盘 /tmp/udpseq.txt (首列相对第一包的毫秒)
var st = (typeof Module.getGlobalExportByName === "function")
    ? Module.getGlobalExportByName("sendto") : Module.findExportByName(null, "sendto");
var buf = [], CAP = 6000;
Interceptor.attach(st, { onEnter: function (a) {
    try {
        var size = a[2].toInt32();
        if (size < 40 || size > 1500) return;
        var ad = a[4];
        if (!ad.isNull()) { var f = ad.readU8(); if (f !== 2 && f !== 30) return; }
        buf.push([Date.now(), size]);
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
        var f = new File("/tmp/udpseq.txt", "w");
        f.write("tag " + s + " n " + buf.length + "\n");
        var base = buf.length ? buf[0][0] : Date.now();
        for (var i = 0; i < buf.length; i++) f.write((buf[i][0] - base) + " " + buf[i][1] + "\n");
        f.flush(); f.close();
        send({ type: "dumped", n: buf.length, file: "/tmp/udpseq.txt" });
    } catch (e) { send({ type: "err", msg: String(e) }); }
}, 200);
send({ type: "ready" });
