// 探针 v53 — GetAudioData 正确姿势: x2=每拉样本数([av+0x2320]), 不是 memberid
//
// 静态突破(2026-11-02 凌晨, MultiMediaDyn 反汇编):
//   vt[32] 真身 = MultiMediaDyn+0x211974 (thunk 0x211d1c: sub x0,8)
//   this = av 对象(mv-8, 与 engineFrame 读格式同一个)
//   检查链: [av+0x2320]==x2 (或 [av+0x22cc]==2 时 2×也行);
//           [av+0x298]!=0 时再验 recRate*recCh*frameMs/1000==x2
//           → 全过才拉数, 失败记 err206 返回 -1  ← probe50~52 的 -1 就是这个
//   输出按 playRate([av+0x25c])/recRate([av+0x248]) 重采样
// ⇒ ConfEngine::GetAudioData(ce, buf, SAMPLES, &out) — x2 传 [av+0x2320] 读出来的值
//
// 流程: 接通自动跑 60s: 读格式块 → 每 20ms GetAudioData → 落盘 /tmp/voip53_pull.pcm
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
            recChAp: av.add(0x23c).readU32(),
            recRateAp: av.add(0x240).readU32(),
            recRate: av.add(0x248).readU32(),
            recCh: av.add(0x24c).readU32(),
            bytesPerSample: av.add(0x254).readU32(),
            playRate: av.add(0x25c).readU32(),
            playCh: av.add(0x260).readU32(),
            pullSamples: av.add(0x2320).readU32(),   // ← 关键: x2 该传的值
            mode22cc: av.add(0x22cc).readU32(),
            check298: av.add(0x298).readU8(),
            externalMode: av.add(0x5418).readU8()
        };
    } catch (e) { return { error: String(e) }; }
}

var pulling = false, pullTimer = null, pullFile = null;
var pullN = 0, pullBytes = 0, lastRet = null, nzMax = 0;
var buf = null, outP = null;
function stopPull(reason) {
    if (!pulling) return;
    pulling = false;
    if (pullTimer) { clearTimeout(pullTimer); pullTimer = null; }
    if (pullFile) { try { pullFile.close(); } catch (e) { } pullFile = null; }
    send({ type: "pullStop", reason: reason, n: pullN, bytes: pullBytes,
           nzMax: nzMax, lastRet: lastRet, ts: Date.now() });
}
function startPull() {
    if (pulling) return;
    var ce = ceAddr();
    if (ce.isNull() || startTalk() < 1) return;
    var fmt = fmtSnapshot();
    send({ type: "fmt", fmt: fmt, ts: Date.now() });
    var samples = fmt.pullSamples;
    if (!(samples > 0 && samples < 4096)) {
        // 兜底: 按公式算(frameMs*recCh*recRate/1000)
        samples = Math.floor(fmt.frameMs * fmt.recCh * fmt.recRate / 1000);
        send({ type: "note", msg: "pullSamples 无效, 用公式算", samples: samples });
    }
    // 立体声模式下允许 2× 形态: 首个 tick 探测, x2 先用 samples
    try { if (ce.add(0x7f4).readU32() === 0) ce.add(0x523).writeU8(1); } catch (e) { }
    var sr = null;
    try { sr = setStatus(ce, 1, 1); } catch (e) { }
    buf = Memory.alloc(16384); KEEP.push(buf);
    outP = Memory.alloc(16); KEEP.push(outP);
    buf.writeByteArray(new Uint8Array(16384));
    outP.writeByteArray(new Uint8Array(16));
    try { pullFile = new File("/tmp/voip53_pull.pcm", "wb"); }
    catch (e) { log("文件失败: " + e); return; }
    pulling = true; pullN = 0; pullBytes = 0; nzMax = 0; lastRet = null;
    send({ type: "pullStart", samples: samples, setStatus: sr, fmt: fmt, ts: Date.now() });
    var t0 = Date.now(), idx = 0;
    var x2 = samples;
    function tick() {
        if (!pulling) return;
        if (Date.now() - t0 > 60000 || startTalk() < 1) {
            stopPull(startTalk() < 1 ? "通话结束" : "60s 到"); return;
        }
        var r = null, err = null, out = -1, nz = -1;
        try {
            r = getAudioData(ce, buf, x2, outP);
            out = outP.readInt();
        } catch (e) { err = String(e); }
        // 立体声探测: 恒 -1 且 mode22cc==2 时试 2×
        if (r === -1 && pullN < 40 && fmt.mode22cc === 2 && x2 === samples) {
            x2 = samples * 2;
            send({ type: "note", msg: "试立体声 2×: x2=" + x2, ts: Date.now() });
        } else if (r === -1 && pullN < 80 && x2 !== samples) {
            x2 = Math.floor(fmt.frameMs * fmt.recCh * fmt.recRate / 1000);
            send({ type: "note", msg: "回退公式 x2=" + x2, ts: Date.now() });
        }
        pullN++;
        if (r !== null && r >= 0) {
            try {
                var b = new Uint8Array(buf.readByteArray(1024));
                nz = 0;
                for (var i = 0; i < b.length; i++) if (b[i] !== 0) nz++;
                if (nz > nzMax) nzMax = nz;
                pullFile.write(buf.readByteArray(1024));
                pullBytes += 1024;
            } catch (e) { err = "read:" + e; }
        }
        if (pullN <= 10 || pullN % 250 === 0 || String(r) !== String(lastRet) || err) {
            send({ type: "pull", n: pullN, ret: r, out: out, x2: x2, nonzero: nz,
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

log("=== v53 就绪(x2=样本数) ===", { ce: String(ceAddr()), startTalk: startTalk() });

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
