// 探针 v26 — 从 ConfSDKdyn 内部帧深挖调用栈，找 wechat.dylib 侧的 UI 入口(带被叫 wxid)
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
function tryStr(p) {
    try {
        if (p.isNull()) return "";
        var s = p.readCString();
        if (s && s.length > 2 && s.length < 200 && /^[\x20-\x7e]+$/.test(s)) return s;
    } catch (e) {}
    return "";
}
function scanStr(ptr0, max) {
    // 在结构体里扫可打印串(wxid_/o9cq/voip-2p 之类)
    var out = [];
    try {
        for (var off = 0; off < max; off += 8) {
            var p = ptr0.add(off).readPointer();
            var s = tryStr(p);
            if (s && /^(wxid_|o9cq|voip-|ludaohe|[0-9a-zA-Z_.-]{4,}$)/.test(s) && !/^\d+$/.test(s)) {
                out.push("+0x" + off.toString(16) + "=" + s);
                if (out.length >= 6) break;
            }
        }
    } catch (e) {}
    return out.join(",");
}

var HOOKS = [
    [0x1f69c, "sel39Caller"],
    [0x241e4, "sel34Caller"],
    [0x24be4, "sel5Caller"],
    [0x36728, "sel20Caller"],
    [0x30f7c, "common30f7c"],
    [0x1b5c0, "common1b5c0"],
];
HOOKS.forEach(function (h) {
    var n = 0;
    try {
        Interceptor.attach(CONF.base.add(h[0]), {
            onEnter: function () {
                if (++n > 12) return;
                var c = this.context;
                var bt = "";
                try { bt = Thread.backtrace(this.context, Backtracer.ACCURATE).slice(0, 22).map(modOf).join(" <- "); } catch (e) { bt = "<no bt>"; }
                send({
                    type: "hit", hook: h[1], ts: Date.now(),
                    args: ["x0", "x1", "x2", "x3", "x4", "x5"].map(function (r) { return String(c[r]); }).join(" "),
                    strs: ["x0", "x1", "x2", "x3"].map(function (r) {
                        var s = tryStr(c[r]);
                        var deep = s ? "" : scanStr(c[r], 0x80);
                        return r + ":" + (s || deep || "-");
                    }).join(" | "),
                    bt: bt
                });
            }
        });
    } catch (e) { log("hook " + h[1] + " 失败: " + e); }
});
log("=== v26 就绪 ConfSDKdyn@" + CONF.base + " 请手动拨一次(响铃后挂断) ===");
