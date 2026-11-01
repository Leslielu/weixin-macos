// 探针 v49 — 按 channel 表定向捕下行: DecodeAudioPkt 证明 + channel 对象扫 PCM 环
//
// 静态依据(2026-11-01 字符串表 + 反汇编):
//   DecodeAudioPkt = ConfSDKdyn+0x54d78(ce, pkt=x1, x2, memberid=x3, x4, x5)
//     门禁: [ce+0x29]!=0, [ce+8]!=0, startTalkFlag!=0; 锁 ce+0x148 / ce+0x288
//     member 查 [ce+0x3f8](id 表) → channel 句柄 [ce+0x400][i], 对象指针 [ce+0x420][i*0x10]
//   "Audio Creat NewChannel For New-Member: channelID, memberid" ⇒ 每成员一个 channel 对象
//   probe48 实证: 注入图形被拷进 REC 环(两块内存), 但 REC 邻域无下行环
//
// 做法: 全被动
//   1) 挂 DecodeAudioPkt: 证明解码在跑 + 抓 memberid/包长/包头
//   2) startTalk>=1 时按 [ce+0x474]×[ce+0x420] 定位 channel 对象,
//      扫对象内指针找「变化 + PCM 样」缓冲 → 落盘 /tmp/voip49_ch<i>_off<hex>.pcm
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
function hexs(b) {
    return Array.from(b).map(function (x) { return ("0" + x.toString(16)).slice(-2); }).join("");
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
function ceAddr() { try { return svc.add(8).readPointer().add(0xa10); } catch (e) { return ptr(0); } }
function mvAddr() { try { return ceAddr().add(8).readPointer(); } catch (e) { return ptr(0); } }
function startTalk() { try { return ceAddr().add(0x2c).readU32(); } catch (e) { return 0; } }

// ---------- 1) DecodeAudioPkt 观测 ----------
var dapN = 0;
try {
    Interceptor.attach(CONF.base.add("0x54d78"), {
        onEnter: function (args) {
            this.pkt = args[1]; this.x2 = args[2]; this.mid = args[3].toInt32();
            this.x4 = args[4]; this.x5 = args[5];
            dapN++;
        },
        onLeave: function (retval) {
            var r = retval.toInt32();
            if (dapN <= 6 || dapN % 200 === 0) {
                var head = "";
                try { head = hexs(new Uint8Array(this.pkt.readByteArray(24))); } catch (e) { head = "ERR"; }
                send({ type: "decodePkt", n: dapN, memberid: this.mid, x2: String(this.x2),
                       x4: String(this.x4), x5: String(this.x5), ret: r, head: head, ts: Date.now() });
            }
        }
    });
    log("DecodeAudioPkt hooked @ " + CONF.base.add("0x54d78"));
} catch (e) { log("DecodeAudioPkt hook 失败: " + e); }

// ---------- 2) channel 对象 PCM 环扫描 ----------
function scoreBytes(p) {
    var b;
    try { b = new Uint8Array(p.readByteArray(960)); } catch (e) { return null; }
    var nz = 0;
    for (var i = 0; i < b.length; i++) if (b[i] !== 0) nz++;
    var nzFrac = nz / b.length;
    if (nzFrac < 0.05 || nzFrac > 0.95) return null;
    var s = new Int16Array(b.buffer);
    var sum = 0, dsum = 0;
    for (i = 1; i < s.length; i++) {
        var v = s[i] < 0 ? -s[i] : s[i];
        sum += v;
        var d = s[i] - s[i - 1];
        dsum += d < 0 ? -d : d;
    }
    var meanAbs = sum / s.length, meanD = dsum / (s.length - 1);
    if (meanAbs < 80 || meanAbs > 24000) return null;
    var smooth = meanD / (meanAbs + 1);
    return { meanAbs: meanAbs, smooth: smooth,
             score: (1 - Math.min(smooth, 1.5) / 1.5) * Math.min(meanAbs / 3000, 1) };
}
var chFiles = {}, chSweepN = 0, chReported = {};
function channelSweep() {
    var ce = ceAddr();
    if (ce.isNull()) return;
    var n;
    try { n = ce.add(0x474).readU32(); } catch (e) { return; }
    if (n < 1 || n > 32) return;
    chSweepN++;
    var reported = [];
    for (var i = 0; i < n; i++) {
        var objP;
        try { objP = ce.add(0x420).add(i * 0x10).readPointer(); } catch (e) { continue; }
        if (objP.isNull()) continue;
        var cid = -1;
        try { cid = ce.add(0x400).add(i * 4).readU32(); } catch (e) { }
        // channel 对象前 0x2000 字节里的指针
        for (var off = 0; off < 0x2000; off += 8) {
            var p;
            try { p = objP.add(off).readPointer(); } catch (e) { continue; }
            if (p.isNull() || p.compare(ptr("0x10000000")) < 0) continue;
            var sc = scoreBytes(p);
            if (!sc || sc.score < 0.25) continue;
            var key = cid + "_" + off.toString(16);
            var f = chFiles[key];
            if (f === undefined) {
                try { f = new File("/tmp/voip49_ch" + cid + "_off" + off.toString(16) + ".pcm", "wb"); }
                catch (e) { f = null; }
                chFiles[key] = f;
                log("channel PCM 候选: ch=" + cid + " obj=" + objP + " off=0x" + off.toString(16) +
                    " score=" + sc.score.toFixed(3) + " meanAbs=" + Math.round(sc.meanAbs));
            }
            if (f) { try { f.write(p.readByteArray(960)); } catch (e) { } }
            if (chSweepN <= 3 || (chFiles[key] && chSweepN % 10 === 0)) {
                reported.push({ ch: cid, off: "0x" + off.toString(16),
                                score: Number(sc.score.toFixed(3)) });
            }
        }
    }
    if (reported.length && chSweepN <= 3) {
        send({ type: "chSweep", n: chSweepN, hits: reported, ts: Date.now() });
    }
    if (chSweepN === 1) log("channel 首扫完成 members=" + n);
}

log("=== v49 就绪(channel 定向) ===", { svc: String(svc), ce: String(ceAddr()) });

var lastDial = "", lastHang = "";
setInterval(function () {
    var st = startTalk();
    if (st >= 1) { try { channelSweep(); } catch (e) { } }
    var tag = readText("/tmp/voip_uidial.req");
    if (tag && (tag = tag.trim()) && tag !== lastDial) {
        lastDial = tag;
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
        for (var k in chFiles) { if (chFiles[k]) { try { chFiles[k].close(); } catch (e) { } } }
        chFiles = {};
        var hr = null, he = null;
        try { hr = hangupFn(svc, 1, 0); } catch (e) { he = String(e); }
        send({ type: "hangup", ret: hr, err: he, ts: Date.now() });
    }
}, 2000);
