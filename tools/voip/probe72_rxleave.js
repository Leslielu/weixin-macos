// 探针 v72 — 同 v71 但改为 onLeave 读下行缓冲(调用返回后数据已填充)
// 同时统计 onEnter/onLeave 两处的非零率, 判定哪一处才拿得到真实音频
var CONF = Process.enumerateModules().filter(function (m) {
    return m.name.indexOf("ConfSDKdyn") !== -1 && m.size > 100 * 1024;
})[0];
if (!CONF) throw new Error("ConfSDKdyn not found");
var getter = CONF.enumerateExports().filter(function (e) { return e.name === "GetWXConfService"; })[0];
var svc = new NativeFunction(getter.address, "pointer", ["int"])(0x1352707);
var vt = svc.readPointer();

var rxFile = null, rxBytes = 0, rxPath = null, frames = 0;
var nzEnter = 0, nzLeave = 0, seenEnter = 0, seenLeave = 0;

Interceptor.attach(vt.add(14 * 8).readPointer(), {
    onEnter: function (args) {
        this.p = args[1]; this.n = args[2].toInt32();
        if (rxFile === null) return;
        try {
            if (this.n > 0 && this.n <= 8192) {
                seenEnter++;
                var b = new Uint8Array(this.p.readByteArray(this.n));
                for (var i = 0; i < b.length; i++) if (b[i] !== 0) { nzEnter++; break; }
            }
        } catch (e) {}
    },
    onLeave: function (ret) {
        if (rxFile === null) return;
        try {
            if (this.n > 0 && this.n <= 8192) {
                seenLeave++;
                var b = new Uint8Array(this.p.readByteArray(this.n));
                var nz = false;
                for (var i = 0; i < b.length; i++) if (b[i] !== 0) { nz = true; break; }
                if (nz) nzLeave++;
                rxFile.write(b); rxBytes += this.n; frames++;
            }
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
        rxPath = "/tmp/rxl_" + Date.now() + ".pcm";
        rxFile = new File(rxPath, "wb"); rxBytes = 0; frames = 0; nzEnter = 0; nzLeave = 0; seenEnter = 0; seenLeave = 0;
        send({ type: "rxOpen", path: rxPath, ts: Date.now() });
    } else {
        try { rxFile.close(); } catch (e) {}
        send({ type: "rxClose", path: rxPath, bytes: rxBytes, frames: frames,
               seenEnter: seenEnter, nzEnter: nzEnter, seenLeave: seenLeave, nzLeave: nzLeave, ts: Date.now() });
        rxFile = null;
    }
}, 200);
send({ type: "ready", svc: String(svc), vt: String(vt) });
