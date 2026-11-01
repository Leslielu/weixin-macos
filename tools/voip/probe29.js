// 探针 v29 — 深挖拨号瞬间的 ConfSDK vt[6] (ConfSDKdyn+0x79ab4) 与其 wechat.dylib 调用方
// 目的: vt[6] 的入参里找出「被叫 wxid / 会话参数」，判断能否直接调用它发起一通原生通话
var REAL_MOD = Process.enumerateModules().filter(function (m) {
    return /wechat\.dylib/i.test(m.name) && m.size > 100 * 1024 * 1024;
})[0];
if (!REAL_MOD) throw new Error("wechat.dylib real image not found");
var BASE = REAL_MOD.base;
var CONF = Process.enumerateModules().filter(function (m) {
    return /ConfSDKdyn/i.test(m.name) && m.size > 100 * 1024;
})[0];
if (!CONF) throw new Error("ConfSDKdyn real image not found");

function log(s) { send({ type: "log", msg: s, ts: Date.now() }); }
function modOf(addr) {
    var m = Process.findModuleByAddress(addr);
    return m ? m.name + "+0x" + addr.sub(m.base).toString(16) : String(addr);
}
function hexs(b, n) {
    return Array.from(b.slice(0, n)).map(function (x) { return ("0" + x.toString(16)).slice(-2); }).join("");
}
function readable(p, n) {
    try {
        var r = Process.findRangeByAddress(p);
        if (!r) return 0;
        if (r.protection.indexOf("r") < 0) return 0;
        var avail = r.base.add(r.size).sub(p).toInt32();
        return avail > 0 ? Math.min(n, avail) : 0;
    } catch (e) { return 0; }
}
function asciify(b) {
    var s = "";
    for (var i = 0; i < b.length; i++) {
        var c = b[i];
        s += (c >= 0x20 && c < 0x7f) ? String.fromCharCode(c) : ".";
    }
    return s;
}
function dump(label, p, n) {
    var k = readable(p, n);
    if (!k) return label + " " + p + " <unmapped>";
    try {
        var b = new Uint8Array(p.readByteArray(k));
        return label + " " + p + " (" + k + "B)\n  hex: " + hexs(b, 96) + "\n  asc: " + asciify(b.slice(0, 96));
    } catch (e) { return label + " <err " + e + ">"; }
}
// 在该内存块里扫指针 → 可打印串（wxid_/o9cq/voip/数字 uin）
function scanPtrs(label, p, n) {
    var k = readable(p, n), out = [];
    if (!k) return label + " <unmapped>";
    try {
        var b = new Uint8Array(p.readByteArray(k));
        for (var off = 0; off + 8 <= b.length; off += 8) {
            var v = 0;
            for (var i = 7; i >= 0; i--) v = v * 256 + b[off + i];
            var hp = ptr(v);
            var r = readable(hp, 1);
            if (!r) continue;
            var s = "";
            try { s = hp.readCString(96); } catch (e) { continue; }
            if (s && /^[\x20-\x7e]{3,90}$/.test(s) && /(wxid_|o9cq|voip|im\.wechat|[A-Za-z]{4,})/.test(s)) {
                out.push("+0x" + off.toString(16) + " -> " + s);
            }
            if (out.length >= 10) break;
        }
    } catch (e) { return label + " <err " + e + ">"; }
    return label + " 指针串: " + (out.length ? out.join(" | ") : "(无)");
}
function regs(c) {
    return ["x0", "x1", "x2", "x3", "x4", "x5", "x6", "x7"].map(function (r) { return r + "=" + c[r]; }).join(" ");
}

var n6 = 0;
Interceptor.attach(CONF.base.add(0x79ab4), {
    onEnter: function () {
        if (++n6 > 2) return;
        var c = this.context;
        this.p1 = c.x1; this.p3 = c.x3;
        var bt = "";
        try { bt = Thread.backtrace(this.context, Backtracer.ACCURATE).slice(0, 8).map(modOf).join(" <- "); } catch (e) {}
        send({
            type: "vt6", ts: Date.now(), regs: regs(c), bt: bt,
            d1: dump("x1对象", c.x1, 0x30), s3: dump("x3串", c.x3, 0x20),
            scan: scanPtrs("x1", c.x1, 0x120)
        });
    },
    onLeave: function (retval) {
        if (n6 > 2) return;
        send({ type: "vt6ret", ts: Date.now(), ret: String(retval),
               retObj: (readable(ptr(String(retval)), 8) ? dump("返回对象", ptr(String(retval)), 0x40) : ""),
               scanAfter: scanPtrs("x1后", this.p1, 0x120) });
    }
});

// wechat.dylib 侧调用 vt[6] 的直接调用方 0x1fc1278 及其上一层 0x1fe2b28 / 0x1fe9680
[["0x1fc1278", "wxCaller"], ["0x1fe2b28", "wxCallerUp1"]].forEach(function (h) {
    var n = 0;
    try {
        Interceptor.attach(BASE.add(h[0]), {
            onEnter: function () {
                if (++n > 2) return;
                var c = this.context;
                var bt = "";
                try { bt = Thread.backtrace(this.context, Backtracer.ACCURATE).slice(0, 10).map(modOf).join(" <- "); } catch (e) {}
                send({
                    type: "wx", hook: h[1], ts: Date.now(), regs: regs(c), bt: bt,
                    d0: dump("x0", c.x0, 0x40), s1: dump("x1", c.x1, 0x20),
                    scan0: scanPtrs("x0", c.x0, 0x100), scan1: scanPtrs("x1", c.x1, 0x80),
                    scan2: scanPtrs("x2", c.x2, 0x80)
                });
            }
        });
    } catch (e) { log("hook " + h[1] + " 失败: " + e); }
});

log("=== v29 就绪 ConfSDKdyn@" + CONF.base + " wechat@" + BASE + " 请手动拨一次(响铃后挂断) ===");
