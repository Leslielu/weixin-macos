// 探针 v48 — 罗塞塔锚点: 注入特征图形 → 全内存定位 REC 环 → 找隔壁的 PLAY 环
//
// 原理:
//   注入管线无 UI 也在跑(probe43-46 已证) → 往 PutExternalRecordData 灌 10 帧
//   特定锯齿波(周期 240 样本, ±30000), 引擎会把它拷进内部 REC 环;
//   全内存扫特征签名 → REC 环地址; PLAY(下行)环按引擎布局应在其邻域
//   (同一父结构的对称成员), 用「远端说话时 200ms 级变化 + PCM 样」筛出。
//
// 触发文件:
//   /tmp/voip_uidial.req    拨号(目标 /tmp/voip_target.txt)
//   /tmp/voip48_pat.req     灌特征图形(需已接通)
//   /tmp/voip48_scan.req    全内存搜签名, 报告命中
//   /tmp/voip48_watch.req   对上次 scan 命中的邻域做 60s 变化监视+落盘
//   /tmp/voip_hangup.req    挂断
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
var putExternal = new NativeFunction(CONF.base.add("0x7a370"), "int",
    ["pointer", "pointer", "int", "int", "int"]);
function mvAddr() { try { return svc.add(8).readPointer().add(0xa10).add(8).readPointer(); } catch (e) { return ptr(0); } }
function ceAddr() { try { return svc.add(8).readPointer().add(0xa10); } catch (e) { return ptr(0); } }
function startTalk() { try { return ceAddr().add(0x2c).readU32(); } catch (e) { return 0; } }
// 引擎实际格式(probe44 验证过的读法)
function engineFormat() {
    try {
        var mv = mvAddr();
        if (mv.isNull()) return null;
        var av = mv.sub(8);
        var frameMs = av.add(0x234).readU32();
        var rate = av.add(0x254).readU32();
        var ch = av.add(0x258).readU32();
        if (!(frameMs >= 5 && frameMs <= 60) || !(rate >= 8000 && rate <= 96000)) return null;
        return { frameMs: frameMs, rate: rate, ch: (ch === 2 ? 2 : 1) };
    } catch (e) { return null; }
}

// ---------- 特征图形 ----------
var PAT_FRAMES = 10;
var patBuf = null, patFrameBytes = 960, patSigHex = null, patInjected = 0;
function buildPattern() {
    var fmt = engineFormat();
    var samples = 480;                     // 20ms@24k 兜底
    var contentRate = 24000;
    if (fmt) {
        samples = Math.floor(fmt.frameMs * fmt.rate * fmt.ch / 1000);
        contentRate = fmt.rate;
    }
    patFrameBytes = samples * 2;
    patBuf = Memory.alloc(patFrameBytes * PAT_FRAMES);
    KEEP.push(patBuf);
    var u8 = new Uint8Array(patFrameBytes * PAT_FRAMES);
    var s16 = new Int16Array(u8.buffer);
    var period = 240;
    for (var f = 0; f < PAT_FRAMES; f++) {
        for (var i = 0; i < samples; i++) {
            s16[f * samples + i] = ((i % period) - period / 2) * 250;
        }
    }
    patBuf.writeByteArray(u8);
    patSigHex = hexs(u8.slice(0, 16));
    log("pattern built", { frames: PAT_FRAMES, samples: samples, contentRate: contentRate,
                           sig: patSigHex, fmt: fmt });
    return { samples: samples, contentRate: contentRate, fmt: fmt };
}
function injectPattern() {
    if (!patBuf) buildPattern();
    var fmt = engineFormat();
    if (fmt) buildPattern();               // 接通后按真实格式重建
    var ret = null, err = null;
    try {
        ret = putExternal(svc, patBuf, patFrameBytes * PAT_FRAMES, 24000, 1);
    } catch (e) { err = String(e); }
    patInjected++;
    send({ type: "patInject", ret: ret, err: err, bytes: patFrameBytes * PAT_FRAMES,
           sig: patSigHex, n: patInjected, ts: Date.now() });
    return err === null && ret === 0;
}

// ---------- 全内存扫签名 ----------
var scanHits = [];
function scanMemory() {
    if (!patSigHex) { log("no pattern yet"); return; }
    scanHits = [];
    var ranges = Process.enumerateRanges({ protection: "rw-", coalesce: false });
    var pending = ranges.length, total = 0;
    log("scan start", { ranges: ranges.length });
    ranges.forEach(function (r) {
        if (r.size > 512 * 1024 * 1024) { pending--; return; }
        Memory.scan(r.base, r.size, patSigHex, {
            onMatch: function (address, size) {
                scanHits.push({ addr: address, base: r.base, rsize: r.size });
                total++;
            },
            onError: function () { },
            onComplete: function () {
                pending--;
                if (pending === 0) {
                    var mods = scanHits.map(function (h) {
                        return { addr: String(h.addr), off: "+0x" + h.addr.sub(h.base).toString(16),
                                 rsize: h.rsize };
                    });
                    send({ type: "scanDone", hits: mods.slice(0, 64), total: total, ts: Date.now() });
                    log("scan done: " + total + " hits");
                }
            }
        });
    });
}

// ---------- 邻域监视: 找「远端说话时变化 + PCM 样」的缓冲 ----------
var watchFiles = {}, watchTimer = null, watchN = 0, watchHits = [];
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
function startWatch() {
    if (watchTimer) { clearTimeout(watchTimer); watchTimer = null; }
    // 候选区 = 每个 scan 命中所在分配块附近 [base, base+1MB) 的 8 字节步进指针
    watchHits = [];
    var seen = {};
    scanHits.forEach(function (h) {
        for (var off = -0x4000; off <= 0x4000; off += 8) {
            var p;
            try { p = h.addr.add(off).readPointer(); } catch (e) { continue; }
            if (p.isNull()) continue;
            var k = String(p);
            if (seen[k]) continue;
            seen[k] = 1;
            var sc = scoreBytes(p);
            if (sc && sc.score > 0.2) watchHits.push({ p: p, from: h.addr, sc: sc });
        }
    });
    send({ type: "watchStart", candidates: watchHits.length, ts: Date.now() });
    var t0 = Date.now();
    watchN = 0;
    function tick() {
        watchN++;
        var reported = [];
        watchHits.forEach(function (c) {
            var sc = scoreBytes(c.p);
            if (!sc || sc.score < 0.2) return;
            var key = String(c.p);
            try {
                var f = watchFiles[key];
                if (f === undefined) {
                    f = new File("/tmp/voip48_w" + key.slice(-6) + ".pcm", "wb");
                    watchFiles[key] = f;
                }
                f.write(c.p.readByteArray(960));
            } catch (e) { return; }
            if (watchN <= 4 || watchN % 25 === 0) {
                reported.push({ p: key, from: String(c.from), score: Number(sc.score.toFixed(3)),
                                meanAbs: Math.round(sc.meanAbs) });
            }
        });
        if (reported.length) send({ type: "watch", n: watchN, hits: reported, ts: Date.now() });
        if (Date.now() - t0 < 60000) watchTimer = setTimeout(tick, 200);
        else {
            watchTimer = null;
            var files = [];
            for (var k in watchFiles) files.push(k);
            send({ type: "watchDone", n: watchN, files: Object.keys(watchFiles).length, ts: Date.now() });
        }
    }
    tick();
}

log("=== v48 就绪(罗塞塔) ===", { svc: String(svc), mv: String(mvAddr()) });

var lastDial = "", lastHang = "", lastPat = "", lastScan = "", lastWatch = "";
setInterval(function () {
    function trig(path, lastVar) {
        var v = readText(path);
        if (v && (v = v.trim()) && v !== lastVar) return v;
        return null;
    }
    var v;
    if ((v = trig("/tmp/voip_uidial.req", lastDial))) {
        lastDial = v;
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
    if ((v = trig("/tmp/voip48_pat.req", lastPat))) {
        lastPat = v;
        if (startTalk() < 1) { send({ type: "skip", reason: "not in talk" }); return; }
        injectPattern();
    }
    if ((v = trig("/tmp/voip48_scan.req", lastScan))) {
        lastScan = v;
        scanMemory();
    }
    if ((v = trig("/tmp/voip48_watch.req", lastWatch))) {
        lastWatch = v;
        startWatch();
    }
    if ((v = trig("/tmp/voip_hangup.req", lastHang))) {
        lastHang = v;
        if (watchTimer) { clearTimeout(watchTimer); watchTimer = null; }
        for (var k in watchFiles) { try { watchFiles[k].close(); } catch (e) { } }
        watchFiles = {};
        var hr = null, he = null;
        try { hr = hangupFn(svc, 1, 0); } catch (e) { he = String(e); }
        send({ type: "hangup", ret: hr, err: he, ts: Date.now() });
    }
}, 1000);
