// 探针 v64 — 只挂 sendto(轻量, 不挂钩音频函数), 统计 UDP 语音包的发送节奏
// 用途: 分清「发送侧每 40ms 才发一个包」还是「接收侧丢包」。
// 触发: /tmp/udp.on 存在时才统计(避免平时开销); 每 2s 汇报一次。
var sendto = (typeof Module.getGlobalExportByName === "function")
    ? Module.getGlobalExportByName("sendto") : Module.findExportByName(null, "sendto");
var sizes = [];      // 本窗口内的包长
var times = [];      // 本窗口内的发送时刻(ms)
var on = false;
var lastToggle = (function () { try { var f = new File("/tmp/udp.on", "r"); f.close(); return true; } catch (e) { return false; } })();

Interceptor.attach(sendto, {
    onEnter: function (args) {
        if (!on) return;
        try {
            var addr = args[4];                       // struct sockaddr*
            if (addr.isNull()) return;
            var family = addr.readU8();
            if (family !== 2 && family !== 30) return; // AF_INET / AF_INET6
            var size = args[2].toInt32();             // size_t len
            if (size < 8 || size > 2000) return;
            sizes.push(size);
            times.push(Date.now());
        } catch (e) {}
    }
});

function stats() {
    if (!on || sizes.length === 0) { sizes = []; times = []; return; }
    var n = sizes.length;
    var dur = (times[n - 1] - times[0]) / 1000;
    var iv = [];
    for (var i = 1; i < n; i++) iv.push(times[i] - times[i - 1]);
    iv.sort(function (a, b) { return a - b; });
    var hist = {};
    for (var k = 0; k < n; k++) hist[sizes[k]] = (hist[sizes[k]] || 0) + 1;
    var top = Object.keys(hist).sort(function (a, b) { return hist[b] - hist[a]; }).slice(0, 5);
    send({ type: "udp", n: n, secs: Number(dur.toFixed(2)),
           pktPerSec: dur > 0 ? Number((n / dur).toFixed(1)) : 0,
           ivMedianMs: iv.length ? iv[Math.floor(iv.length / 2)] : 0,
           ivP10: iv.length ? iv[Math.floor(iv.length * 0.1)] : 0,
           ivP90: iv.length ? iv[Math.floor(iv.length * 0.9)] : 0,
           topSizes: top.map(function (s) { return s + "x" + hist[s]; }).join(" "),
           ts: Date.now() });
    sizes = []; times = [];
}

setInterval(function () {
    var exists = false;
    try { var f = new File("/tmp/udp.on", "r"); f.close(); exists = true; } catch (e) {}
    if (exists !== on) { on = exists; sizes = []; times = []; send({ type: "udpSwitch", on: on }); }
}, 300);
setInterval(stats, 2000);
send({ type: "ready", sendto: sendto });
