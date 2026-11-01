// 探针 v47 — 挂钩 vt[18]/vt[19], 观察微信自己如何调用(参数语义 + 返回)
// 不主动调用, 零副作用; 通话中若有内部调用即可拿到真实参数表。
var CONF = Process.enumerateModules().filter(function (m) {
    return m.name.indexOf("ConfSDKdyn") !== -1 && m.size > 100 * 1024;
})[0];
if (!CONF) throw new Error("ConfSDKdyn not found");
var getter = CONF.enumerateExports().filter(function (e) {
    return e.name === "GetWXConfService";
})[0];
var svc = new NativeFunction(getter.address, "pointer", ["int"])(0x1352707);
var vt = svc.readPointer();

function hexs(p, n) {
    try {
        var b = new Uint8Array(p.readByteArray(n));
        var s = "";
        for (var i = 0; i < b.length; i++) s += ("0" + b[i].toString(16)).slice(-2);
        return s;
    } catch (e) { return "ERR:" + e; }
}
function nz(p, n) {
    try {
        var b = new Uint8Array(p.readByteArray(n));
        var c = 0, first = -1;
        for (var i = 0; i < b.length; i++) if (b[i] !== 0) { c++; if (first < 0) first = i; }
        return { nz: c, first: first };
    } catch (e) { return { err: String(e) }; }
}

[18, 19].forEach(function (slot) {
    var fn = vt.add(slot * 8).readPointer();
    Interceptor.attach(fn, {
        onEnter: function (args) {
            var c = this.context;
            this.slot = slot;
            this.a1 = c.x1; this.a2 = c.x2;
            this.a3 = c.x3; this.a4 = c.x4;
            this.a5 = c.x5; this.a6 = c.x6;
            this.a7 = c.x7;
            this.sp0 = c.sp.readPointer();     // 第 9 个参数
            this.sp8 = c.sp.add(8).readPointer();
            this.sp16 = c.sp.add(0x10).readPointer();
            send({ type: "callEnter", slot: slot, ret: null,
                   args: [String(this.a1), String(this.a2), String(this.a3), String(this.a4),
                          String(this.a5), String(this.a6), String(this.a7),
                          String(this.sp0), String(this.sp8), String(this.sp16)],
                   a2i: c.x2.toInt32(), a4i: c.x4.toInt32(), a5i: c.x5.toInt32(),
                   a6i: c.x6.toInt32(), a7i: c.x7.toInt32(),
                   a1hex: this.a1.compare(ptr(0x1000)) > 0 ? hexs(this.a1, 32) : null,
                   ts: Date.now() });
        },
        onLeave: function (retval) {
            var info = null;
            try {
                if (this.slot === 18 && !this.a1.isNull())
                    info = nz(this.a1, Math.min(this.a2.toInt32() > 0 ? this.a2.toInt32() : 64, 4096));
            } catch (e) {}
            send({ type: "callLeave", slot: this.slot, ret: String(retval),
                   a1nz: info, ts: Date.now() });
        }
    });
    send({ type: "log", msg: "hooked vt[" + slot + "]", addr: String(fn), ts: Date.now() });
});
send({ type: "log", msg: "v47 ready", svc: String(svc), vt: String(vt), ts: Date.now() });
