// 探针 v43 — 原生客户端拨号 + ConfSDK 外部 PCM 注入(只做出站语音)
//
// 新入口(全部在 ConfSDKdyn, 不碰 wechat.dylib 的 PAC 音频禁区):
//   PutExternalRecordData public wrapper = ConfSDKdyn+0x7a370
//     wrapper(svc, pcm, len, sampleRate, channels)
//     -> [svc+8] -> ConfEngine(+0xa10)->[+8]=MVQQ engine, vt[+0x300]
//   MVQQ 实现层(0x1f8018, 经 thunk 0x1f9618 this-8)按自身格式取数:
//     w24 = [this+0x234](frameMs) * [this+0x254](bytesPerSample)
//           * [this+0x258](rate) / 1000
//   ⇒ 我们喂的帧必须等于 w24, 否则它按 w24 memcpy 会越界读 → 杂音。
//
// 流程(一通电话完成):
//   1. 接通(首个 SEL29) → 只上报 mediaReady(引擎真实格式), 不出声
//   2. 写 /tmp/voip_pcm.req 新内容 → 按 w24 重采样/整形后注入 10s 测试语音
//   3. 写 /tmp/voip_hangup.req → 挂断
// 推送节奏: 绝对时间线(t0 + n*frameMs), 修掉 setInterval 的系统性 6.5% 欠速。
//
// 文件:
//   /tmp/voip_uidial.req   写新内容 = 原生客户端拨号
//   /tmp/voip_pcm.req      写新内容 = 开始注入(通话中)
//   /tmp/voip_hangup.req   写新内容 = 挂断
//   /tmp/voip_target.txt   被叫 wxid
//   /tmp/voip_voice_16k_s16le.pcm  16k/mono/s16le 原始 PCM
//
// 安全: 不挂 0x546a558/0x5470f7c/0x54704e4/0x5470644/0x5470688;
//       所有 Frida 分配均 KEEP 保活; 加载时已有 trigger 不会自动执行。
var REAL_MOD = Process.enumerateModules().filter(function (m) {
    return /wechat\.dylib/i.test(m.name) && m.size > 100 * 1024 * 1024;
})[0];
if (!REAL_MOD) throw new Error("wechat.dylib real image not found");
var BASE = REAL_MOD.base;
var CLIENT = BASE.add("0x9b93ab8");
var KEEP = [];

function log(s, extra) {
    var m = { type: "log", msg: s, ts: Date.now() };
    if (extra) for (var k in extra) m[k] = extra[k];
    send(m);
}
function hexs(b) {
    return Array.from(b).map(function (x) { return ("0" + x.toString(16)).slice(-2); }).join("");
}
function readText(p) {
    try { var f = new File(p, "r"); var t = f.readText(); f.close(); return t; } catch (e) { return null; }
}
function readCStr(p) { try { return p.readUtf8String(); } catch (e) { return null; } }
function strBytes(st) {
    try {
        var isLong = (st.add(0x17).readU8() & 0x80) !== 0;
        var p = isLong ? st.readPointer() : st;
        var n = isLong ? st.add(8).readU64().toNumber() : st.add(0x17).readU8();
        if (n < 0 || n > 4096) return null;
        return new Uint8Array(p.readByteArray(n));
    } catch (e) { return null; }
}
function strAt(st) {
    var b = strBytes(st);
    if (b === null) return null;
    var s = "";
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return s;
}
function raw(p, n) {
    try { return hexs(new Uint8Array(p.readByteArray(n))); } catch (e) { return null; }
}
function vecInfo(vp) {
    try {
        var beg = vp.readPointer(), end = vp.add(8).readPointer();
        var n = end.sub(beg).toInt32() / 24;
        var out = [];
        for (var i = 0; i < Math.min(n, 8); i++) {
            var st = beg.add(i * 24);
            out.push({ text: strAt(st), raw24: raw(st, 24) });
        }
        return { n: n, items: out };
    } catch (e) { return { error: String(e) }; }
}
function buildVec(wxid) {
    var sb = Memory.alloc(24);
    KEEP.push(sb);
    var bytes = new Array(24);
    for (var i = 0; i < 24; i++) bytes[i] = 0;
    if (wxid.length <= 22) {
        for (i = 0; i < wxid.length; i++) bytes[i] = wxid.charCodeAt(i) & 0xff;
        bytes[0x17] = wxid.length;
    } else {
        var data = Memory.allocUtf8String(wxid);
        KEEP.push(data);
        sb.writePointer(data);
        sb.add(8).writeU64(wxid.length);
        sb.add(0x17).writeU8(0x80);
        var vecLong = Memory.alloc(24);
        KEEP.push(vecLong);
        vecLong.writePointer(sb);
        vecLong.add(8).writePointer(sb.add(24));
        vecLong.add(16).writePointer(sb.add(24));
        return vecLong;
    }
    sb.writeByteArray(bytes);
    var vec = Memory.alloc(24);
    KEEP.push(vec);
    vec.writePointer(sb);
    vec.add(8).writePointer(sb.add(24));
    vec.add(16).writePointer(sb.add(24));
    return vec;
}
function clientState() {
    try {
        return {
            obj: String(CLIENT), vt: String(CLIENT.readPointer()),
            svc: String(CLIENT.add(0x20).readPointer()),
            initialized: CLIENT.add(0x28).readU8(),
            flags140: CLIENT.add(0x140).readU32()
        };
    } catch (e) { return { error: String(e) }; }
}

log("BASE=" + BASE + " CLIENT=" + CLIENT, clientState());

Interceptor.attach(BASE.add("0x1fc07f4"), {
    onEnter: function () {
        var c = this.context;
        send({ type: "clientDialEnter", ts: Date.now(), callee: readCStr(c.x1),
               obj: String(c.x0), vec: String(c.x2), vecInfo: vecInfo(c.x2),
               x3: String(c.x3), x4: String(c.x4), x5: String(c.x5),
               client: clientState() });
    }
});
Interceptor.attach(BASE.add("0x5706804"), {
    onEnter: function () { this.out = this.context.x1; },
    onLeave: function () {
        var b = strBytes(this.out);
        if (!b || b.length > 2048) return;
        var h = hexs(b);
        if (h.indexOf("766f69702d3270") < 0 && h.indexOf("776563686174") < 0 && b.length !== 0) return;
        send({ type: "dialPb", len: b.length, hex: h, ts: Date.now() });
    }
});
Interceptor.attach(BASE.add("0x1fcaf64"), {
    onEnter: function () {
        var c = this.context;
        var sel = c.x1.toUInt32();
        send({ type: "sel", sel: sel, len: c.x4.toUInt32(), ts: Date.now() });
        if (sel === 29) send({ type: "mediaReady", engine: engineInfo(), ts: Date.now() });
        if (sel === 25 || sel === 26 || sel === 7) stopPcm("SEL" + sel);
    }
});
Interceptor.attach(BASE.add("0x434dc00"), {
    onEnter: function () {
        send({ type: "callState", state: this.context.x1.toUInt32(), ts: Date.now() });
    }
});

var dialFn = new NativeFunction(BASE.add("0x1fc07f4"), "int",
    ["pointer", "pointer", "pointer", "pointer", "int", "pointer"]);

// ---------- ConfSDK 外部采集 PCM 入口 ----------
var CONF = Process.enumerateModules().filter(function (m) {
    return m.name.indexOf("ConfSDKdyn") !== -1 && m.size > 100 * 1024;
})[0];
if (!CONF) throw new Error("ConfSDKdyn not found");
var getter = CONF.enumerateExports().filter(function (e) {
    return e.name === "GetWXConfService";
})[0];
if (!getter) throw new Error("GetWXConfService not found");
var svc = new NativeFunction(getter.address, "pointer", ["int"])(0x1352707);
var putExternal = new NativeFunction(CONF.base.add("0x7a370"), "int",
    ["pointer", "pointer", "int", "int", "int"]);
var hangupFn = new NativeFunction(svc.readPointer().add(12 * 8).readPointer(), "int",
    ["pointer", "int", "int"]);
// ConfEngine::MuteMicPhone(this, mute): 静音 SDK 内部采集(叠加噪声验证)
var muteMicFn = new NativeFunction(CONF.base.add("0x662e0"), "int", ["pointer", "int"]);

function modOf(addr) {
    var m = Process.findModuleByAddress(addr);
    return m ? m.name + "+0x" + addr.sub(m.base).toString(16) : String(addr);
}
function engineInfo() {
    try {
        var impl = svc.add(8).readPointer();
        var ce = impl.add(0xa10);
        var mv = ce.add(8).readPointer();
        var info = { pcmImpl: String(impl), confEngine: String(ce), mvqqEngine: String(mv),
                     startTalkFlag: ce.add(0x2c).readU32(),
                     recFormat: [0x528, 0x52c, 0x530, 0x534, 0x538].map(function (o) {
                         return ce.add(o).readU32();
                     }) };
        if (!mv.isNull()) {
            info.putExternalImpl = modOf(mv.readPointer().add(0x300).readPointer());
            var av = mv.sub(8); // thunk 0x1f9618 先 sub x0,#8
            info.mediaFormat = {
                frameMs: av.add(0x234).readU32(),
                recChannelsAp: av.add(0x23c).readU32(),
                recRateAp: av.add(0x240).readU32(),
                recRate: av.add(0x248).readU32(),
                recChannels: av.add(0x24c).readU32(),
                bytesPerSample: av.add(0x254).readU32(),
                recRate2: av.add(0x258).readU32(),
                playRate: av.add(0x25c).readU32(),
                playChannels: av.add(0x260).readU32(),
                externalMode: av.add(0x5418).readU8()
            };
        }
        return info;
    } catch (e) { return { error: String(e) }; }
}
// w24 复刻(实测字段值 frameMs=20, f1=48000, f2=1 → 960B/帧):
//   w24 = [mv-8+0x234] * [0x254] * [0x258] / 1000
// 声明采样率按 s16 mono 反推: rate = w24*1000/frameMs/2 (=24000)
function engineFrame() {
    try {
        var impl = svc.add(8).readPointer();
        var mv = impl.add(0xa10).add(8).readPointer();
        if (mv.isNull()) return null;
        var av = mv.sub(8);
        var frameMs = av.add(0x234).readU32();
        var f1 = av.add(0x254).readU32();
        var f2 = av.add(0x258).readU32();
        var w24 = Math.floor(frameMs * f1 * f2 / 1000);
        // 终版标定(2026-11-01, 录音测量 tempo=1.0000 + 耳测确认):
        //   帧结构 = 960B(640B 16k 内容载荷 + 320B 零尾), 20ms/帧, 声明 24000。
        //   引擎吃前 640B(320样本=20ms@16k)恰 1:1; 零尾被丢弃。
        //   24k 内容会每帧富余 160 样本→缓冲积压→周期性清空=滋滋杂音(已实测)。
        if (frameMs >= 10 && frameMs <= 60 && w24 >= 100 && w24 <= 4096)
            return { frameMs: 20, frameBytes: 960, payloadBytes: 640,
                     rate: 24000, contentRate: 16000, channels: 1,
                     raw: [frameMs, f1, f2, w24] };
    } catch (e) {}
    return null;
}

var pcmBuf = null;
try {
    var pf = new File("/tmp/voip_voice_16k_s16le.pcm", "rb");
    pcmBuf = pf.readBytes();
    pf.close();
} catch (e) {
    log("PCM 读取失败: " + e);
}

var streaming = false, pcmOff = 0, pcmCalls = 0;
var negativeRets = 0, lastRet = null, streamTimer = null;
var frame = null, playU8 = null, playMeta = null;
var maxLate = 0, lateCnt3 = 0;

function stopPcm(reason) {
    if (!streaming) return;
    streaming = false;
    if (streamTimer !== null) { clearTimeout(streamTimer); streamTimer = null; }
    send({ type: "pcmStop", reason: reason, calls: pcmCalls, bytes: pcmOff,
           lastRet: lastRet, maxLateMs: maxLate, lateOver3ms: lateCnt3, ts: Date.now() });
}
// 16k/mono s16 -> rate(/chn) 线性插值重采样
function resample16k(rate, chn) {
    var src = new Int16Array(pcmBuf);
    var n = Math.max(1, Math.floor(src.length * rate / 16000));
    var mono = new Int16Array(n);
    for (var i = 0; i < n; i++) {
        var t = i * 16000 / rate;
        var i0 = Math.floor(t);
        var frac = t - i0;
        var a = src[i0];
        var b = (i0 + 1 < src.length) ? src[i0 + 1] : a;
        var v = Math.round(a + (b - a) * frac);
        mono[i] = v < -32768 ? -32768 : (v > 32767 ? 32767 : v);
    }
    if (chn === 2) {
        var st = new Int16Array(n * 2);
        for (i = 0; i < n; i++) { st[2 * i] = mono[i]; st[2 * i + 1] = mono[i]; }
        return new Uint8Array(st.buffer);
    }
    return new Uint8Array(mono.buffer);
}
// 优先读 ffmpeg 预生成的带限重采样文件(线性插值有频谱镜像=滋滋噪声),
// 没有才退回 JS 线性插值。
function loadPreResampled(rate, chn) {
    try {
        var f = new File("/tmp/voip_voice_" + rate + "_s16le.pcm", "rb");
        var b = f.readBytes();
        f.close();
        log("loaded pre-resampled pcm " + rate + "Hz");
        return new Uint8Array(b);
    } catch (e) { return resample16k(rate, chn); }
}
function startPcm(reason) {
    if (streaming || pcmBuf === null) return;
    var ef = engineFrame();
    var rate = ef ? ef.rate : 24000;                 // API 声明值(必须 24000)
    var contentRate = ef ? (ef.contentRate || ef.rate) : 16000; // 内容重采样率
    var chn = ef ? ef.channels : 1;
    var frameBytes = ef ? ef.frameBytes : 960;       // memcpy 总长
    var payloadBytes = ef ? (ef.payloadBytes || ef.frameBytes) : 640; // 有效数据
    var frameMs = ef ? ef.frameMs : 20;
    playU8 = (contentRate === 16000 && chn === 1) ? new Uint8Array(pcmBuf)
                                                  : loadPreResampled(contentRate, chn);
    playMeta = { rate: rate, contentRate: contentRate, channels: chn,
                 frameBytes: frameBytes, payloadBytes: payloadBytes, frameMs: frameMs };
    frame = Memory.alloc(frameBytes);
    KEEP.push(frame);
    // 静音 SDK 内部麦克风: 上行若混入采集环境声, 此调用应消除叠加杂音
    var micMute = null;
    try { micMute = muteMicFn(svc.add(8).readPointer().add(0xa10), 1); }
    catch (e) { micMute = "err:" + e; }
    streaming = true; pcmOff = 0; pcmCalls = 0; negativeRets = 0; lastRet = null;
    maxLate = 0; lateCnt3 = 0;
    send({ type: "pcmStart", reason: reason, bytes: playU8.length,
           meta: playMeta, engine: ef, engineNow: engineInfo(), micMute: micMute,
           svc: String(svc), entry: String(CONF.base.add("0x7a370")), ts: Date.now() });
    var stage = new Uint8Array(frameBytes); // 预配暂存+零尾, 每帧只写前 payloadBytes
    var t0 = Date.now(), idx = 0, waiting = 0;
    function tick() {
        if (!streaming) return;
        if (pcmOff >= playU8.length) { stopPcm("eof"); return; }
        var take = Math.min(payloadBytes, playU8.length - pcmOff);
        if (take < payloadBytes) stage.fill(0, 0, payloadBytes); // 尾帧清零
        for (var i = 0; i < take; i++) stage[i] = playU8[pcmOff + i];
        var ret = null, err = null;
        try {
            frame.writeByteArray(stage);
            ret = putExternal(svc, frame, frameBytes, rate, chn);
        } catch (e) { err = String(e); }
        // -405447 = "NoMember is Active": 对方还没接听, 原地等待, 不消耗数据
        if (ret === -405447 && err === null) {
            waiting++;
            if (waiting === 1) send({ type: "pcmWait", reason: "not answered, retrying 200ms", ts: Date.now() });
            if (waiting > 300) { stopPcm("answer timeout 60s"); return; }
            lastRet = ret;
            streamTimer = setTimeout(tick, 200);
            return;
        }
        if (waiting > 0) {
            send({ type: "pcmGo", waitedMs: waiting * 200, ts: Date.now() });
            waiting = 0;
            t0 = Date.now(); idx = 0; // 节奏从接通瞬间起算
        }
        pcmOff += take;
        pcmCalls++;
        negativeRets = (ret !== null && ret < 0) ? negativeRets + 1 : 0;
        var late = Date.now() - (t0 + (idx + 1) * frameMs);
        if (late > maxLate) maxLate = late;
        if (late > 3) lateCnt3++;
        if (pcmCalls <= 5 || pcmCalls % 50 === 0 || ret !== lastRet || err !== null) {
            send({ type: "pcm", n: pcmCalls, bytes: pcmOff, ret: ret, err: err,
                   lateMs: late, meta: playMeta, ts: Date.now() });
        }
        lastRet = ret;
        idx++;
        if (err !== null) { stopPcm("exception"); return; }
        if (negativeRets >= 20) { stopPcm("20 negative returns"); return; }
        var deadline = t0 + idx * frameMs;
        var d = deadline - Date.now();
        if (d > 6) { streamTimer = setTimeout(tick, d - 5); return; }
        while (Date.now() < deadline) { } // 临界自旋: 消除 setTimeout 毫秒级抖动
        streamTimer = setTimeout(tick, 0);
    }
    tick();
}
log("ConfSDK=" + CONF.base + " svc=" + svc + " putExternal=" + CONF.base.add("0x7a370"),
    { pcmBytes: pcmBuf === null ? 0 : pcmBuf.byteLength, engine: engineInfo() });

// ---------- 文件触发拨号/注入/挂断 ----------
var lastTag = (readText("/tmp/voip_uidial.req") || "").trim();
var lastHang = (readText("/tmp/voip_hangup.req") || "").trim();
var lastPcmReq = (readText("/tmp/voip_pcm.req") || "").trim();
setInterval(function () {
    var tag = readText("/tmp/voip_uidial.req");
    if (tag && (tag = tag.trim()) && tag !== lastTag) {
        lastTag = tag;
        var target = (readText("/tmp/voip_target.txt") || "").trim();
        if (!target) { send({ type: "skip", reason: "no target" }); return; }
        var st = clientState();
        if (st.initialized !== 1) {
            send({ type: "skip", reason: "client not initialized; 先人工 UI 拨一次完成初始化", client: st });
            return;
        }
        var cstr = Memory.allocUtf8String(target);
        KEEP.push(cstr);
        var vec = buildVec(target);
        send({ type: "replayPrecheck", wxid: target, vec: String(vec),
               vecInfo: vecInfo(vec), client: st, ts: Date.now() });
        var ret = null, err = null;
        try { ret = dialFn(CLIENT, cstr, vec, ptr(1), 0, ptr("0x2e6981b3")); }
        catch (e) { err = String(e); }
        send({ type: "dial", mode: "native-client", wxid: target, ret: ret,
               retMeaning: ret === 1 ? "ConfSDK vt[6] returned 0 (send ok)" : "send failed/not initialized",
               err: err, clientAfter: clientState(), ts: Date.now() });
    }
    var pr = readText("/tmp/voip_pcm.req");
    if (pr && (pr = pr.trim()) && pr !== lastPcmReq) {
        lastPcmReq = pr;
        if (!streaming) startPcm("req:" + pr);
        else send({ type: "skip", reason: "pcm already streaming", ts: Date.now() });
    }
    var h = readText("/tmp/voip_hangup.req");
    if (h && (h = h.trim()) && h !== lastHang) {
        lastHang = h;
        stopPcm("hangup request");
        var hr = null, he = null;
        try { hr = hangupFn(svc, 1, 0); } catch (e) { he = String(e); }
        send({ type: "hangup", ret: hr, err: he, ts: Date.now() });
    }
}, 500);

log("=== v43 就绪: 拨号 → 接通只报格式(mediaReady) → 写 /tmp/voip_pcm.req 才注入 ===");
