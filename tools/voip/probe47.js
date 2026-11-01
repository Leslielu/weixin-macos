// 探针 v47 — 无 UI 捕获: 扫 mv 引擎对象指针表, 找「活的下行 PCM 环」
//
// 假设(用户架构判断 + 已证事实):
//   - 注入在无 CoreAudio 下照常被消费(§14 40ms SDK 线程) ⇒ 引擎媒体管线不依赖系统音频
//   - 远端 RTP 照收 ⇒ 解码产物(若解码在跑)必在 mv 附近的环形缓冲里, 只是没人播放
//   - probe46 实证: 通话全程 AudioUnitRender/IOProc 零调用 ⇒ 播放端不存在, 但不影响收流
//
// 方法: startTalk>=1 时周期扫 mv+0x00..0x8000 的指针, 对每个可读指针取 960B 打分:
//   - nonzero 占比 5%~95%(排除全零/全噪声)
//   - s16 平滑度: mean|Δ| < mean|x| (PCM 相邻样本强相关; 压缩数据无此性)
//   - 两轮快照内容变化(活的缓冲, 不是静态配置)
// 得分最高的候选持续落盘 /tmp/voip47_off<hex>.pcm, 事后 afplay 听
//
// 触发: /tmp/voip_uidial.req 拨号  /tmp/voip_hangup.req 挂断
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
function readText(p) {
    try { var f = new File(p, "r"); var t = f.readText(); f.close(); return t; } catch (e) { return null; }
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
var CONF = Process.enumerateModules().filter(function (m) {
    return m.name.indexOf("ConfSDKdyn") !== -1 && m.size > 100 * 1024;
})[0];
var getter = CONF.enumerateExports().filter(function (e) {
    return e.name === "GetWXConfService";
})[0];
var svc = new NativeFunction(getter.address, "pointer", ["int"])(0x1352707);
var dialFn = new NativeFunction(BASE.add("0x1fc07f4"), "int",
    ["pointer", "pointer", "pointer", "pointer", "int", "pointer"]);
var hangupFn = new NativeFunction(svc.readPointer().add(12 * 8).readPointer(), "int",
    ["pointer", "int", "int"]);
function mvAddr() { try { return svc.add(8).readPointer().add(0xa10).add(8).readPointer(); } catch (e) { return ptr(0); } }
function startTalk() { try { return svc.add(8).readPointer().add(0xa10).add(0x2c).readU32(); } catch (e) { return 0; } }

// ---------- PCM 打分 ----------
var PROBE_LEN = 960;
function scoreBytes(p) {
    var b;
    try { b = new Uint8Array(p.readByteArray(PROBE_LEN)); } catch (e) { return null; }
    var nz = 0;
    for (var i = 0; i < b.length; i++) if (b[i] !== 0) nz++;
    var nzFrac = nz / b.length;
    if (nzFrac < 0.05 || nzFrac > 0.95) return { nzFrac: nzFrac };
    var s = new Int16Array(b.buffer);
    var sum = 0, dsum = 0;
    for (i = 1; i < s.length; i++) {
        var v = s[i] < 0 ? -s[i] : s[i];
        sum += v;
        var d = s[i] - s[i - 1];
        dsum += d < 0 ? -d : d;
    }
    var meanAbs = sum / s.length;
    var meanD = dsum / (s.length - 1);
    if (meanAbs < 80 || meanAbs > 24000) return { nzFrac: nzFrac, meanAbs: meanAbs };
    var smooth = meanD / (meanAbs + 1);   // <1 = 相关性强 = PCM 样
    return { nzFrac: nzFrac, meanAbs: meanAbs, meanD: meanD, smooth: smooth,
             score: (1 - Math.min(smooth, 1.5) / 1.5) * Math.min(meanAbs / 3000, 1) };
}

// ---------- 扫描状态 ----------
var cands = {};      // offHex -> {ptr, score, last:u8样本}
var candFiles = {};
var sweepN = 0;
var MAX_CANDS = 24;
function sweep() {
    var mv = mvAddr();
    if (mv.isNull()) return;
    sweepN++;
    var found = [];
    for (var off = 0; off < 0x8000; off += 8) {
        var p;
        try { p = mv.add(off).readPointer(); } catch (e) { continue; }
        if (p.isNull() || p.compare(ptr("0x10000000")) < 0) continue;
        var sc = scoreBytes(p);
        if (sc && sc.score !== undefined && sc.score > 0.15) {
            found.push({ off: off, p: p, sc: sc });
        }
    }
    found.sort(function (a, b) { return b.sc.score - a.sc.score; });
    var reported = [];
    for (var i = 0; i < found.length && i < MAX_CANDS; i++) {
        var c = found[i];
        var key = c.off.toString(16);
        var prev = cands[key];
        var changed = true;
        if (prev) {
            try {
                var now = new Uint8Array(c.p.readByteArray(64));
                changed = false;
                for (var k = 0; k < 64; k++) if (now[k] !== prev[k]) { changed = true; break; }
            } catch (e) { changed = false; }
        }
        try { cands[key] = new Uint8Array(c.p.readByteArray(64)); } catch (e) { }
        if (changed && c.sc.score > 0.25) {
            var f = candFiles[key];
            if (f === undefined) {
                try { f = new File("/tmp/voip47_off" + key + ".pcm", "wb"); candFiles[key] = f; }
                catch (e) { candFiles[key] = null; f = null; }
            }
            if (f) { try { f.write(c.p.readByteArray(PROBE_LEN)); } catch (e) { } }
        }
        if (sweepN <= 3 || (changed && c.sc.score > 0.25)) {
            reported.push({ off: "0x" + key, score: Number(c.sc.score.toFixed(3)),
                            meanAbs: Math.round(c.sc.meanAbs), smooth: Number(c.sc.smooth.toFixed(3)),
                            changed: changed });
        }
    }
    if (reported.length) {
        send({ type: "sweep", n: sweepN, hits: reported, ts: Date.now() });
    }
    if (sweepN === 1) log("首扫完成: 候选 " + found.length + " 个", { mv: String(mv) });
}

log("=== v47 就绪(内存扫环) ===", { svc: String(svc) });

var lastFlags = "";
var sweeping = false;
setInterval(function () {
    var st = startTalk();
    var key = "st" + st;
    if (key !== lastFlags) {
        lastFlags = key;
        send({ type: "flagsChanged", startTalk: st, mv: String(mvAddr()), ts: Date.now() });
    }
    if (st >= 1 && !mvAddr().isNull()) {
        try { sweep(); } catch (e) { send({ type: "log", msg: "sweep err: " + e }); }
    }
    var tag = readText("/tmp/voip_uidial.req");
    if (tag && (tag = tag.trim()) && tag !== lastDial) {
        lastDial = tag;
        var target = (readText("/tmp/voip_target.txt") || "").trim();
        if (!target) { send({ type: "skip", reason: "no target" }); return; }
        var init = CLIENT.add(0x28).readU8();
        if (init !== 1) { send({ type: "skip", reason: "client not initialized" }); return; }
        var cstr = Memory.allocUtf8String(target); KEEP.push(cstr);
        var vec = buildVec(target);
        var ret = null, err = null;
        try { ret = dialFn(CLIENT, cstr, vec, ptr(1), 0, ptr("0x2e6981b3")); }
        catch (e) { err = String(e); }
        send({ type: "dial", wxid: target, ret: ret, err: err, ts: Date.now() });
    }
    var h = readText("/tmp/voip_hangup.req");
    if (h && (h = h.trim()) && h !== lastHang) {
        lastHang = h;
        for (var k in candFiles) {
            if (candFiles[k]) { try { candFiles[k].close(); } catch (e) { } }
        }
        candFiles = {};
        var hr = null, he = null;
        try { hr = hangupFn(svc, 1, 0); } catch (e) { he = String(e); }
        send({ type: "hangup", ret: hr, err: he, ts: Date.now() });
    }
}, 1500);
var lastDial = "", lastHang = "";
