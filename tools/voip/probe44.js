// 探针 v44 — svc vtable 全 48 槽监视: 用一次人工接听识别「接听」槽位与参数
// 挂载: [svc] vtable 全部槽位 + 0x1fcaf64 信令分发(上下文)
// 用法: 手机拨打本机微信 → 来铃后在本机 UI 点「接听」→ 看 vt 槽位日志
var REAL_MOD = Process.enumerateModules().filter(function (m) {
    return /wechat\.dylib/i.test(m.name) && m.size > 100 * 1024 * 1024;
})[0];
if (!REAL_MOD) throw new Error("wechat.dylib not found");
var CONF = Process.enumerateModules().filter(function (m) {
    return m.name.indexOf("ConfSDKdyn") !== -1 && m.size > 100 * 1024;
})[0];
if (!CONF) throw new Error("ConfSDKdyn not found");
var getter = CONF.enumerateExports().filter(function (e) { return e.name === "GetWXConfService"; })[0];
var svc = new NativeFunction(getter.address, "pointer", ["int"])(0x1352707);
var vt = svc.readPointer();

function hexs(b) { return Array.from(b).map(function (x) { return ("0" + x.toString(16)).slice(-2); }).join(""); }

var counts = {};
for (var i = 0; i < 48; i++) {
    (function (idx) {
        var addr = vt.add(idx * 8).readPointer();
        Interceptor.attach(addr, {
            onEnter: function (args) {
                counts[idx] = (counts[idx] || 0) + 1;
                if (counts[idx] > 8) return;
                var e = { type: "vt", slot: idx, n: counts[idx], ts: Date.now(),
                          a0: String(args[0]), a1: String(args[1]),
                          a2: String(args[2]), a3: String(args[3]) };
                send(e);
                try {
                    var b = args[1].readByteArray(64);
                    send({ type: "vtb", slot: idx, n: counts[idx], hex: hexs(new Uint8Array(b)), ts: Date.now() });
                } catch (err) {}
            }
        });
    })(i);
}

Interceptor.attach(REAL_MOD.base.add("0x1fcaf64"), {
    onEnter: function () {
        send({ type: "sel", sel: this.context.x1.toUInt32(), len: this.context.x4.toUInt32(), ts: Date.now() });
    }
});

send({ type: "log", msg: "v44 ready svc=" + svc + " vt=" + vt + " — 请来电并在 Mac UI 点接听", ts: Date.now() });
