// 探针 v54 — 下行采集完整帧版: 每拉清零缓冲 + 落整帧(x2×2B), 实测每帧写入长度
//
// probe53 教训: x2=[av+0x2320]=1920 是整帧字节数(48k/20ms/s16), 但只 dump 了
// 固定 1024B → 每帧丢 47% → 用户听到 20ms 级碎裂(与注入帧长教训同源)。
// 修法: 每拉前整块清零 → 拉取 → 从尾部找最后一个非零字节推断真实写入长度
// → 按该长度落盘(统计分布), 听感应完整。
//
// 流程: 接通自动 60s: fmt 快照 → 20ms 一拉 → /tmp/voip54_pull.pcm
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
    var sb = Memory.alloc(24); KEEP.push(sb);
    var bytes = new Array(24); for (var i = 0; i < 24; i++) bytes[i] = 0;
    if (wxid.length <= 22) {
        for (var i = 0; i < wxid.length; i++) bytes[i] = wxid.charCodeAt(i) & 0xff;
        bytes[0x17] = wxid.length;
    } else {
        var data = Memory.allocUtf8String(wxid); KEEP.push(data);
        sb.writePointer(data); sb.add(8).writeU64(wxid.length); sb.add(0x17).writeU8(0x80);
        var v2 = Memory.alloc(24); KEEP.push(v2);
        v2.writePointer(sb); v2.add(8).writePointer(sb.add(24)); v2.add(16).writePointer(sb.add(24));
        return v2;
    }
    sb.writeByteArray(bytes);
    var vec = Memory.alloc(24); KEEP.push(vec);
    vec.writePointer(sb); vec.add(8).writePointer(sb.add(24)); vec.add(16).writePointer(sb.add(24));
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
var setStatus = new NativeFunction(CONF.base.add("0x67fdc"), "int",
    ["pointer", "int", "int"]);
var getAudioData = new NativeFunction(CONF.base.add("0x4dba8"), "int",
    ["pointer", "pointer", "int", "pointer"]);
function ceAddr() { try { return svc.add(8).readPointer().add(0xa10); } catch (e) { return ptr(0); } }
function avAddr() { try { return ceAddr().add(8).readPointer().sub(8); } catch (e) { return ptr(0); } }
function startTalk() { try { return ceAddr().add(0x2c).readU32(); } catch (e) { return 0; } }

function fmtSnapshot() {
    try {
        var av = avAddr();
        return {
            av: String(av),
            frameMs: av.add(0x234).readU32(),
            recRate: av.add(0x248).readU32(),
            recCh: av.add(0x24c).readU32(),
            playRate: av.add(0x25c).readU32(),
            playCh: av.add(0x260).readU32(),
            pullBytes: av.add(0x2320).readU32(),
            mode22cc: av.add(0x22cc).readU32(),
            check298: av.add(0x298).readU8(),
            externalMode: av.add(0x5418).readU8()
        };
    } catch (e) { return { error: String(e) }; }
}

var ZERO16 = new Uint8Array(16384);
var pulling = false, pullTimer = null, pullFile = null;
var pullN = 0, pullBytes = 0, lastRet = null;
var writtenHist = {};   // 字节数 → 次数
var buf = null, outP = null, bufU8 = null;
function stopPull(reason) {
    if (!pulling) return;
    pulling = false;
    if (pullTimer) { clearTimeout(pullTimer); pullTimer = null; }
    if (pullFile) { try { pullFile.close(); } catch (e) { } pullFile = null; }
    send({ type: "pullStop", reason: reason, n: pullN, bytes: pullBytes,
           lastRet: lastRet, writtenHist: writtenHist, ts: Date.now() });
}
function startPull() {
    if (pulling) return;
    var ce = ceAddr();
    if (ce.isNull() || startTalk() < 1) return;
    var fmt = fmtSnapshot();
    var x2 = fmt.pullBytes;
    if (!(x2 > 0 && x2 < 8192)) {
        send({ type: "note", msg: "pullBytes 无效", fmt: fmt }); return;
    }
    try { if (ce.add(0x7f4).readU32() === 0) ce.add(0x523).writeU8(1); } catch (e) { }
    var sr = null;
    try { sr = setStatus(ce, 1, 1); } catch (e) { }
    buf = Memory.alloc(16384); KEEP.push(buf);
    outP = Memory.alloc(16); KEEP.push(outP);
    bufU8 = new Uint8Array(buf.readByteArray(16384));   // 常驻视图
    try { pullFile = new File("/tmp/voip54_pull.pcm", "wb"); }
    catch (e) { log("文件失败: " + e); return; }
    pulling = true; pullN = 0; pullBytes = 0; lastRet = null; writtenHist = {};
    send({ type: "pullStart", x2: x2, setStatus: sr, fmt: fmt, ts: Date.now() });
    var t0 = Date.now(), idx = 0;
    var DUMP = Math.max(x2, 960) * 2;   // 落盘区间: 最多两帧宽, 尾部零会被统计出来
    function tick() {
        if (!pulling) return;
        if (Date.now() - t0 > 60000 || startTalk() < 1) {
            stopPull(startTalk() < 1 ? "通话结束" : "60s 到"); return;
        }
        buf.writeByteArray(ZERO16);           // 每拉清零, 才能测真实写入长度
        var r = null, err = null, out = -1;
        try {
            r = getAudioData(ce, buf, x2, outP);
            out = outP.readInt();
        } catch (e) { err = String(e); }
        pullN++;
        var written = 0;
        if (r !== null && r >= 0) {
            try {
                var v = new Uint8Array(buf.readByteArray(DUMP));
                var last = -1;
                for (var i = v.length - 1; i >= 0; i--) {
                    if (v[i] !== 0) { last = i; break; }
                }
                written = last + 1;
                var key = String(written);
                writtenHist[key] = (writtenHist[key] || 0) + 1;
                if (written > 0) {
                    pullFile.write(buf.readByteArray(written));
                    pullBytes += written;
                }
            } catch (e) { err = "read:" + e; }
        }
        if (pullN <= 6 || pullN % 500 === 0 || String(r) !== String(lastRet) || err) {
            send({ type: "pull", n: pullN, ret: r, out: out, written: written,
                   err: err, ts: Date.now() });
        }
        lastRet = r;
        idx++;
        var deadline = t0 + idx * 20;
        var d = deadline - Date.now();
        if (d > 6) { pullTimer = setTimeout(tick, d - 5); return; }
        while (Date.now() < deadline) { }
        pullTimer = setTimeout(tick, 0);
    }
    tick();
}

log("=== v54 就绪(整帧版) ===", { ce: String(ceAddr()), startTalk: startTalk() });

var lastDial = "", lastHang = "", wasTalking = false;
setInterval(function () {
    var st = startTalk();
    if (st >= 1 && !wasTalking) { wasTalking = true; startPull(); }
    if (st < 1) wasTalking = false;
    var d = readText("/tmp/voip_uidial.req");
    if (d && (d = d.trim()) && d !== lastDial) {
        lastDial = d;
        var target = (readText("/tmp/voip_target.txt") || "").trim();
        if (!target) { send({ type: "skip", reason: "no target" }); return; }
        if (CLIENT.add(0x28).readU8() !== 1) { send({ type: "skip", reason: "not init" }); return; }
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
        stopPull("hangup");
        var hr = null, he = null;
        try { hr = hangupFn(svc, 1, 0); } catch (e) { he = String(e); }
        send({ type: "hangup", ret: hr, err: he, ts: Date.now() });
    }
}, 800);
