// 探针 v51 — SetAudioPlayStatus 激活 + GetAudioData 拉取, 全自动
//
// 静态链(2026-11-01):
//   SetAudioPlayStatus = ConfSDKdyn+0x67fdc (ce, member_id, status)
//     member 查 [ce+0x3f8] 表 → [ce+0x418][i]=status → mv->vt[118](channelId, status)
//   GetAudioData       = ConfSDKdyn+0x4dba8 (ce, buf, memberid_i16, &outInt) → mv->vt[32]
//   probe50 实测: 活呼叫上 GetAudioData 恒 -1 ⇒ 播放信道未激活, 先 Set 再拉
//
// 自动流程: startTalk>=1 → 对 memberid∈{1,0,2,3} 逐个 Set(1) → 拉 60s 落盘
// 文件: /tmp/voip51_pull_m<mid>.pcm
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
var getAudioDataEx = new NativeFunction(CONF.base.add("0x4dd98"), "int",
    ["pointer", "pointer", "int", "pointer"]);
function ceAddr() { try { return svc.add(8).readPointer().add(0xa10); } catch (e) { return ptr(0); } }
function startTalk() { try { return ceAddr().add(0x2c).readU32(); } catch (e) { return 0; } }
function members() {
    try { return ceAddr().add(0x474).readU32(); } catch (e) { return 0; }
}

var pulling = false, pullTimer = null;
var bufs = {}, outs = {}, files = {};
var stats = {};   // mid -> {n, ok, nzMax, bytes}
function stopAll(reason) {
    if (!pulling) return;
    pulling = false;
    if (pullTimer) { clearTimeout(pullTimer); pullTimer = null; }
    for (var k in files) { if (files[k]) { try { files[k].close(); } catch (e) { } } }
    files = {};
    send({ type: "pullStop", reason: reason, stats: stats, ts: Date.now() });
}
var MIDS = [1, 0, 2, 3];
function startAll() {
    if (pulling) return;
    var ce = ceAddr();
    if (ce.isNull() || startTalk() < 1) return;
    // 门禁保险
    try { if (ce.add(0x7f4).readU32() === 0) ce.add(0x523).writeU8(1); } catch (e) { }
    // 激活各成员播放信道
    var setRets = {};
    MIDS.forEach(function (mid) {
        var r = null, e2 = null;
        try { r = setStatus(ce, mid, 1); } catch (e) { e2 = String(e); }
        setRets["m" + mid] = r === null ? e2 : r;
    });
    // 缓冲
    MIDS.forEach(function (mid) {
        bufs[mid] = Memory.alloc(8192); KEEP.push(bufs[mid]);
        outs[mid] = Memory.alloc(8); KEEP.push(outs[mid]);
        bufs[mid].writeByteArray(new Uint8Array(8192));
        outs[mid].writeByteArray(new Uint8Array(8));
        stats[mid] = { n: 0, ok: 0, nzMax: 0, bytes: 0, rets: {} };
    });
    try { files[1] = new File("/tmp/voip51_pull_m1.pcm", "wb"); files[0] = new File("/tmp/voip51_pull_m0.pcm", "wb"); }
    catch (e) { log("文件失败: " + e); }
    pulling = true;
    send({ type: "pullStart", setRets: setRets, members: members(), ts: Date.now() });
    var t0 = Date.now(), idx = 0;
    function tick() {
        if (!pulling) return;
        if (Date.now() - t0 > 60000 || startTalk() < 1) { stopAll(startTalk() < 1 ? "通话结束" : "60s 到"); return; }
        MIDS.forEach(function (mid) {
            var f = files[mid];
            if (!f) return;
            var r = null, err = null, out = -1, nz = -1;
            try {
                r = getAudioData(ce, bufs[mid], mid, outs[mid]);
                out = outs[mid].readInt();
            } catch (e) { err = String(e); }
            var st = stats[mid];
            st.n++;
            var key = "r" + r;
            st.rets[key] = (st.rets[key] || 0) + 1;
            if (r !== null && r >= 0) {
                st.ok++;
                try {
                    var b = new Uint8Array(bufs[mid].readByteArray(960));
                    nz = 0;
                    for (var i = 0; i < b.length; i++) if (b[i] !== 0) nz++;
                    if (nz > st.nzMax) st.nzMax = nz;
                    f.write(bufs[mid].readByteArray(960));
                    st.bytes += 960;
                } catch (e) { err = "read:" + e; }
            }
            if (st.n <= 4 || st.n % 150 === 0 || err) {
                send({ type: "pull", mid: mid, n: st.n, ret: r, out: out, nonzero: nz, err: err, ts: Date.now() });
            }
        });
        idx++;
        var deadline = t0 + idx * 20;
        var d = deadline - Date.now();
        if (d > 6) { pullTimer = setTimeout(tick, d - 5); return; }
        while (Date.now() < deadline) { }
        pullTimer = setTimeout(tick, 0);
    }
    tick();
}

log("=== v51 就绪(Set+拉) ===", { ce: String(ceAddr()), startTalk: startTalk() });

var lastDial = "", lastHang = "", wasTalking = false;
setInterval(function () {
    var st = startTalk();
    if (st >= 1 && !wasTalking) { wasTalking = true; startAll(); }
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
        stopAll("hangup");
        var hr = null, he = null;
        try { hr = hangupFn(svc, 1, 0); } catch (e) { he = String(e); }
        send({ type: "hangup", ret: hr, err: he, ts: Date.now() });
    }
}, 800);
