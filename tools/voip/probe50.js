// 探针 v50 — 我们当音频设备: 直接调 GetAudioData 拉「解码后下行 PCM」
//
// 静态依据(2026-11-01):
//   GetAudioData    = ConfSDKdyn+0x4dba8 (ce, buf, memberid_i16, &outInt) → mv->vt[32]
//   GetAudioDataEx  = ConfSDKdyn+0x4dd98 (ce, buf, memberid_i16, &outInt) → mv->vt[32]
//   门禁: startTalkFlag>=1 + ([ce+0x7f4] 或 [ce+0x523]); 实测接通后 +0x7f4 自动=1
//   DecodeAudioPkt 实测: 远端 memberid=1; 包持续到达 ⇒ jitter 里有货
//   机制: decode-on-pull, 设备回调不来就没人拉 → 我们自己 20ms 一拉
//
// 触发: /tmp/voip50_pull.req  开拉(60s, memberid 见 /tmp/voip50_mid.txt, 默认 1)
//       /tmp/voip_hangup.req  挂断
var REAL_MOD = Process.enumerateModules().filter(function (m) {
    return /wechat\.dylib/i.test(m.name) && m.size > 100 * 1024 * 1024;
})[0];
if (!REAL_MOD) throw new Error("wechat.dylib real image not found");
var BASE = REAL_MOD.base;
var KEEP = [];

function log(s, extra) {
    var m = { type: "log", msg: s, ts: Date.now() };
    if (extra) for (var k in extra) m[k] = extra[k];
    send(m);
}
function readText(p) {
    try { var f = new File(p, "r"); var t = f.readText(); f.close(); return t; } catch (e) { return null; }
}
var CONF = Process.enumerateModules().filter(function (m) {
    return m.name.indexOf("ConfSDKdyn") !== -1 && m.size > 100 * 1024;
})[0];
var getter = CONF.enumerateExports().filter(function (e) {
    return e.name === "GetWXConfService";
})[0];
var svc = new NativeFunction(getter.address, "pointer", ["int"])(0x1352707);
var hangupFn = new NativeFunction(svc.readPointer().add(12 * 8).readPointer(), "int",
    ["pointer", "int", "int"]);
function ceAddr() { try { return svc.add(8).readPointer().add(0xa10); } catch (e) { return ptr(0); } }
function startTalk() { try { return ceAddr().add(0x2c).readU32(); } catch (e) { return 0; } }

var dialFn = new NativeFunction(BASE.add("0x1fc07f4"), "int",
    ["pointer", "pointer", "pointer", "pointer", "int", "pointer"]);
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
var getAudioData = new NativeFunction(CONF.base.add("0x4dba8"), "int",
    ["pointer", "pointer", "int", "pointer"]);
var getAudioDataEx = new NativeFunction(CONF.base.add("0x4dd98"), "int",
    ["pointer", "pointer", "int", "pointer"]);

var pulling = false, pullTimer = null, pullFile = null;
var pullN = 0, pullBytes = 0, lastRet = null, pullBuf = null, outP = null;
function stopPull(reason) {
    if (!pulling) return;
    pulling = false;
    if (pullTimer) { clearTimeout(pullTimer); pullTimer = null; }
    if (pullFile) { try { pullFile.close(); } catch (e) { } pullFile = null; }
    send({ type: "pullStop", reason: reason, n: pullN, bytes: pullBytes, lastRet: lastRet, ts: Date.now() });
}
function startPull(mid) {
    if (pulling) return;
    var ce = ceAddr();
    if (ce.isNull() || startTalk() < 1) { log("pull: 未接通或 ce 为空"); return; }
    // 过门禁(+0x7f4 应已=1, 保险起见把 +0x523 也写上)
    try { if (ce.add(0x7f4).readU32() === 0) ce.add(0x523).writeU8(1); } catch (e) { }
    pullBuf = Memory.alloc(8192); KEEP.push(pullBuf);
    outP = Memory.alloc(8); KEEP.push(outP);
    pullBuf.writeByteArray(new Uint8Array(8192));
    outP.writeByteArray(new Uint8Array(8));
    try { pullFile = new File("/tmp/voip50_pull.pcm", "wb"); } catch (e) { log("文件失败: " + e); return; }
    pulling = true; pullN = 0; pullBytes = 0; lastRet = null;
    var t0 = Date.now(), idx = 0;
    send({ type: "pullStart", memberid: mid, ts: Date.now() });
    function tick() {
        if (!pulling) return;
        if (Date.now() - t0 > 60000) { stopPull("60s 到"); return; }
        if (startTalk() < 1) { stopPull("通话结束"); return; }
        var r = null, err = null, out = -1;
        try {
            r = getAudioData(ce, pullBuf, mid, outP);
            out = outP.readInt();
        } catch (e) { err = String(e); }
        pullN++;
        var nz = -1;
        if (r !== null && r >= 0) {
            try {
                var b = new Uint8Array(pullBuf.readByteArray(960));
                nz = 0;
                for (var i = 0; i < b.length; i++) if (b[i] !== 0) nz++;
                pullFile.write(pullBuf.readByteArray(960));
                pullBytes += 960;
            } catch (e) { err = "read:" + e; }
        }
        if (pullN <= 12 || pullN % 100 === 0 || String(r) !== String(lastRet) || err) {
            send({ type: "pull", n: pullN, ret: r, out: out, nonzero: nz, err: err, ts: Date.now() });
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

log("=== v50 就绪(自当设备) ===", { ce: String(ceAddr()), startTalk: startTalk() });

var lastPull = "", lastHang = "", lastDial = "";
setInterval(function () {
    if (!pulling && startTalk() >= 1) {
        var mid = parseInt(readText("/tmp/voip50_mid.txt") || "1", 10);
        if (isNaN(mid)) mid = 1;
        startPull(mid);
    }
    var v = readText("/tmp/voip50_pull.req");
    if (v && (v = v.trim()) && v !== lastPull) {
        lastPull = v;
        var mid = parseInt(readText("/tmp/voip50_mid.txt") || "1", 10);
        if (isNaN(mid)) mid = 1;
        startPull(mid);
    }
    var d = readText("/tmp/voip_uidial.req");
    if (d && (d = d.trim()) && d !== lastDial) {
        lastDial = d;
        var target = (readText("/tmp/voip_target.txt") || "").trim();
        if (!target) { send({ type: "skip", reason: "no target" }); return; }
        if (BASE.add("0x9b93ab8").add(0x28).readU8() !== 1) { send({ type: "skip", reason: "not init" }); return; }
        var cstr = Memory.allocUtf8String(target); KEEP.push(cstr);
        var vec = buildVec(target);
        var ret = null, err = null;
        try { ret = dialFn(BASE.add("0x9b93ab8"), cstr, vec, ptr(1), 0, ptr("0x2e6981b3")); }
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
