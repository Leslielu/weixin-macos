// 探针 v63 — 只调用不挂钩: 带「预灌缓冲(priming)」的 PCM 注入器
// 可与 probe48 并存(probe48 负责接听, 本探针只做注入, 互不干扰)。
//
// 动机: 引擎每回调用固定字节数取数, 我们 20ms 一推, 两边节拍对不齐就周期性断供
//       → 每 26ms 左右出现 15ms 真空隙。先塞 N 帧垫底, 让引擎永远有存货。
//
// 触发文件(边沿触发):
//   /tmp/p.req   写新内容 = 开始注入 /tmp/inject.pcm
//   /tmp/p.stop  写新内容 = 停止
// 配置 /tmp/p.cfg: "rate,payloadBytes,frameBytes,channels,frameMs,mute,primeFrames[,leadMs]"
//   默认 16000,640,640,1,20,1,0,0
//   primeFrames: 起步瞬间连发多少帧(每帧 payloadBytes 字节内容)
//   leadMs:      稳态下额外提前多少毫秒(相对墙面时钟)
var CONF = Process.enumerateModules().filter(function (m) {
    return m.name.indexOf("ConfSDKdyn") !== -1 && m.size > 100 * 1024;
})[0];
if (!CONF) throw new Error("ConfSDKdyn not found");
var getter = CONF.enumerateExports().filter(function (e) { return e.name === "GetWXConfService"; })[0];
var svc = new NativeFunction(getter.address, "pointer", ["int"])(0x1352707);
var putExternal = new NativeFunction(CONF.base.add("0x7a370"), "int",
    ["pointer", "pointer", "int", "int", "int"]);
var muteMicFn = new NativeFunction(CONF.base.add("0x662e0"), "int", ["pointer", "int"]);
function confEngine() { return svc.add(8).readPointer().add(0xa10); }
function muteMic(on) {
    try { return muteMicFn(confEngine(), on ? 1 : 0); } catch (e) { return "err:" + e; }
}
function readText(p) { try { var f = new File(p, "r"); var t = f.readText(); f.close(); return t; } catch (e) { return null; } }

var frame = Memory.alloc(8192);
var KEEP = [frame];
frame.writeByteArray(new Uint8Array(8192));

function loadCfg() {
    var t = (readText("/tmp/p.cfg") || "").trim();
    var o = { rate: 16000, payloadBytes: 640, frameBytes: 640, channels: 1, frameMs: 20,
              mute: 1, primeFrames: 0, leadMs: 0 };
    if (!t) return o;
    var p = t.split(",");
    var keys = ["rate", "payloadBytes", "frameBytes", "channels", "frameMs", "mute", "primeFrames", "leadMs"];
    for (var i = 0; i < p.length && i < keys.length; i++) {
        if (p[i] !== "") { var v = parseInt(p[i], 10); if (!isNaN(v)) o[keys[i]] = v; }
    }
    return o;
}
function loadPcm() {
    try { var f = new File("/tmp/inject.pcm", "rb"); var b = new Uint8Array(f.readBytes()); f.close(); return b; }
    catch (e) { return null; }
}

var cfg, pcm = null, pcmOff = 0, pcmCalls = 0, timer = null, running = false, t0 = 0, idx = 0;
var lastRet = null, neg = 0, maxLate = 0, late3 = 0, primed = 0;

function stop(reason) {
    if (!running) return;
    running = false;
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (cfg.mute !== 0) muteMic(false);
    send({ type: "pStop", reason: reason, calls: pcmCalls, bytes: pcmOff, primed: primed,
           lastRet: lastRet, maxLateMs: maxLate, lateOver3ms: late3, ts: Date.now() });
}

function pushOne() {
    // 写一帧内容并推送, 返回 false = 数据放完
    if (pcm === null || pcmOff + cfg.payloadBytes > pcm.byteLength) return false;
    for (var i = 0; i < cfg.payloadBytes; i++) frame.add(i).writeU8(pcm[pcmOff + i]);
    var ret = null, err = null;
    try { ret = putExternal(svc, frame, cfg.frameBytes, cfg.rate, cfg.channels || 1); }
    catch (e) { err = String(e); }
    pcmOff += cfg.payloadBytes;
    pcmCalls++;
    neg = (ret !== null && ret < 0) ? neg + 1 : 0;
    if (pcmCalls <= 5 || pcmCalls % 50 === 0 || ret !== lastRet || err !== null)
        send({ type: "p", n: pcmCalls, bytes: pcmOff, ret: ret, err: err,
               lateMs: Date.now() - (t0 + idx * cfg.frameMs + (cfg.primeFrames || 0) * 0), ts: Date.now() });
    lastRet = ret;
    if (err !== null) { stop("exception:" + err); return false; }
    if (neg >= 20) { stop("20 negative returns"); return false; }
    return true;
}

function tick() {
    if (!running) return;
    if (!pushOne()) { if (running) stop("eof"); return; }
    idx++;
    var deadline = t0 + idx * cfg.frameMs - (cfg.leadMs || 0);
    var d = deadline - Date.now();
    var late = -d; if (late > maxLate) maxLate = late; if (late > 3) late3++;
    if (d > 6) { timer = setTimeout(tick, d - 5); return; }
    while (Date.now() < deadline) { }
    timer = setTimeout(tick, 0);
}

function start(tag) {
    if (running) { send({ type: "skip", reason: "already running" }); return; }
    pcm = loadPcm();
    if (pcm === null) { send({ type: "skip", reason: "no /tmp/inject.pcm" }); return; }
    cfg = loadCfg();
    pcmOff = 0; pcmCalls = 0; idx = 0; neg = 0; maxLate = 0; late3 = 0; lastRet = null; primed = 0;
    var m = (cfg.mute === 0) ? "skipped" : String(muteMic(true));
    send({ type: "pGo", tag: tag, bytes: pcm.byteLength, cfg: cfg, mute: m, ts: Date.now() });
    running = true;
    // 预灌: 连发 primeFrames 帧(这些内容随后不再重复推送)
    while (running && primed < (cfg.primeFrames || 0)) {
        if (!pushOne()) { stop("eof during prime"); return; }
        primed++; idx++;
    }
    t0 = Date.now();
    idx = 0;
    tick();
}

var lastReq = (readText("/tmp/p.req") || "").trim();
var lastStop = (readText("/tmp/p.stop") || "").trim();
setInterval(function () {
    var s = readText("/tmp/p.req");
    if (s && (s = s.trim()) && s !== lastReq) { lastReq = s; start(s); }
    var t = readText("/tmp/p.stop");
    if (t && (t = t.trim()) && t !== lastStop) { lastStop = t; stop("req:" + t); }
}, 300);

send({ type: "ready", svc: svc.toString(), put: CONF.base.add("0x7a370").toString() });
