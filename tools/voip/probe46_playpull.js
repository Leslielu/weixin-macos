// 探针 v46 — 验证 vt[18] GetExternalHybridPlayData 能否拉出下行 PCM
//
// 静态结论(ConfSDKdyn 0x65e20):
//   int vt18(this, buf, len, arg3, channels, rate, a6, a7, a8)
//   - this+0x2c <= 0  → 0xfff9cfe3 (-405533) 未接通
//   - channels==2 走立体声路径; 否则把 arg3 拿到 this+0x3f8 白名单里查找,
//     查不到 → 0xfff9d005 (-405499)
//   - 立体声路径内部调用 impl->vt[0x308](buf, len, a7, &outUsed, -1, channels, rate, ...)
//
// 用法:
//   /tmp/voip_playpull.req  写新内容 = 开始拉流 (通话中)
//   /tmp/voip_playstop.req  写新内容 = 停止
//   输出: /tmp/play_pull_<ts>.pcm  (原始字节, 便于离线分析)
//   日志事件: pullStart / pull / pullStats / pullStop
var CONF = Process.enumerateModules().filter(function (m) {
    return m.name.indexOf("ConfSDKdyn") !== -1 && m.size > 100 * 1024;
})[0];
if (!CONF) throw new Error("ConfSDKdyn not found");

var getter = CONF.enumerateExports().filter(function (e) {
    return e.name === "GetWXConfService";
})[0];
if (!getter) throw new Error("GetWXConfService not found");

var svc = new NativeFunction(getter.address, "pointer", ["int"])(0x1352707);
if (svc.isNull()) throw new Error("svc null");
var vt = svc.readPointer();

var putExternal = CONF.base.add("0x7a370");
var hybridPlay = CONF.base.add("0x7a388");

var playFn = new NativeFunction(hybridPlay, "int",
    ["pointer", "pointer", "int", "int", "int", "int", "int", "int", "int"]);

function hexs(b) {
    return Array.from(new Uint8Array(b)).map(function (x) {
        return ("0" + x.toString(16)).slice(-2);
    }).join("");
}
function readText(p) {
    try { var f = new File(p, "r"); var t = f.readText(); f.close(); return t; } catch (e) { return null; }
}

var BUF_LEN = 8192;
var buf = Memory.alloc(BUF_LEN);
var zero = new Uint8Array(BUF_LEN);
buf.writeByteArray(zero);

var pulling = false, timer = null, calls = 0, okCalls = 0, okBytes = 0;
var outFile = null, outPath = null, firstHex = null, retHist = {};

function stopPull(reason) {
    if (!pulling) return;
    pulling = false;
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (outFile !== null) { try { outFile.close(); } catch (e) {} outFile = null; }
    send({ type: "pullStop", reason: reason, calls: calls, okCalls: okCalls,
           okBytes: okBytes, path: outPath, retHist: retHist, ts: Date.now() });
}

function tick(rate, channels, arg3) {
    if (!pulling) return;
    buf.writeByteArray(zero);
    var ret = null, err = null, used = -1;
    try { ret = playFn(svc, buf, BUF_LEN, arg3, channels, rate, 0, 0, 0); }
    catch (e) { err = String(e); }
    calls++;
    retHist[String(ret)] = (retHist[String(ret)] || 0) + 1;

    // 无 out 指针可用: 用"非零扫描"估计写入量, 并记录首批内容
    var written = 0, firstNZ = -1;
    if (err === null && ret === 0) {
        var b = new Uint8Array(buf.readByteArray(BUF_LEN));
        for (var i = 0; i < b.length; i++) {
            if (b[i] !== 0) { written++; if (firstNZ < 0) firstNZ = i; }
        }
        if (written > 0) {
            okCalls++;
            okBytes += written;
            if (firstHex === null) firstHex = hexs(buf.readByteArray(Math.min(64, BUF_LEN)));
            if (outFile !== null) {
                try { outFile.write(b); } catch (e) {}
            }
        }
    }
    if (calls <= 3 || calls % 50 === 0 || err !== null) {
        send({ type: "pull", n: calls, ret: ret, err: err, written: written,
               firstNZ: firstNZ, rate: rate, channels: channels, arg3: arg3, ts: Date.now() });
    }
    if (err !== null) { stopPull("exception"); return; }
    timer = setTimeout(function () { tick(rate, channels, arg3); }, 20);
}

function startPull(tag) {
    if (pulling) { send({ type: "skip", reason: "already pulling", ts: Date.now() }); return; }
    var rate = 24000, channels = 2, arg3 = 0;
    var cfg = (readText("/tmp/voip_playpull.cfg") || "").trim();   // "rate,channels,arg3"
    if (cfg) {
        var parts = cfg.split(",");
        if (parts.length >= 2) { rate = parseInt(parts[0], 10) || 24000; channels = parseInt(parts[1], 10) || 2; }
        if (parts.length >= 3) arg3 = parseInt(parts[2], 10) || 0;
    }
    calls = 0; okCalls = 0; okBytes = 0; retHist = {}; firstHex = null;
    outPath = "/tmp/play_pull_" + Date.now() + ".pcm";
    try { outFile = new File(outPath, "wb"); } catch (e) { outFile = null; }
    pulling = true;
    var info = null;
    try {
        info = { startTalkFlag: svc.add(0x2c).readU32(), impl: String(svc.add(8).readPointer()) };
    } catch (e) { info = { error: String(e) }; }
    send({ type: "pullStart", tag: tag, path: outPath, bufLen: BUF_LEN,
           rate: rate, channels: channels, arg3: arg3, info: info,
           hybridPlay: String(hybridPlay), putExternal: String(putExternal), ts: Date.now() });
    tick(rate, channels, arg3);
}

// 自检: 不打电话时调一次, 确认错误码与静态分析一致(应为 -405533)
send({ type: "selfCheck", ret: (function () {
    try { return String(playFn(svc, buf, BUF_LEN, 0, 2, 24000, 0, 0, 0)); }
    catch (e) { return "err:" + e; }
})(), startTalkFlag: (function () {
    try { return svc.add(0x2c).readU32(); } catch (e) { return "err"; }
})(), svc: String(svc), vt: String(vt), ts: Date.now() });

var lastStart = (readText("/tmp/voip_playpull.req") || "").trim();
var lastStop = (readText("/tmp/voip_playstop.req") || "").trim();
setInterval(function () {
    var s = readText("/tmp/voip_playpull.req");
    if (s && (s = s.trim()) && s !== lastStart) { lastStart = s; startPull(s); }
    var t = readText("/tmp/voip_playstop.req");
    if (t && (t = t.trim()) && t !== lastStop) { lastStop = t; stopPull("req:" + t); }
}, 300);

send({ type: "log", msg: "v46 ready", svc: String(svc), vt: String(vt),
       hybridPlay: String(hybridPlay), ts: Date.now() });
