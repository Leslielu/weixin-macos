// VoIP 通话链路发现探针 v2
// v1 结论: 信令不走 mars(心跳), 音频引擎在 wechat.dylib 0x546e000-0x5475000
// 本轮目标:
//   1. ilink 信令出口 hook + backtrace → 倒推 ILinkVOIPService 函数
//   2. NSWindow 创建锚点 → 主线程 UI 呼叫链(若 mmui 用独立 NSWindow)
//   3. onPush 参数读取修正(抄生产: x4=AutoBuffer, x3=cmdid) → 来电/挂断推送
//   4. 音频引擎起停 beacon(0x5470688/0x547070c) 保留时间轴

var REAL_MOD = Process.enumerateModules().filter(function (m) {
    return /wechat\.dylib/i.test(m.name) && m.size > 100 * 1024 * 1024;
})[0];
var BASE = REAL_MOD.base;

function log(s) { send({ type: "log", msg: s }); }
function bt(ctx, tag, maxFrames) {
    try {
        var frames = Thread.backtrace(ctx, Backtracer.FUZZY).map(DebugSymbol.fromAddress);
        if (maxFrames) frames = frames.slice(0, maxFrames);
        send({ type: "bt", tag: tag, frames: frames.map(String) });
    } catch (e) { log("bt fail " + tag + " " + e); }
}

var counters = {};
function allow(key, max) {
    counters[key] = (counters[key] || 0) + 1;
    return counters[key] <= max;
}

log("base = " + BASE);

// std::string (libc++) 读取
function readStdStr(p) {
    try {
        var cap = p.add(0x18).readU64();   // __cap_ (低1位是long标记)
        var isLong = (cap & 1) === 1;
        if (isLong) {
            var data = p.readPointer();
            var size = p.add(0x10).readU64();
            if (size > 0 && size < 65536) return { hex: hexdump(data, { length: Math.min(size, 512) }), size: size };
        } else {
            var size2 = p.add(0x10).readU8() >> 1;
            if (size2 > 0) return { str: p.readUtf8String(size2), size: size2 };
        }
    } catch (e) { }
    return null;
}

// ---------- 1. ilink2 信令发送 ----------
// ilink2 符号不在导出 trie(重签名副作用), 按 nm 偏移手动定位
var ILINK2_OFFSETS = {
    "ilinkSendReq(NoPB)": "0x3030",
    "ilinkSendReq(PB)": "0x2550",
    "CloudCgiReq": "0x38e8"
};
function hookExport(label, dumpStrArg) {
    try {
        var ilink2Mod = Process.enumerateModules().filter(function (m) {
            return m.name === "ilink2" && m.size > 1024 * 1024;
        })[0];
        if (!ilink2Mod) throw new Error("ilink2 大实例未找到");
        var addr = ilink2Mod.base.add(ILINK2_OFFSETS[label]);
        Interceptor.attach(addr, {
            onEnter: function (a) {
                if (!allow(label, 30)) return;
                send({ type: "hit", hook: label });
                if (dumpStrArg) {
                    var s = readStdStr(a[1]);
                    if (s) send({ type: "str", hook: label, val: s.str || s.hex, size: s.size });
                }
                bt(this.context, label, 24);
            }
        });
        log("[+] hooked " + label);
    } catch (e) { log("[-] " + label + ": " + e.message); }
}
hookExport("ilinkSendReq(NoPB)", true);
hookExport("ilinkSendReq(PB)", false);
hookExport("CloudCgiReq", false);

// ---------- 2. ilink_stream 通道生命周期 ----------
["ZidlDart_IlinkStreamChannel_Create", "ZidlDart_IlinkStreamChannel_CreateStream",
    "ZidlDart_IlinkStreamChannel_CreateUpStream", "ZidlDart_IlinkStreamChannel_CreateDownStream",
    "ZidlDart_IlinkStreamChannel_SendStreamFragment", "ZidlDart_IlinkStreamChannel_DestroyStream",
    "ZidlDart_IlinkStreamChannel_UpdateSessionInfo", "ZidlDart_IlinkStreamChannel_WarmUp"
].forEach(function (s) {
    try {
        var addr = Module.getGlobalExportByName(s);
        Interceptor.attach(addr, {
            onEnter: function (a) {
                if (!allow(s, 40)) return;
                send({ type: "hit", hook: s, args: [a[0] + "", a[1] + "", a[2] + ""] });
                bt(this.context, s, 20);
            }
        });
        log("[+] hooked " + s);
    } catch (e) { log("[-] " + s + ": " + e.message); }
});

// ---------- 3. 窗口创建锚点 (窗口服务器层 C 符号, 不依赖 ObjC 桥) ----------
["CGSNewWindow", "CGSSetWindowLevel", "_CGSDefaultConnection"].forEach(function (s) {
    try {
        var addr = Module.getGlobalExportByName(s);
        if (!addr || addr.isNull()) return;
        if (s === "_CGSDefaultConnection") return; // 只要前两个
        Interceptor.attach(addr, {
            onEnter: function (a) {
                if (!allow(s, 12)) return;
                send({ type: "hit", hook: s });
                bt(this.context, s, 24);
            }
        });
        log("[+] hooked " + s);
    } catch (e) { log("[-] " + s + ": " + e.message); }
});

// ---------- 4. onPush 修正版 (抄生产 script.js 的裸读逻辑) ----------
var MAX_FRIDA_MESSAGE_BYTES = 20 * 1024 * 1024;
var pushCount = 0;
try {
    Interceptor.attach(BASE.add("0x59b0e94"), {
        onEnter: function () {
            try {
                var ab = this.context.x4;
                var D = ab.readPointer();
                var dataPtr = D.readPointer();
                var dataLen = D.add(0xc).readU32();
                if (dataLen < 4 || dataLen > 1024 * 1024) return;
                pushCount++;
                var mem = dataPtr.readByteArray(Math.min(dataLen, 4096));
                send({
                    type: "push", cmdid: String(this.context.x3), len: String(dataLen),
                    hex: mem ? Array.from(new Uint8Array(mem)).map(function (b) {
                        return ("0" + b.toString(16)).slice(-2);
                    }).join("") : null
                });
            } catch (e) { }
        }
    });
    log("[+] hooked onPush (fixed)");
} catch (e) { log("[-] onPush: " + e.message); }

// ---------- 5. 音频引擎起停 beacon ----------
[["0x5470688", "audioEngineStart"], ["0x547070c", "audioEngineStop"]].forEach(function (p) {
    try {
        Interceptor.attach(BASE.add(p[0]), {
            onEnter: function () {
                if (!allow(p[1], 10)) return;
                send({ type: "hit", hook: p[1], this: String(this.context.x0) });
                bt(this.context, p[1], 20);
            }
        });
        log("[+] hooked " + p[1]);
    } catch (e) { log("[-] " + p[1] + ": " + e.message); }
});

log("=== 探针v2就绪: 请再发起一次语音通话(响几秒挂断), 然后用另一台设备打回来一次 ===");
