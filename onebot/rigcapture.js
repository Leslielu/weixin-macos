
// ================= RIGCAPTURE v3 (2026-10-07) 语音数据源 probe =================
// v2 教训: 虚表槽经 thunk (sub x0,#8) 进入真身, 过滤须放行 freshT 和 freshT-8。
// v3 新增: CModule probe 数据源对象(环形日志, 零 C 全局写) + triggerUploadVoice 接管
// (worker.go 已改为传 silk hex 的内存式签名)。会话内参数控制走 /tmp/rig_probe_cmd.json
// (JS 每次发送前读, {mode:N}); shell 改文件即可换模式, 无需重载脚本。
// 铁律: 引擎 mmap 闭包池只读不 hook (v1 SIGBUS 教训); 一切 native 回调 = CModule (铁律4)。

var rigVoiceWindow = false;
var rigFreshT = null;
var rigHookedStatic = {};
var rigLogCount = 0;
var rigProbe = null;          // {T, CB, vtable, ringPtr, headPtr, cm}
var rigRingTail = 0;
var rigRingTimer = null;

function rigLog(s) {
    rigLogCount++;
    if (rigLogCount <= 500) console.log("[RIGCAP3] " + s);
}

function rigHex(addr, len) {
    try {
        var b = new Uint8Array(addr.readByteArray(len));
        var s = "";
        for (var i = 0; i < b.length; i++) { var t = b[i].toString(16); s += (t.length < 2 ? "0" : "") + t; }
        return s;
    } catch (e) { return "ERR:" + e; }
}

function rigModOff(a) {
    try {
        var m = Process.findModuleByAddress(a);
        if (m) return m.name + "+0x" + a.sub(m.base).toString(16);
    } catch (e) {}
    return null;
}

// ---------- 静态虚表成员 hook (原生录音 ground truth; 过滤 x0 ∈ {T, T-8}) ----------
var RIG_VTABLE_FNS = [
    [0x429e4fc, "vt+0x10.GetCallbackWrapper"],
    [0x429e898, "vt+0x38.primary"],
    [0x429ec3c, "vt+0x18.real"],
    [0x42a01b8, "vt+0x20.real"],
    [0x429ffd0, "vt+0x28.real"],
    [0x429fa1c, "vt+0x40.primary"],
];

function rigArmStaticVtableHooks() {
    RIG_VTABLE_FNS.forEach(function (ent) {
        var off = ent[0], tag = ent[1];
        var key = "" + off;
        if (rigHookedStatic[key]) return;
        rigHookedStatic[key] = true;
        try {
            var addr = baseAddr.add(off);
            Interceptor.attach(addr, {
                onEnter: function (args) {
                    if (!rigVoiceWindow || !rigFreshT) return;
                    var s = args[0].toString();
                    var hit = (s === "" + rigFreshT) || (s === "" + rigFreshT.sub(8));
                    if (!hit) return;
                    this._go = true;
                    var bt = [];
                    try {
                        var fr = Thread.backtrace(this.context, Backtracer.ACCURATE).slice(0, 5);
                        for (var i = 0; i < fr.length; i++) bt.push(rigModOff(fr[i]) || ("" + fr[i]));
                    } catch (e1) {}
                    rigLog("NATIVE " + tag + " this=" + args[0] + " x1=" + args[1] + " x2=" + args[2] +
                        " x3=" + args[3] + " bt=[" + bt.join(", ") + "]");
                    this._x2 = args[2];
                    this._x3 = args[3];
                },
                onLeave: function (ret) {
                    if (!this._go) return;
                    var extra = "";
                    try { extra += " x2[0x20]=" + rigHex(this._x2, 0x20); } catch (e2) {}
                    try { extra += " x3[0x20]=" + rigHex(this._x3, 0x20); } catch (e3) {}
                    rigLog("NATIVE " + tag + " ret rv=0x" + ret + extra);
                }
            });
            rigLog("static hook armed " + tag + " @ " + addr);
        } catch (e) {
            rigLog("static hook FAIL " + tag + ": " + e);
        }
    });
}

function rigArmBinderHook() {
    try {
        var binder = baseAddr.add(0x31df8ac);
        Interceptor.attach(binder, {
            onEnter: function (args) {
                this._task = args[1];
                try { this._isVoice = this._task.add(0x9C).readU8() === 0x0F; } catch (e) { this._isVoice = false; }
            },
            onLeave: function (ret) {
                if (!this._isVoice) return;
                var t = this._task;
                var f1 = t.add(0x0).readPointer();
                var f2 = t.add(0x8).readPointer();
                console.log("[RIGCAP3] binder onLeave: freshT=" + f1 + " freshCB=" + f2 +
                    " T[0x60]=" + rigHex(f1, 0x60) + " CB[0x28]=" + rigHex(f2, 0x28));
                rigFreshT = f1;
                // v3.3: 全量 T(0x3F8) + 数据队列 P([T+0x190] 指向对象 0x100)
                try {
                    console.log("[RIGCAP3] T-full[0x3F8]=" + rigHex(f1, 0x3F8));
                    var P = f1.add(0x188).readPointer();
                    if (!P.isNull()) console.log("[RIGCAP3] P=" + P + " P[0x100]=" + rigHex(P, 0x100));
                } catch (e5) {}
                rigVoiceWindow = true;
                setTimeout(function () { rigVoiceWindow = false; }, 90 * 1000);
            }
        });
        rigLog("binder hook armed @ " + binder);
    } catch (e) {
        console.error("[RIGCAP3] binder hook fail: " + e);
    }
}

// ---------- probe 数据源对象 ----------
// self 布局(T): +0x00 vtable | +0x08 T-8 | +0x10 CB | +0x28 常量标记
//   | +0x40 ringPtr | +0x48 headPtr | +0x50 mode | +0x58 silkPtr | +0x60 silkLen | +0x68 readPos
// vtable: slot_i @ i*8 (i=0..9); 引擎虚分发 [T]->[vt+off]; thunk 后 x0=T(无调整, 我们自建无 thunk)。
// serve 契约A (mode&1, slot3/vt+0x18): a1=destBuf, a2=writtenLenPtr → 复制 min(3600,剩余) 返回字节数
// serve 契约B (mode&2, slot5/vt+0x28): a2=destBuf, a3=writtenLenPtr → 同上
var RIG_PROBE_C = [
    "typedef struct { unsigned long seq, slot, a0, a1, a2, a3; } RingEnt;",
    "#define RING_N 64",
    "static void rput(void *self, unsigned long slot, unsigned long a1, unsigned long a2, unsigned long a3) {",
    "  RingEnt *ring = *(RingEnt **)((char *)self + 0x40);",
    "  unsigned long *head = *(unsigned long **)((char *)self + 0x48);",
    "  if (!ring || !head) return;",
    "  unsigned long h = *head;",
    "  *head = h + 1UL;",
    "  RingEnt *e = &ring[h & (RING_N - 1)];",
    "  e->seq = h; e->slot = slot; e->a0 = (unsigned long)self; e->a1 = a1; e->a2 = a2; e->a3 = a3;",
    "}",
    "static unsigned long serve(void *self, unsigned long dstPtr, unsigned long lenPtr) {",
    "  unsigned long mode = *(unsigned long *)((char *)self + 0x50);",
    "  if (!mode || !dstPtr) return 0;",
    "  unsigned char *src = *(unsigned char **)((char *)self + 0x58);",
    "  unsigned long len = *(unsigned long *)((char *)self + 0x60);",
    "  unsigned long *pos = (unsigned long *)((char *)self + 0x68);",
    "  unsigned long remain = (len > *pos) ? (len - *pos) : 0;",
    "  unsigned long n = remain < 3600UL ? remain : 3600UL;",
    "  unsigned char *dst = (unsigned char *)dstPtr;",
    "  for (unsigned long i = 0; i < n; i++) dst[i] = src[*pos + i];",
    "  *pos += n;",
    "  if (lenPtr) *(unsigned long *)lenPtr = n;",
    "  return n;",
    "}",
    "unsigned long rs0(void *s, unsigned long a, unsigned long b, unsigned long c, unsigned long d) { rput(s,0,a,b,c); return 0; }",
    "unsigned long rs1(void *s, unsigned long a, unsigned long b, unsigned long c, unsigned long d) { rput(s,1,a,b,c); return 0; }",
    "unsigned long rs2(void *s, unsigned long a, unsigned long b, unsigned long c, unsigned long d) { rput(s,2,a,b,c); return 0; }",
    "unsigned long rs3(void *s, unsigned long a, unsigned long b, unsigned long c, unsigned long d) { rput(s,3,a,b,c); if (*(unsigned long *)((char *)s + 0x50) & 1UL) return serve(s, a, b); return 0; }",
    "unsigned long rs4(void *s, unsigned long a, unsigned long b, unsigned long c, unsigned long d) { rput(s,4,a,b,c); return 0; }",
    "unsigned long rs5(void *s, unsigned long a, unsigned long b, unsigned long c, unsigned long d) { rput(s,5,a,b,c); if (*(unsigned long *)((char *)s + 0x50) & 2UL) return serve(s, b, c); return 0; }",
    "unsigned long rs6(void *s, unsigned long a, unsigned long b, unsigned long c, unsigned long d) { rput(s,6,a,b,c); return 0; }",
    "unsigned long rs7(void *s, unsigned long a, unsigned long b, unsigned long c, unsigned long d) { rput(s,7,a,b,c); return 0; }",
    "unsigned long rs8(void *s, unsigned long a, unsigned long b, unsigned long c, unsigned long d) { rput(s,8,a,b,c); return 0; }",
    "unsigned long rs9(void *s, unsigned long a, unsigned long b, unsigned long c, unsigned long d) { rput(s,9,a,b,c); return 0; }",
    "void rdtor(void *s) { rput(s, 99, 0, 0, 0); }",
].join("\n");

function rigZero(addr, n) {
    var z = [];
    for (var i = 0; i < n; i++) z.push(0);
    addr.writeByteArray(z);
}

function rigStep(n, fn) { try { fn(); rigLog("bp " + n + " ok"); } catch (e) { rigLog("bp " + n + " FAIL: " + e); throw e; } }
function rigBuildProbe() {
    if (rigProbe) return rigProbe;
    rigStep("cm", function () { rigProbe = { cm: new CModule(RIG_PROBE_C) }; });
    var cm = rigProbe.cm;
    var vtable = null;
    rigStep("vtable", function () {
        vtable = Memory.alloc(0x50);
        rigZero(vtable, 0x50);
        for (var i = 0; i < 10; i++) {
            vtable.add(i * 8).writePointer(cm["rs" + i]);
        }
    });
    var dtorVt = null, CB = null, Treal = null, T = null;
    rigStep("dtorVt+CB", function () {
        dtorVt = Memory.alloc(0x20);
        rigZero(dtorVt, 0x20);
        dtorVt.add(0x10).writePointer(cm.rdtor);
        CB = Memory.alloc(0x40);
        rigZero(CB, 0x40);
        CB.writePointer(dtorVt);
        CB.add(0x08).writeU64(1);          // refcount (binder 每次 ldadd+1)
        CB.add(0x10).writeU64(777);        // counter 字段
        CB.add(0x18).writePointer(cm.rdtor);
    });
    rigStep("T", function () {
        // ★ 原生对象实为 0x3F8 字节(析构常量实证); 0x80 分配导致引擎写 [T+0x188]
        //   越界 0x110 字节, 踩坏 frida 分配器 → gadget 内部崩溃(15:38 实锤)
        Treal = Memory.alloc(0x400);
        rigZero(Treal, 0x400);
        T = Treal.add(8);
        T.writePointer(vtable);            // T+0x00 vptr
        T.add(0x08).writePointer(Treal);   // T+0x08 = T-8 (原生同构)
        T.add(0x10).writePointer(CB);      // T+0x10 = cb (原生同构)
        T.add(0x28).writeU64(0x32aaaba7);  // 原生常量标记
    });
    var ringPtr = null, headPtr = null;
    rigStep("ring", function () {
        ringPtr = Memory.alloc(64 * 48);
        rigZero(ringPtr, 64 * 48);
        headPtr = Memory.alloc(8);
        headPtr.writeU64(0);
        T.add(0x40).writePointer(ringPtr);
        T.add(0x48).writePointer(headPtr);
    });
    rigStep("P", function () {
    // v3.4: 数据队列 P(原生 [T+0x188] 指向; mars 标签同步对象 0x60 快照照抄)
    // +0x00 MUTZ | +0x0c cursorA | +0x20 MUTZ | +0x30 -1 | +0x38 {0x9c1a267f,-2}
    // +0x40 MUTX(0x6d963ac 锁/校验对象) | +0x54 cursorB | +0x58 MUTX
    var P = Memory.alloc(0x100);
    rigZero(P, 0x100);
    P.writeU32(0x4d55545a);              // MUTZ @+0x00
    P.add(0x20).writeU32(0x4d55545a);    // MUTZ @+0x20
    P.add(0x30).writeU64(uint64("0xffffffffffffffff"));
    P.add(0x38).writeU32(0x9c1a267f);
    P.add(0x3c).writeU32(0xfffffffe);
    P.add(0x40).writeU32(0x4d555458);    // MUTX @+0x40
    P.add(0x58).writeU32(0x4d555458);    // MUTX @+0x58
    T.add(0x188).writePointer(P);        // ★ 原生同位: [T+0x188] = P
    });
    CB.add(0x20).writePointer(T);
    rigProbe = { T: T, CB: CB, cm: cm, ringPtr: ringPtr, headPtr: headPtr, Treal: Treal };
    rigLog("probe built: T=" + T + " CB=" + CB + " vtable=" + vtable + " ring=" + ringPtr);
    return rigProbe;
}

function rigPollRing() {
    if (!rigProbe) return;
    try {
        var head = Number(rigProbe.headPtr.readU64());
        var guard = 0;
        while (rigRingTail < head && guard < 80) {
            guard++;
            var idx = rigRingTail & 63;
            var e = rigProbe.ringPtr.add(idx * 48);
            var seq = Number(e.readU64());
            if (seq !== rigRingTail) { rigRingTail = seq; continue; }
            var slot = Number(e.add(8).readU64());
            var a0 = e.add(16).readPointer();
            var a1 = e.add(24).readPointer();
            var a2 = e.add(32).readPointer();
            var a3 = e.add(40).readPointer();
            console.log("[RIGPROBE] slot=" + slot + " self=" + a0 + " a1=" + a1 + " a2=" + a2 + " a3=" + a3 +
                (slot === 99 ? " (DESTROY)" : ""));
            rigRingTail++;
        }
    } catch (e) {}
}

// 会话内参数控制: 每次发送前读 /tmp/rig_probe_cmd.json {mode:N}
function rigReadCmd() {
    try {
        var f = new File("/tmp/rig_probe_cmd.json", "r");
        var s = f.read();
        f.close();
        return JSON.parse(s);
    } catch (e) { return { mode: 0 }; }
}

// ---------- triggerUploadVoice 接管 (worker.go 已改为内存式签名调它) ----------
// 签名: (receiver, voicePath, payloadHex, audioDataHex, durationMs, selfIdMd5)
function triggerUploadVoice(receiver, voicePath, payloadHex, audioDataHex, durationMs, selfIdMd5) {
    var cmd = rigReadCmd();
    var mode = (cmd && cmd.mode) ? cmd.mode : 0;
    rigLog("send invoked: receiver=" + receiver + " mode=" + mode +
        " audioHexLen=" + (audioDataHex ? audioDataHex.length : 0));

    if (uploadGlobalX0.equals(ptr(0))) { ensureCdnManagerX0(); }
    if (uploadGlobalX0.equals(ptr(0))) {
        console.error("[!] uploadGlobalX0 尚未初始化");
        return "fail";
    }
    var probe = rigBuildProbe();

    voiceDurationGlobal = durationMs;
    var payload = hexToByteArray(payloadHex);
    var audioBytes = hexToByteArray(audioDataHex);
    var audioLen = audioBytes.length;
    voiceSilkDataLenGlobal = audioLen;
    voiceAudioDataAddr.writeByteArray(audioBytes);

    voiceUploadSeq = voiceUploadSeq + 1;
    var voiceIdStr = "alita_1_" + selfIdMd5 + "_15_0_" + voiceUploadSeq;
    patchString(voiceIdAddr, voiceIdStr);

    uploadVoiceX1.writeByteArray(payload);
    // ★ probe pair: T + CB (替代 uploadFunc1/2 / 原生回调对)
    uploadVoiceX1.writePointer(probe.T);
    uploadVoiceX1.add(0x08).writePointer(probe.CB);
    uploadVoiceX1.add(0x48).writePointer(voiceIdAddr);
    uploadVoiceX1.add(0x50).writeU64(voiceIdStr.length);
    uploadVoiceX1.add(0x58).writeU64(uint64("0x8000000000000000").add(voiceIdStr.length + 1));
    uploadVoiceX1.add(0x68).writeUtf8String(receiver);
    uploadVoiceX1.add(0x7F).writeU8(receiver.length);
    // 0xD8 / 0x100 三连 (内存式原版同构)
    uploadVoiceX1.add(0xD8).writeU64(0);
    uploadVoiceX1.add(0xD8).writeU32(audioLen);
    uploadVoiceX1.add(0xDC).writeU32(Math.ceil(audioLen / 2));
    uploadVoiceX1.add(0x100).writePointer(voiceAudioDataAddr);
    uploadVoiceX1.add(0x108).writeU64(audioLen);
    uploadVoiceX1.add(0x110).writeU64(uint64("0x8000000000000000").add(Math.ceil(audioLen / 16) * 16));

    // probe serve 参数 (engine 线程的 C stub 直接读)
    probe.T.add(0x50).writeU64(mode);
    // v3.4: P 游标置全长 (泵的 have>=need 检查直接通过)
    var probeP = probe.T.add(0x188).readPointer();
    if (!probeP.isNull()) {
        probeP.add(0x0c).writeU32(audioLen);
        probeP.add(0x54).writeU32(audioLen);
        rigLog("P cursors set to " + audioLen + " @ " + probeP);
    }
    probe.T.add(0x58).writePointer(voiceAudioDataAddr);
    probe.T.add(0x60).writeU64(audioLen);
    probe.T.add(0x68).writeU64(0);

    var startUploadMedia = new NativeFunction(uploadImageAddr, 'int64', ['pointer', 'pointer']);
    voiceUploadSelfTest = true;
    rigRingTail = 0;
    probe.headPtr.writeU64(0);
    try {
        var rv = startUploadMedia(uploadGlobalX0, uploadVoiceX1);
        rigLog("startUploadMedia rv=" + rv + " fileId=" + voiceIdStr + " audioLen=" + audioLen);
        return "0";
    } catch (eSend) {
        console.error("[!] startUploadMedia err: " + eSend);
        return "fail";
    } finally {
        voiceUploadSelfTest = false;
    }
}

// baseAddr 就绪后统一挂载 (ring 轮询单一定时器)
(function rigWaitBase() {
    if (baseAddr && !baseAddr.isNull()) {
        rigArmStaticVtableHooks();
        rigArmBinderHook();
        if (!rigRingTimer) {
            rigRingTimer = setInterval(rigPollRing, 250);
        }
        rigLog("v3 ready (probe lazy-build on first send)");
    } else {
        setTimeout(rigWaitBase, 50);
    }
})();
// =================== RIGCAPTURE v3 END ===================

// ================= v3.1: TryMultiphase 强制旧路 =================
// 依据: TryMultiphase(0x574c0c4) 语义 — type2→false / type8→true / 0x9C∈{7,9,0x4EEA,0x4F4E}→true /
// 其余(voice 0x0F/img/video)落长判定树。强制对 0x9C==0x0F 返回 false:
//   inner(0x575ce88)→0x575cf10: +0x40==1 → 0x575d210 → 0x58c3b44(mgr,task,1,flag) = 第三旧路
//   wrapper(0x575c1b4)→0x575c36c = wrapper 级旧路
// 目标: 走 4.1.10 时代 uploadvoice(cmdid 19) CGI 直传流(旁人旧版验证可用的自包含路径)。
var rigForceLegacy = false;
var rigForceLegacyArmed = false;

function rigArmForceLegacy() {
    if (rigForceLegacyArmed) return;
    rigForceLegacyArmed = true;
    try {
        Interceptor.attach(baseAddr.add(0x574c0c4), {
            onEnter: function (args) {
                this._voice = false;
                try { this._voice = args[0].add(0x9C).readU8() === 0x0F; } catch (e) {}
            },
            onLeave: function (ret) {
                if (this._voice && rigForceLegacy) {
                    rigLog("TryMultiphase voice → forced false (was " + ret + ")");
                    ret.replace(0);
                }
            }
        });
        // 旧路 handler 观察点(只读): 确认引擎真的走进去了
        Interceptor.attach(baseAddr.add(0x58c3b44), {
            onEnter: function (args) {
                rigLog("LEGACY handler 0x58c3b44 entered: mgr=" + args[0] + " task=" + args[1] +
                    " w2=" + args[2] + " w3=" + args[3]);
            }
        });
        Interceptor.attach(baseAddr.add(0x58c9124), {
            onEnter: function (args) {
                rigLog("LEGACY handler 0x58c9124 entered: mgr=" + args[0] + " task=" + args[1] + " w2=" + args[2]);
            }
        });
        rigLog("force-legacy hooks armed");
    } catch (e) {
        console.error("[RIGCAP3] force-legacy arm fail: " + e);
    }
}

// triggerUploadVoice 开头读 cmd.forceLegacy
(function () {
    var origReadCmd = rigReadCmd;
    rigReadCmd = function () {
        var c = origReadCmd();
        rigForceLegacy = !!(c && c.forceLegacy);
        return c;
    };
})();

// baseAddr 就绪后补挂
(function rigWaitBase2() {
    if (baseAddr && !baseAddr.isNull()) {
        rigArmForceLegacy();
    } else {
        setTimeout(rigWaitBase2, 50);
    }
})();

// ================= v3.2: legacy 完成事件直发（绕过锚扫描） =================
// force-legacy 的完成结构布局已由 VOICEDUMP 抓实: fileId@0x28 / target@0x48 /
// cdn@0x68 / aes@0x80 / md5@0x98（与 c2c 引擎侧布局同族）。v3 锚扫描在该结构上
// 未命中（fidOff<0，原因未明），这里叠加第二 hook 按固定布局直读直发。
// 门: fileId 精确等于 voiceIdAddr 当前内容 + alita 格式 + 每 id 只发一次。
var rigLegacyFired = "";
var rigLegacyHookArmed = false;

function rigArmLegacyCompletion() {
    if (rigLegacyHookArmed) return;
    rigLegacyHookArmed = true;
    try {
        Interceptor.attach(cndOnCompleteAddr, {
            onEnter: function (args) {
                try {
                    var x2 = args[2];
                    var fid = v3ReadStr(x2, 0x28);
                    if (!fid || fid === rigLegacyFired) return;
                    if (!/^alita_1_[0-9a-f]{32}_15_0_\d+$/.test(fid)) return;
                    if (fid !== voiceIdAddr.readUtf8String()) return;
                    var target = v3ReadStr(x2, 0x48);
                    var cdn = v3ReadStr(x2, 0x68);
                    var aes = v3ReadStr(x2, 0x80);
                    var md5 = v3ReadStr(x2, 0x98);
                    if (!cdn || cdn.length < 8 || !aes || !/^[0-9a-f]{32}$/.test(aes)) {
                        rigLog("LEGACY completion keys not ready: cdn=" + cdn + " aes=" + aes);
                        return;
                    }
                    rigLegacyFired = fid;
                    rigLog("LEGACY completion OK: fid=" + fid + " target=" + target +
                        " cdn=" + cdn + " aes=" + aes + " md5=" + md5);
                    send({
                        type: "upload_voice_finish",
                        target_id: target,
                        cdn_key: cdn,
                        aes_key: aes,
                        voice_duration: voiceDurationGlobal,
                        silk_data_len: voiceSilkDataLenGlobal
                    });
                    rigLog("upload_voice_finish sent to Go (legacy path)");
                } catch (e) {
                    console.error("[RIGCAP3] legacy completion err: " + e);
                }
            }
        });
        rigLog("legacy completion hook armed @ " + cndOnCompleteAddr);
    } catch (e) {
        console.error("[RIGCAP3] legacy completion arm fail: " + e);
    }
}

(function rigWaitBase3() {
    if (baseAddr && !baseAddr.isNull()) {
        rigArmLegacyCompletion();
    } else {
        setTimeout(rigWaitBase3, 50);
    }
})();

// ================= v3.3: 数据队列 P 全量捕获 =================
// 理论: worker(0x62c9ee0 线程) = 上传泵; 0x248aaac(T+0x188,...) = 泵内"等下一片";
// [T+0x190] = P(录音编码器→上传器数据队列), 0xdb84d8(P) = &P->0x40(锁)。
// 崩因 = 假 T 的 [T+0x190]=0。本轮目标: 原生录音时抓全量 T(0x3F8) + P(0x100)
// + 0x248aaac 的进出参数与 P 字段变化, 照抄构造假 P。
var rigPDumped = false;

var RIG_SYNC_C = [
    "unsigned long rig_sync_probe(unsigned long a, unsigned long b, unsigned long c, unsigned long d) { return 0; }",
].join("\n");

function rigArmSyncTrace() {
    try {
        Interceptor.attach(baseAddr.add(0x248aaac), {
            onEnter: function (args) {
                var t = args[0].sub(0x188);   // 0x248aaac 的 x0 = T+0x188
                var p = ptr(0);
                try { p = t.add(0x190).readPointer(); } catch (e) {}
                rigLog("SYNC enter T+0x188=" + args[0] + " T=" + t + " P=" + p +
                    " x1=" + args[1] + " x2=" + args[2] + " x3=" + args[3]);
                if (!p.isNull()) {
                    try {
                        rigLog("SYNC P[0x60]=" + rigHex(p, 0x60) +
                            " lock40=" + rigHex(p.add(0x40), 8));
                    } catch (e2) {}
                }
                this._p = p;
                this._t = t;
            },
            onLeave: function (ret) {
                rigLog("SYNC leave rv=0x" + ret);
                try {
                    if (!this._p.isNull()) rigLog("SYNC P after[0x60]=" + rigHex(this._p, 0x60));
                } catch (e) {}
            }
        });
        rigLog("sync trace armed @ 0x248aaac(+base)");
    } catch (e) { console.error("[RIGCAP3] sync trace fail: " + e); }
}

(function rigWaitBase4() {
    if (baseAddr && !baseAddr.isNull()) {
        rigArmSyncTrace();
        // binder onLeave 的 T dump 扩到 0x3F8 + P 顺藤(在原 binder hook 内已读 T+0x190)
        rigLog("v3.3 ready");
    } else {
        setTimeout(rigWaitBase4, 50);
    }
})();
