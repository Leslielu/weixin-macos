// 探针 v71 — 接收侧数字下行落盘(绕过播放/AEC), 用于判定 20ms 空洞是否已经存在于网络流中
// 触发: /tmp/rx.req 内容变化 → 开始/结束一个 pcm 文件
// 用法: echo A > /tmp/rx.req  开始; echo B > /tmp/rx.req 结束, 文件 /tmp/rx_<ts>.pcm
var CONF = Process.enumerateModules().filter(function (m) {
    return m.name.indexOf("ConfSDKdyn") !== -1 && m.size > 100 * 1024;
})[0];
if (!CONF) throw new Error("ConfSDKdyn not found");
var getter = CONF.enumerateExports().filter(function (e) { return e.name === "GetWXConfService"; })[0];
var svc = new NativeFunction(getter.address, "pointer", ["int"])(0x1352707);
var vt = svc.readPointer();

var rxFile = null, rxBytes = 0, rxPath = null, frames = 0, sizes = {};
var SIZECAP = 4000;
Interceptor.attach(vt.add(14 * 8).readPointer(), {
    onEnter: function (args) {
        if (rxFile === null) return;
        try {
            var n = args[2].toInt32();
            sizes[n] = (sizes[n] || 0) + 1;
            if (n <= 0 || n > 8192) return;
            // 延迟一行: onEnter 读到的仍是上一帧缓冲
            rxFile.write(new Uint8Array(args[1].readByteArray(n)));
            rxBytes += n; frames++;
        } catch (e) {}
    }
});

function rd(p) { try { var f = new File(p, "r"); var t = f.readText(); f.close(); return t.trim(); } catch (e) { return null; } }
globalThis.__last = rd("/tmp/rx.req");
setInterval(function () {
    var s = rd("/tmp/rx.req");
    if (s === null || s === globalThis.__last) return;
    globalThis.__last = s;
    if (rxFile === null) {
        rxPath = "/tmp/rx_" + Date.now() + ".pcm";
        rxFile = new File(rxPath, "wb"); rxBytes = 0; frames = 0; sizes = {};
        send({ type: "rxOpen", path: rxPath, ts: Date.now() });
    } else {
        try { rxFile.close(); } catch (e) {}
        send({ type: "rxClose", path: rxPath, bytes: rxBytes, frames: frames, sizes: sizes, ts: Date.now() });
        rxFile = null;
    }
}, 200);
send({ type: "ready", svc: String(svc), vt: String(vt) });
