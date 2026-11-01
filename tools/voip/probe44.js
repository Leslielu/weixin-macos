// 探针 v44 — 入站(听对方)采集定性: GetExternalHybridPlayData 是 pull 还是引擎来取
//
// 静态结论(2026-11-01, /tmp/confsdk_full.asm):
//   +0x7a388 wrapper(svc, buf, len, streamId, mode, a5, a6, a7, stackArg)
//     → 0x38458 → engine impl 0x65e20, this = [svc+8]+0xa10 (ce)
//   0x65e20 门禁: [ce+8] 非空; ce.startTalkFlag(+0x2c)>=1 否则 -405533;
//     [ce+0x7f4](u32 stream计数) 或 [ce+0x523](u8 外部播放使能, 来自 config+0x94)
//     至少一个非零, 否则 -405500; mode(x4)==2 走 hybrid 主路(跳过 stream 查表,
//     x3 作废), 否则按 x3 在 [ce+0x3f8] 表里查 → -405511
//   主路: 锁 [ce+0x248] → mv->vt[97](mv, buf, len, a7, 出参*×5, -1, mode, a5, …)
//     mv = [ce+8]; 出参在调用者栈上(字节/格式信息, wrapper 丢弃)
//
// 两路定性:
//   A 被动: 挂 mv->vt[97] 入口/出口, 看微信自己是否周期调用+缓冲区是否有数据
//   B 主动: 触发后写 [ce+0x523]=1, 每 20ms pull 一帧 mode=2, 数据落盘
//
// 文件:
//   /tmp/voip_uidial.req   写新内容 = 原生客户端拨号(目标在 /tmp/voip_target.txt)
//   /tmp/voip_cap.req      写新内容 = 开始 pull(写 [ce+0x523]=1 后每 20ms 拉 20s)
//   /tmp/voip_hangup.req   写新内容 = 挂断
//   /tmp/voip44_passive.pcm  A 路被动抄到的下行 PCM(格式未知, 先落盘)
//   /tmp/voip44_pull.pcm     B 路 pull 到的下行 PCM
//
// 安全: 不碰 wechat.dylib PAC 禁区; 不用 Stalker; 分配全部 KEEP。
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
function clientState() {
    try {
        return {
            obj: String(CLIENT), initialized: CLIENT.add(0x28).readU8()
        };
    } catch (e) { return { error: String(e) }; }
}

var CONF = Process.enumerateModules().filter(function (m) {
    return m.name.indexOf("ConfSDKdyn") !== -1 && m.size > 100 * 1024;
})[0];
if (!CONF) throw new Error("ConfSDKdyn not found");
var getter = CONF.enumerateExports().filter(function (e) {
    return e.name === "GetWXConfService";
})[0];
var svc = new NativeFunction(getter.address, "pointer", ["int"])(0x1352707);
var dialFn = new NativeFunction(BASE.add("0x1fc07f4"), "int",
    ["pointer", "pointer", "pointer", "pointer", "int", "pointer"]);
var hangupFn = new NativeFunction(svc.readPointer().add(12 * 8).readPointer(), "int",
    ["pointer", "int", "int"]);
// wrapper: int (svc, buf, len, streamId, mode, a5, a6, a7, stackArg)
//   arm64: x0..x7 + 第 9 参上栈(wrapper 里 [sp] 读的就是它)
var getHybrid = new NativeFunction(CONF.base.add("0x7a388"), "int",
    ["pointer", "pointer", "int", "int", "int", "int", "int", "int", "pointer"]);
var getPlay = new NativeFunction(CONF.base.add("0x7a3a8"), "int",
    ["pointer", "pointer", "int", "int", "int", "int", "int", "int", "pointer"]);

function ce() { return svc.add(8).readPointer().add(0xa10); }
function mvOf() { try { return ce().add(8).readPointer(); } catch (e) { return ptr(0); } }
function flags() {
    try {
        var c = ce();
        return {
            ce: String(c), mv: String(mvOf()),
            startTalk: c.add(0x2c).readU32(),
            extStreams: c.add(0x7f4).readU32(),
            extEnable: c.add(0x523).readU8(),
            streamN: c.add(0x474).readU32(),
            gate3f8_0: c.add(0x3f8).readU32(),
            handle400_0: c.add(0x400).readU32(),
            f2010: c.add(0x2010).readU32(),
            f201c: c.add(0x201c).readU32()
        };
    } catch (e) { return { error: String(e) }; }
}

// ---------- A 被动: 挂 mv->vt[97] (0x308/8) 看引擎自己是否在拉 ----------
var passiveFile = null, passiveN = 0;
var vt97Hooked = false;
function hookVt97() {
    if (vt97Hooked) return false;
    var mv = mvOf();
    if (mv.isNull()) return false;
    var fn = mv.readPointer().add(97 * 8).readPointer();
    try {
        Interceptor.attach(fn, {
            onEnter: function (args) {
                this.buf = args[1]; this.len = args[2].toInt32();
            },
            onLeave: function (retval) {
                var r = retval.toInt32();
                passiveN++;
                var nz = -1, nzc = 0;
                try {
                    if (!this.buf.isNull() && this.len > 0 && this.len <= 8192) {
                        var b = new Uint8Array(this.buf.readByteArray(Math.min(this.len, 4096)));
                        for (var i = 0; i < b.length; i++) if (b[i] !== 0) { nzc++; if (nz < 0) nz = i; }
                    }
                } catch (e) { nz = -2; }
                if (passiveN <= 8 || passiveN % 100 === 0) {
                    send({ type: "vt97", n: passiveN, ret: r, len: this.len,
                           firstNz: nz, nonzero: nzc, ts: Date.now() });
                }
                // ret>0 且缓冲有内容: 把 ret 指示的长度落盘(默认按 len 兜底)
                if (r > 0 && nzc > 0 && this.len > 0 && this.len <= 8192) {
                    try {
                        if (passiveFile === null)
                            passiveFile = new File("/tmp/voip44_passive.pcm", "wb");
                        passiveFile.write(this.buf.readByteArray(this.len));
                    } catch (e) { }
                }
            }
        });
        vt97Hooked = true;
        log("vt97 hooked @ " + fn, { mv: String(mv) });
        return true;
    } catch (e) {
        log("vt97 hook 失败(不重试): " + e, { fn: String(fn) });
        vt97Hooked = true; // 防止每秒重试刷屏
        return false;
    }
}

// ---------- B 主动: 写使能位 + 20ms pull ----------
var pulling = false, pullTimer = null;
var pullBuf = null, pullCtx = null, pullFile = null;
var pullCalls = 0, pullRet = null, pullZeros = 0, pullHadData = 0;
var PULL_LEN = 1920, PULL_SECONDS = 30;
function startPull() {
    if (pulling) return;
    var c = ce();
    var mv = mvOf();
    if (mv.isNull()) { log("pull 启动失败: mvqqEngine 为空(未接通?)", flags()); return; }
    // 使能位: 静态 0x4b9a0 显示 +0x523 = (config+0x94 != 0), 普通布尔, 直接写
    try { c.add(0x523).writeU8(1); } catch (e) { log("写 +0x523 失败: " + e); }
    pullBuf = Memory.alloc(8192); KEEP.push(pullBuf);
    pullCtx = Memory.alloc(64); KEEP.push(pullCtx);
    pullBuf.writeByteArray(new Uint8Array(8192));
    pullCtx.writeByteArray(new Uint8Array(64));
    if (pullFile !== null) { try { pullFile.close(); } catch (e) { } }
    try { pullFile = new File("/tmp/voip44_pull.pcm", "wb"); }
    catch (e) { log("pull 文件打不开: " + e); return; }
    pulling = true; pullCalls = 0; pullRet = null; pullZeros = 0; pullHadData = 0;
    var t0 = Date.now(), idx = 0;
    send({ type: "pullStart", flags: flags(), ts: Date.now() });
    function tick() {
        if (!pulling) return;
        if (Date.now() - t0 > PULL_SECONDS * 1000) { stopPull("timeout"); return; }
        var ret = null, err = null, nzc = -1;
        try {
            ret = getHybrid(svc, pullBuf, PULL_LEN, 0, 2, 0, 0, 0, pullCtx);
        } catch (e) { err = String(e); }
        pullCalls++;
        if (ret !== null && ret > 0) {
            try {
                var b = new Uint8Array(pullBuf.readByteArray(PULL_LEN));
                nzc = 0;
                for (var i = 0; i < b.length; i++) if (b[i] !== 0) nzc++;
                if (nzc > 0) {
                    pullHadData++;
                    pullFile.write(pullBuf.readByteArray(PULL_LEN));
                } else pullZeros++;
            } catch (e) { err = "bufread:" + e; }
        }
        if (pullCalls <= 10 || pullCalls % 100 === 0 || String(ret) !== String(pullRet) || err) {
            send({ type: "pull", n: pullCalls, ret: ret, err: err, nonzero: nzc,
                   hadData: pullHadData, zeros: pullZeros, flags: flags(), ts: Date.now() });
        }
        pullRet = ret;
        idx++;
        var deadline = t0 + idx * 20;
        var d = deadline - Date.now();
        if (d > 6) { pullTimer = setTimeout(tick, d - 5); return; }
        while (Date.now() < deadline) { }
        pullTimer = setTimeout(tick, 0);
    }
    tick();
}
function stopPull(reason) {
    if (!pulling) return;
    pulling = false;
    if (pullTimer !== null) { clearTimeout(pullTimer); pullTimer = null; }
    if (pullFile !== null) { try { pullFile.close(); } catch (e) { } pullFile = null; }
    send({ type: "pullStop", reason: reason, calls: pullCalls, hadData: pullHadData,
           zeros: pullZeros, lastRet: pullRet, ts: Date.now() });
}

var lastDial = "", lastCap = "", lastHang = "";
log("=== v44 就绪 ===", { base: String(BASE), conf: String(CONF.base), svc: String(svc),
    client: clientState(), flags: flags() });

// 每秒: 尝试挂 vt97(引擎对象就绪后), 顺带上报门禁旗标变化
var lastFlags = "";
setInterval(function () {
    hookVt97();
    var f = flags();
    var key = JSON.stringify([f.startTalk, f.extStreams, f.extEnable, f.streamN, f.mv]);
    if (key !== lastFlags) {
        lastFlags = key;
        send({ type: "flagsChanged", flags: f, ts: Date.now() });
    }
    var tag = readText("/tmp/voip_uidial.req");
    if (tag && (tag = tag.trim()) && tag !== (lastDial || "")) {
        lastDial = tag;
        var target = (readText("/tmp/voip_target.txt") || "").trim();
        if (!target) { send({ type: "skip", reason: "no target" }); return; }
        var st = clientState();
        if (st.initialized !== 1) {
            send({ type: "skip", reason: "client not initialized; 需先 UI 拨一次", client: st });
            return;
        }
        var cstr = Memory.allocUtf8String(target); KEEP.push(cstr);
        var vec = buildVec(target);
        var ret = null, err = null;
        try { ret = dialFn(CLIENT, cstr, vec, ptr(1), 0, ptr("0x2e6981b3")); }
        catch (e) { err = String(e); }
        send({ type: "dial", wxid: target, ret: ret, err: err, ts: Date.now() });
    }
    var cr = readText("/tmp/voip_cap.req");
    if (cr && (cr = cr.trim()) && cr !== (lastCap || "")) {
        lastCap = cr;
        if (!pulling) startPull();
        else stopPull("re-request");
    }
    var h = readText("/tmp/voip_hangup.req");
    if (h && (h = h.trim()) && h !== (lastHang || "")) {
        lastHang = h;
        stopPull("hangup");
        var hr = null, he = null;
        try { hr = hangupFn(svc, 1, 0); } catch (e) { he = String(e); }
        send({ type: "hangup", ret: hr, err: he, ts: Date.now() });
    }
}, 1000);
