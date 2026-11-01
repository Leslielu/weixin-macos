// 探针 v65b — 统计 sendto/sendmsg/writev 调用节奏(修正 msghdr 偏移), 找语音媒体出口
var gx = (typeof Module.getGlobalExportByName === "function")
    ? function (n) { try { return Module.getGlobalExportByName(n); } catch (e) { return null; } }
    : function (n) { try { return Module.findExportByName(null, n); } catch (e) { return null; } };

var kind = { sendto: [], sendmsg: [], writev: [] };
var when = { sendto: [], sendmsg: [], writev: [] };
var on = false;
function rec(k, size) { if (!on) return; kind[k].push(size); when[k].push(Date.now()); }

var st = gx("sendto");
if (st) Interceptor.attach(st, { onEnter: function (a) {
    try { rec("sendto", a[2].toInt32()); } catch (e) {}
}});
var sm = gx("sendmsg");
if (sm) Interceptor.attach(sm, { onEnter: function (a) {
    try {
        var mh = a[1];
        var iov = mh.add(16).readPointer();
        var n = mh.add(24).readU32();
        var total = 0;
        for (var i = 0; i < Math.min(n, 8); i++) {
            total += iov.add(i * 16 + 8).readU64().toNumber();
        }
        rec("sendmsg", total);
    } catch (e) {}
}});
var wv = gx("writev");
if (wv) Interceptor.attach(wv, { onEnter: function (a) {
    try {
        var iov = a[1], n = a[2].toInt32(), total = 0;
        for (var i = 0; i < Math.min(n, 8); i++) total += iov.add(i * 16 + 8).readU64().toNumber();
        rec("writev", total);
    } catch (e) {}
}});

function report() {
    var out = [];
    Object.keys(kind).forEach(function (k) {
        var n = kind[k].length; if (!n) return;
        var t = when[k]; var dur = (t[n - 1] - t[0]) / 1000;
        var iv = []; for (var i = 1; i < n; i++) iv.push(t[i] - t[i - 1]);
        iv.sort(function (a, b) { return a - b; });
        var hist = {}; kind[k].forEach(function (s) { hist[s] = (hist[s] || 0) + 1; });
        var top = Object.keys(hist).sort(function (a, b) { return hist[b] - hist[a]; }).slice(0, 6);
        out.push(k + ": n=" + n + " " + (dur > 0 ? (n / dur).toFixed(1) : 0) + "/s iv中位=" +
                 (iv.length ? iv[Math.floor(iv.length / 2)] : 0) + " p10=" +
                 (iv.length ? iv[Math.floor(iv.length * 0.1)] : 0) + " p90=" +
                 (iv.length ? iv[Math.floor(iv.length * 0.9)] : 0) + " | " +
                 top.map(function (s) { return s + "x" + hist[s]; }).join(" "));
        kind[k] = []; when[k] = [];
    });
    if (out.length) send({ type: "rate", lines: out });
}
setInterval(function () {
    var ex = false; try { var f = new File("/tmp/udp.on", "r"); f.close(); ex = true; } catch (e) {}
    if (ex !== on) { on = ex; send({ type: "switch", on: on }); }
}, 300);
setInterval(report, 2000);
send({ type: "ready", sendto: String(st), sendmsg: String(sm), writev: String(wv) });
