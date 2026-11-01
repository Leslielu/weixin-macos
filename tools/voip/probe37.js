// 探针 v37 — 音频链路对照: UI 拨号 vs 程序化拨号(vt[6]) 谁启动了本机音频引擎
// 背景: 11-01 用户实测 vt[6] 拨出能振铃+能接通, 但接通后双方无声音, 疑似本机
//       音频模块/采集从未启动。§5 的音频引擎 beacon 只在真实 UI 通话里验证过。
// 挂载:
//   wechat.dylib 音频引擎集群 0x5470644(引擎Start容器) / 0x5470688(Start)
//     0x547070c(Stop) / 0x54704e4(构造)  —— 全部打印调用方
//   0x1fc07f4  UI 拨号入口  —— 判本轮是不是 UI 发起的通话
//   0x1fcaf64  ConfSDK 信令分发器(只记 selector+长度)
//   ObjC AVAudioEngine -startAndReturnError:  —— 采集/播放会话启动及错误码(TCC 拒权会在这报)
// 触发文件(与 probe31/36 同): /tmp/voip_replay.req 拨出 + /tmp/voip_target.txt 被叫
//                            /tmp/voip_hangup.req 挂断
var REAL_MOD = Process.enumerateModules().filter(function (m) {
    return /wechat\.dylib/i.test(m.name) && m.size > 100 * 1024 * 1024;
})[0];
if (!REAL_MOD) throw new Error("wechat.dylib real image not found");
var BASE = REAL_MOD.base;

function log(s, extra) {
    var m = { type: "log", msg: s, ts: Date.now() };
    if (extra) for (var k in extra) m[k] = extra[k];
    send(m);
}
function hex2bytes(h) {
    var o = [];
    for (var i = 0; i < h.length; i += 2) o.push(parseInt(h.substr(i, 2), 16));
    return o;
}
function hexs(b) { return Array.from(b).map(function (x) { return ("0" + x.toString(16)).slice(-2); }).join(""); }
function modOf(addr) {
    var m = Process.findModuleByAddress(addr);
    return m ? m.name + "+0x" + addr.sub(m.base).toString(16) : String(addr);
}
function bt(ctx, n) {
    try { return Thread.backtrace(ctx, Backtracer.ACCURATE).slice(0, n || 6).map(modOf).join(" <- "); }
    catch (e) { return "<bt err " + e + ">"; }
}
function encVarint(n) {
    var out = [];
    while (true) { var b = n & 0x7f; n = Math.floor(n / 128); if (n) out.push(b | 0x80); else { out.push(b); return out; } }
}
function buildPb(wxid) {
    var w = [];
    for (var i = 0; i < wxid.length; i++) w.push(wxid.charCodeAt(i) & 0xff);
    var tail = [0x10, 0x02, 0x18, 0x00, 0x20, 0x04, 0x38, 0x00,
                0x42, 0x06, 0x77, 0x65, 0x63, 0x68, 0x61, 0x74,
                0x4a, 0x07, 0x76, 0x6f, 0x69, 0x70, 0x2d, 0x32, 0x70];
    return [0x0a].concat(encVarint(w.length), w, tail);
}
function readText(p) {
    try { var f = new File(p, "r"); var t = f.readText(); f.close(); return t; } catch (e) { return null; }
}

// ---------- 音频引擎集群 ----------
var AUDIO = { "0x5470644": "engineStart容器", "0x5470688": "engineStart",
              "0x547070c": "engineStop", "0x54704e4": "engineCtor" };
Object.keys(AUDIO).forEach(function (off) {
    Interceptor.attach(BASE.add(off), {
        onEnter: function () {
            send({ type: "audio", off: off, name: AUDIO[off], a0: String(this.context.x0),
                   a1: String(this.context.x1), a2: String(this.context.x2), ts: Date.now(),
                   bt: bt(this.context, 6) });
        }
    });
});

// ---------- 几个 Cluster 内部邻居, 帮助定位谁负责采集 ----------
["0x5470600", "0x54706c0", "0x5470f74"].forEach(function (off) {
    try {
        Interceptor.attach(BASE.add(off), {
            onEnter: function () {
                send({ type: "audio-nb", off: off, ts: Date.now(), bt: bt(this.context, 5) });
            }
        });
    } catch (e) { log("挂载邻居失败 " + off + ": " + e); }
});

// ---------- UI 拨号入口 ----------
Interceptor.attach(BASE.add("0x1fc07f4"), {
    onEnter: function () {
        var c = this.context;
        var callee = null;
        try { callee = c.x1.readUtf8String(); } catch (e) {}
        send({ type: "uidial", callee: callee, ts: Date.now(), bt: bt(c, 5) });
    }
});

// ---------- ConfSDK 信令分发(轻量) ----------
Interceptor.attach(BASE.add("0x1fcaf64"), {
    onEnter: function () {
        var c = this.context;
        send({ type: "sel", sel: c.x1.toUInt32(), len: c.x4.toUInt32(), ts: Date.now() });
    }
});

// ---------- AVAudioEngine 启动结果 ----------
try {
    var AE = ObjC.classes.AVAudioEngine;
    if (AE) {
        Interceptor.attach(AE["- startAndReturnError:"].implementation, {
            onEnter: function () { this.selfObj = new ObjC.Object(this.context.x0); },
            onLeave: function (retval) {
                var err = "<无>";
                try {
                    // arm64: x0=self x1=_cmd x2=NSError** ; 失败时 *x2 才是错误对象
                    var pp = this.context.x2;
                    if (pp && !pp.isNull()) {
                        var ep = pp.readPointer();
                        if (ep && !ep.isNull()) { err = new ObjC.Object(ep).description().toString(); }
                    }
                } catch (e) { err = "<读错误对象失败 " + e + ">"; }
                send({ type: "avaudio", cls: String(this.selfObj.$className),
                       ret: retval.toInt32(), err: err, ts: Date.now() });
            }
        });
        log("已挂 AVAudioEngine -startAndReturnError:");
    } else {
        log("ObjC 里没有 AVAudioEngine 类");
    }
} catch (e) { log("挂 AVAudioEngine 失败: " + e); }

// ---------- 程序化拨号/挂断 ----------
var CONF = Process.enumerateModules().filter(function (m) {
    return m.name.indexOf("ConfSDKdyn") !== -1 && m.size > 100 * 1024;
})[0];
var svc = null, startFn = null, endFn = null;
if (CONF) {
    try {
        var getter = CONF.enumerateExports().filter(function (e) { return e.name === "GetWXConfService"; })[0];
        svc = new NativeFunction(getter.address, "pointer", ["int"])(0x1352707);
        var vt = svc.readPointer();
        startFn = vt.add(6 * 8).readPointer();
        endFn = vt.add(12 * 8).readPointer();
        log("svc=" + svc + " vt[6]=" + modOf(startFn) + " vt[12]=" + modOf(endFn));
    } catch (e) { log("取服务失败: " + e); }
} else { log("ConfSDKdyn 未加载"); }

var lastDial = null, lastHang = null;
setInterval(function () {
    var tag = readText("/tmp/voip_replay.req");
    if (tag && (tag = tag.trim()) && tag !== lastDial) {
        lastDial = tag;
        var wxid = (readText("/tmp/voip_target.txt") || "").trim();
        if (!wxid || !svc || svc.isNull() || !startFn) { send({ type: "skip", reason: "no target/svc" }); return; }
        var pb = buildPb(wxid), mem = Memory.alloc(pb.length);
        mem.writeByteArray(pb);
        var r = null, err = null;
        try { r = new NativeFunction(startFn, "int", ["pointer", "pointer", "int"])(svc, mem, pb.length); }
        catch (e) { err = String(e); }
        send({ type: "dial", wxid: wxid, pb: hexs(pb), ret: r, err: err, ts: Date.now() });
    }
    var h = readText("/tmp/voip_hangup.req");
    if (h && (h = h.trim()) && h !== lastHang) {
        lastHang = h;
        if (!svc || svc.isNull() || !endFn) { send({ type: "skip", reason: "no svc" }); return; }
        var r2 = null, e2 = null;
        try { r2 = new NativeFunction(endFn, "int", ["pointer", "int", "int"])(svc, 1, 0); }
        catch (e) { e2 = String(e); }
        send({ type: "hangup", ret: r2, err: e2, ts: Date.now() });
    }
}, 800);

log("=== v37 就绪: 现在请在微信 UI 里手动拨一次语音通话(响铃后直接挂断也行) ===");
