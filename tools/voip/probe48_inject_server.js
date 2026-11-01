// 探针 v48 — 被叫侧: 自动接听 + 触发式 PCM 注入(与 probe43 同配方)
// 部署: mac-m1 (生产微信 4.1.13.63, gadget 127.0.0.1:27042)
// 用途: 让 m1 作为音源向主叫播放已知测试音, 主叫侧用系统音频捕获(ScreenCaptureKit)
//       客观录音, 端到端验证注入配方是否干净(无需 m1 的麦克风/屏幕录制 TCC)。
//
// 触发文件(边沿触发, 内容变化才执行):
//   /tmp/inject.req     写新内容 = 开始注入 /tmp/inject.pcm (16k mono s16le)
//   /tmp/inject_stop.req 写新内容 = 停止注入
//   /tmp/hangup.req     写新内容 = 挂断
// 事件: incoming / answered / pcm / pcmGo / pcmStop / hangup / log
var CONF = Process.enumerateModules().filter(function (m) {
    return m.name.indexOf("ConfSDKdyn") !== -1 && m.size > 100 * 1024;
})[0];
if (!CONF) throw new Error("ConfSDKdyn not found");
var getter = CONF.enumerateExports().filter(function (e) {
    return e.name === "GetWXConfService";
})[0];
var svc = new NativeFunction(getter.address, "pointer", ["int"])(0x1352707);
var vt = svc.readPointer();

function hexs(b) { return Array.from(b).map(function (x) { return ("0" + x.toString(16)).slice(-2); }).join(""); }
function log(msg, extra) {
    var o = { type: "log", msg: msg, ts: Date.now() };
    if (extra) for (var k in extra) o[k] = extra[k];
    send(o);
}
function readText(p) { try { var f = new File(p, "r"); var t = f.readText(); f.close(); return t; } catch (e) { return null; } }

var answerFn = new NativeFunction(vt.add(10 * 8).readPointer(), "int",
    ["pointer", "int", "int", "int"]);
var hangupFn = new NativeFunction(vt.add(12 * 8).readPointer(), "int",
    ["pointer", "int", "int"]);
var putExternal = new NativeFunction(CONF.base.add("0x7a370"), "int",
    ["pointer", "pointer", "int", "int", "int"]);
var muteMicFn = new NativeFunction(CONF.base.add("0x662e0"), "int", ["pointer", "int"]);

function confEngine() { return svc.add(8).readPointer().add(0xa10); }
function muteMic(on) {
    try { return muteMicFn(confEngine(), on ? 1 : 0); } catch (e) { return "err:" + e; }
}

// ---------- 来话 → 自动接听 ----------
Interceptor.attach(vt.add(7 * 8).readPointer(), {
    onEnter: function (args) {
        var room = "";
        try { room = hexs(new Uint8Array(args[1].readByteArray(48))); } catch (e) {}
        send({ type: "incoming", room: room, ts: Date.now() });
        setTimeout(function () {
            var r = null;
            try { r = answerFn(svc, 1, 0, 0x22); } catch (e) { r = "err:" + e; }
            send({ type: "answered", ret: String(r), ts: Date.now() });
        }, 1500);
    }
});

// ---------- PCM 注入 ----------
var frameMs = 20, frameBytes = 960, payloadBytes = 640, rate = 24000, contentRate = 16000;
var frame = Memory.alloc(8192);
var KEEP = [frame];
frame.writeByteArray(new Uint8Array(8192));

// 可选格式覆盖: /tmp/inject.cfg 内容 "rate,payloadBytes,frameBytes,channels[,frameMs]"
// (默认终版标定 24000/640/960/1/20)。用于 A/B 采样率、帧长与推送节拍假设。
function loadCfg() {
    var t = (readText("/tmp/inject.cfg") || "").trim();
    var o = { rate: 24000, payloadBytes: 640, frameBytes: 960, channels: 1, frameMs: 20, mute: 1 };
    if (!t) return o;
    var p = t.split(",");
    if (p.length >= 6 && p[5] !== "") o.mute = parseInt(p[5], 10);  // 0 = 不静音麦克风
    if (p.length >= 1 && p[0]) o.rate = parseInt(p[0], 10) || o.rate;
    if (p.length >= 2 && p[1]) o.payloadBytes = parseInt(p[1], 10) || o.payloadBytes;
    if (p.length >= 3 && p[2]) o.frameBytes = parseInt(p[2], 10) || o.frameBytes;
    if (p.length >= 4 && p[3]) o.channels = parseInt(p[3], 10) || o.channels;
    if (p.length >= 5 && p[4]) o.frameMs = parseInt(p[4], 10) || o.frameMs;
    return o;
}

var pcm = null, pcmOff = 0, pcmCalls = 0, streamTimer = null, running = false, t0 = 0, idx = 0;
var cfg = loadCfg();
var lastRet = null, negativeRets = 0, maxLate = 0, lateCnt3 = 0;

function loadPcm() {
    try {
        var f = new File("/tmp/inject.pcm", "rb");
        var b = new Uint8Array(f.readBytes());   // readBytes 是 ArrayBuffer, 必须包一层
        f.close();
        return b;
    } catch (e) { return null; }
}

function stopPcm(reason) {
    if (!running) return;
    running = false;
    if (streamTimer !== null) { clearTimeout(streamTimer); streamTimer = null; }
    if (cfg.mute !== 0) muteMic(false);
    send({ type: "pcmStop", reason: reason, calls: pcmCalls, bytes: pcmOff,
           lastRet: lastRet, maxLateMs: maxLate, lateOver3ms: lateCnt3, ts: Date.now() });
}

function tick() {
    if (!running) return;
    if (pcm === null || pcmOff + payloadBytes > pcm.byteLength) { stopPcm("eof"); return; }
    for (var i = 0; i < payloadBytes; i++) frame.add(i).writeU8(pcm[pcmOff + i]);
    var ret = null, err = null;
    try { ret = putExternal(svc, frame, frameBytes, rate, cfg.channels || 1); }
    catch (e) { err = String(e); }
    pcmOff += payloadBytes;
    pcmCalls++;
    negativeRets = (ret !== null && ret < 0) ? negativeRets + 1 : 0;
    var late = Date.now() - (t0 + (idx + 1) * frameMs);
    if (late > maxLate) maxLate = late;
    if (late > 3) lateCnt3++;
    if (pcmCalls <= 5 || pcmCalls % 50 === 0 || ret !== lastRet || err !== null)
        send({ type: "pcm", n: pcmCalls, bytes: pcmOff, ret: ret, err: err, lateMs: late, ts: Date.now() });
    lastRet = ret;
    idx++;
    if (err !== null) { stopPcm("exception"); return; }
    if (negativeRets >= 20) { stopPcm("20 negative returns"); return; }
    var deadline = t0 + idx * frameMs;
    var d = deadline - Date.now();
    if (d > 6) { streamTimer = setTimeout(tick, d - 5); return; }
    while (Date.now() < deadline) { }
    streamTimer = setTimeout(tick, 0);
}

function startPcm(tag) {
    if (running) { send({ type: "skip", reason: "already running", ts: Date.now() }); return; }
    pcm = loadPcm();
    if (pcm === null) { send({ type: "skip", reason: "no /tmp/inject.pcm", ts: Date.now() }); return; }
    cfg = loadCfg();
    rate = cfg.rate; payloadBytes = cfg.payloadBytes; frameBytes = cfg.frameBytes;
    frameMs = cfg.frameMs || 20;
    pcmOff = 0; pcmCalls = 0; idx = 0; negativeRets = 0; maxLate = 0; lateCnt3 = 0; lastRet = null;
    var muteRes = (cfg.mute === 0) ? "skipped" : String(muteMic(true));
    send({ type: "pcmGo", tag: tag, bytes: pcm.byteLength, cfg: cfg,
           mute: muteRes, ts: Date.now() });
    running = true;
    t0 = Date.now();
    tick();
}

// ---------- 触发 ----------
var lastInject = (readText("/tmp/inject.req") || "").trim();
var lastStop = (readText("/tmp/inject_stop.req") || "").trim();
var lastHang = (readText("/tmp/hangup.req") || "").trim();
setInterval(function () {
    var s = readText("/tmp/inject.req");
    if (s && (s = s.trim()) && s !== lastInject) { lastInject = s; startPcm(s); }
    var t = readText("/tmp/inject_stop.req");
    if (t && (t = t.trim()) && t !== lastStop) { lastStop = t; stopPcm("req:" + t); }
    var h = readText("/tmp/hangup.req");
    if (h && (h = h.trim()) && h !== lastHang) {
        lastHang = h;
        stopPcm("hangup");
        var r = null, e = null;
        try { r = hangupFn(svc, 1, 0); } catch (ex) { e = String(ex); }
        send({ type: "hangup", ret: r, err: e, ts: Date.now() });
    }
}, 300);

log("v48 inject-server ready svc=" + svc + " vt=" + vt +
    " putExternal=" + CONF.base.add("0x7a370"));
