// 探针 v45 — 下行(对方声音)PCM 到底从引擎哪个口流出来: 被动全槽位观测
//
// 依据(probe44 + 静态):
//   - +0x7a388(hybrid pull) 盲调 = access violation 0x780(vt[97] 内部野指针), 不可盲调
//   - +0x7a388/0x7a3a8 在 ConfSDKdyn 内部零调用者 → app 不走这俩 wrapper
//   - 引擎访问器家族 0x4d638/0x4d774/0x4d808… 全是 lock(ce+0x48) → mv->vt[77/86/…] 单参调用
//   - 实测接听瞬间 app 自己写 [ce+0x7f4]=1(外部流使能) → app 在消费外部播放路
//   ⇒ 本探针被动挂 mv vtable 槽位 77..97 + 两个 Get impl(0x65e20/0x66000),
//     一通电话里看哪些槽位在动、缓冲里有没有下行 PCM
//
// 文件:
//   /tmp/voip_uidial.req   写新内容 = 拨号(目标 /tmp/voip_target.txt)
//   /tmp/voip_hangup.req   写新内容 = 挂断
//   /tmp/voip45_slot<N>.pcm  有数据的槽位自动落盘(各上限 2MB)
//
// 安全: 全部 attach-only, 不碰 wechat.dylib PAC 禁区, 分配全 KEEP。
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

function ceAddr() { try { return svc.add(8).readPointer().add(0xa10); } catch (e) { return ptr(0); } }
function mvAddr() { try { return ceAddr().add(8).readPointer(); } catch (e) { return ptr(0); } }
function flags() {
    try {
        var c = ceAddr();
        return { startTalk: c.add(0x2c).readU32(), extStreams: c.add(0x7f4).readU32(),
                 extEnable: c.add(0x523).readU8(), f2010: c.add(0x2010).readU32(),
                 f201c: c.add(0x201c).readU32() };
    } catch (e) { return { error: String(e) }; }
}

// ---------- 被动槽位观测 ----------
var hookedSlots = {};
var slotFiles = {};
var slotCounts = {};
var SLOT_LO = 70, SLOT_HI = 100;   // vt 字节 0x230..0x320 覆盖 0x268/0x2b0/0x308
function hookSlot(slot, fn) {
    try {
        Interceptor.attach(fn, {
            onEnter: function (args) {
                this.slot = slot;
                this.a1 = args[1]; this.a2 = args[2]; this.a3 = args[3];
                slotCounts[slot] = (slotCounts[slot] || 0) + 1;
                var n = slotCounts[slot];
                if (n <= 4 || n % 200 === 0) {
                    send({ type: "vtEnter", slot: slot, n: n,
                           x1: String(this.a1), x2: String(this.a2), x3: String(this.a3),
                           x4: String(args[4]), ts: Date.now() });
                }
            },
            onLeave: function (retval) {
                var r = retval.toInt32();
                var n = slotCounts[this.slot];
                var nz = -1;
                var len = 0;
                try { len = this.a2.toInt32(); } catch (e) { }
                if (len > 32 && len <= 8192 && !this.a1.isNull()) {
                    try {
                        var b = new Uint8Array(this.a1.readByteArray(Math.min(len, 4096)));
                        nz = 0;
                        for (var i = 0; i < b.length; i++) if (b[i] !== 0) nz++;
                    } catch (e) { nz = -2; }
                }
                if (n <= 4 || n % 200 === 0) {
                    send({ type: "vtLeave", slot: this.slot, n: n, ret: r, len: len,
                           nonzero: nz, ts: Date.now() });
                }
                // 可能的 PCM 输出: len 合理 + ret>0 + 缓冲有货 → 落盘
                if (r > 0 && nz > 0 && len > 32 && len <= 8192) {
                    try {
                        var f = slotFiles[this.slot];
                        if (f === undefined) {
                            f = new File("/tmp/voip45_slot" + this.slot + ".pcm", "wb");
                            slotFiles[this.slot] = f;
                        }
                        f.write(this.a1.readByteArray(len));
                    } catch (e) { }
                }
            }
        });
        hookedSlots[slot] = String(fn);
    } catch (e) {
        hookedSlots[slot] = "FAIL:" + e;
    }
}
var vtHooked = false;
function hookVtRange() {
    if (vtHooked) return;
    var mv = mvAddr();
    if (mv.isNull()) return;
    vtHooked = true;
    var vt = mv.readPointer();
    for (var s = SLOT_LO; s <= SLOT_HI; s++) {
        try {
            var fn = vt.add(s * 8).readPointer();
            if (fn.isNull()) continue;
            hookSlot(s, fn);
        } catch (e) { hookedSlots[s] = "FAIL:" + e; }
    }
    log("vt 槽位挂载完成 " + SLOT_LO + ".." + SLOT_HI, { mv: String(mv), slots: hookedSlots });
}
// Get impl 入口(两个, 语义同 wrapper 但 app 可能直调)
[["hybridImpl", "0x65e20"], ["playImpl", "0x66000"]].forEach(function (p) {
    try {
        Interceptor.attach(CONF.base.add(p[1]), {
            onEnter: function (args) {
                this.buf = args[1]; this.len = args[2].toInt32();
                this.mode = args[4].toInt32(); this.sid = args[3].toInt32();
                implCounts[p[0]] = (implCounts[p[0]] || 0) + 1;
                send({ type: "implEnter", fn: p[0], n: implCounts[p[0]], buf: String(this.buf),
                       len: this.len, sid: this.sid, mode: this.mode, ts: Date.now() });
            },
            onLeave: function (retval) {
                var r = retval.toInt32();
                send({ type: "implLeave", fn: p[0], n: implCounts[p[0]], ret: r, ts: Date.now() });
            }
        });
        log("impl hooked: " + p[0] + " @ " + CONF.base.add(p[1]));
    } catch (e) { log("impl hook 失败: " + p[0] + " " + e); }
});
var implCounts = {};

log("=== v45 就绪(全被动) ===", { base: String(BASE), conf: String(CONF.base), svc: String(svc),
    flags: flags() });

var lastFlags = "";
setInterval(function () {
    hookVtRange();
    var f = flags();
    var key = JSON.stringify(f);
    if (key !== lastFlags) {
        lastFlags = key;
        send({ type: "flagsChanged", flags: f, mv: String(mvAddr()), ts: Date.now() });
    }
    var tag = readText("/tmp/voip_uidial.req");
    if (tag && (tag = tag.trim()) && tag !== lastDial) {
        lastDial = tag;
        var target = (readText("/tmp/voip_target.txt") || "").trim();
        if (!target) { send({ type: "skip", reason: "no target" }); return; }
        var init = CLIENT.add(0x28).readU8();
        if (init !== 1) { send({ type: "skip", reason: "client not initialized", init: init }); return; }
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
        var hr = null, he = null;
        try { hr = hangupFn(svc, 1, 0); } catch (e) { he = String(e); }
        send({ type: "hangup", ret: hr, err: he, ts: Date.now() });
    }
}, 1000);
var lastDial = "", lastHang = "";
