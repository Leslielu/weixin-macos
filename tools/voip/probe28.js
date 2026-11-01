// 探针 v28 — 取 ConfSDK 服务对象，挂其 vtable 全部方法，抓 wechat.dylib 侧调用栈
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
function inConf(p) {
    try { return p.compare(CONF.base) >= 0 && p.compare(CONF.base.add(CONF.size)) < 0; } catch (e) { return false; }
}

var getter = CONF.enumerateExports().filter(function (e) { return e.name === "GetWXConfService"; })[0];
if (!getter) throw new Error("no GetWXConfService");
var fn = new NativeFunction(getter.address, "pointer", ["int"]);
var svc = null;
try { svc = fn(0x1352707); } catch (e) { log("调 getter 失败: " + e); }
log("ConfSDK service = " + svc);
if (!svc || svc.isNull()) { log("服务对象为空，无法继续"); }
else {
    var vt = svc.readPointer();
    log("vtable = " + vt + " (" + modOf(vt) + ")");
    var hits = 0;
    for (var i = 0; i < 48; i++) {
        var fnp = null;
        try { fnp = vt.add(i * 8).readPointer(); } catch (e) { break; }
        if (!fnp || fnp.isNull() || !inConf(fnp)) continue;
        (function (idx, addr) {
            var n = 0;
            try {
                Interceptor.attach(addr, {
                    onEnter: function () {
                        if (++n > 3) return;
                        var c = this.context;
                        var bt = "";
                        try { bt = Thread.backtrace(this.context, Backtracer.ACCURATE).slice(0, 16).map(modOf).join(" <- "); }
                        catch (e) { bt = "<no bt>"; }
                        send({ type: "vt", idx: idx, addr: modOf(addr), ts: Date.now(),
                               args: ["x0", "x1", "x2", "x3", "x4"].map(function (r) { return String(c[r]); }).join(" "),
                               bt: bt });
                    }
                });
                hits++;
            } catch (e) { log("attach vt[" + idx + "] 失败: " + e); }
        })(i, fnp);
    }
    log("已挂 vtable 方法数 = " + hits);
}
log("=== v28 就绪 请点一次语音通话(响铃后挂断) ===");
