// VoIP 通话链路发现探针 v1
// 目标: 用户手点「语音通话」时, 抓取从 UI 到 ConfSDK 的调用链 + 信令 protobuf
// 锚点策略:
//   1. 具名导出符号 (ConfSDKdyn / CoreAudio) — 版本无关
//   2. 生产 JSON 已知地址 (本副本=4.1.13.63 与生产同版本, 直接可用):
//      req2bufEnter/onPush/respDispatch — 看 VoipAdd/VoipAck 信令是否走 mars
//   3. 全部命中点带 FUZZY backtrace, 帧=wechat.dylib!0x偏移 可直接对回 IDA

var BASE = null;
var REAL_MOD = null;
(function () {
    var cands = Process.enumerateModules().filter(function (m) {
        return /wechat\.dylib/i.test(m.name) && m.size > 100 * 1024 * 1024;
    });
    if (cands.length > 0) {
        REAL_MOD = cands[0];
        BASE = REAL_MOD.base;
    }
})();

function log(s) { send({ type: "log", msg: s }); }
function bt(ctx, tag) {
    try {
        var frames = Thread.backtrace(ctx, Backtracer.FUZZY).map(DebugSymbol.fromAddress);
        send({ type: "bt", tag: tag, frames: frames.map(String) });
    } catch (e) { log("bt fail " + tag + " " + e); }
}

log("wechat.dylib base = " + BASE);

// ---------- 模块清单 ----------
var mods = [];
Process.enumerateModules().forEach(function (m) {
    if (/wechat|Conf|ilink|MultiMedia|vlc/i.test(m.name)) {
        mods.push(m.name + "  " + m.base + "  " + m.size);
    }
});
log("modules:\n" + mods.join("\n"));

// ---------- 限流 ----------
var counters = {};
function allow(key, max) {
    counters[key] = (counters[key] || 0) + 1;
    return counters[key] <= max;
}

// ---------- 通用 hook ----------
function findExport(modName, sym) {
    try {
        if (modName) {
            var m = Process.enumerateModules().find(function (x) {
                return x.name === modName || (x.name + ".framework/" + x.name) === modName;
            });
            if (m && typeof m.getExportByName === "function") {
                return m.getExportByName(sym);
            }
            return null;
        }
        if (typeof Module.getGlobalExportByName === "function") {
            return Module.getGlobalExportByName(sym);
        }
    } catch (e) { }
    return null;
}

function tryHook(mod, sym, label, withBt, max) {
    try {
        var addr = findExport(mod, sym);
        if (!addr || addr.isNull()) { log("[-] skip " + label + ": 符号未找到"); return; }
        Interceptor.attach(addr, {
            onEnter: function (a) {
                if (!allow(label, max || 50)) return;
                send({ type: "hit", hook: label, args: [a[0] + "", a[1] + "", a[2] + ""] });
                if (withBt) bt(this.context, label);
            },
            onLeave: function (rv) {
                if (allow(label + ":ret", 10)) send({ type: "ret", hook: label, ret: rv + "" });
            }
        });
        log("[+] hooked " + label + " @ " + addr);
    } catch (e) { log("[-] skip " + label + ": " + e.message); }
}

// ---------- 1. ConfSDK 入口 (通话 SDK 激活信号) ----------
tryHook(null, "GetWXConfService", "GetWXConfService", true, 20);
tryHook(null, "GetWaveLink", "GetWaveLink", true, 20);
tryHook(null, "GetWXAIConfService", "GetWXAIConfService", false, 5);

// ---------- 2. CoreAudio (媒体面起停: 麦克风/扬声器引擎) ----------
["AudioUnitInitialize", "AudioOutputUnitStart", "AudioOutputUnitStop",
    "AudioQueueStart", "AudioQueueStop"].forEach(function (s) {
        tryHook(null, s, s, true, 30);
    });

// ---------- 3. dlopen (ConfSDKdyn 可能懒加载, 加载时机≈通话开始) ----------
try {
    var dlopenAddr = findExport("libdyld.dylib", "dlopen");
    if (dlopenAddr) {
        Interceptor.attach(dlopenAddr, {
            onEnter: function (a) {
                try { this.n = a[0].readCString(); } catch (e) { this.n = null; }
            },
            onLeave: function (r) {
                if (this.n && /conf|ilink|media/i.test(this.n)) {
                    send({ type: "dlopen", path: this.n, ret: r + "" });
                }
            }
        });
        log("[+] hooked dlopen");
    } else { log("[-] dlopen 符号未找到"); }
} catch (e) { log("[-] dlopen: " + e.message); }

// ---------- 4. ObjC voip 类清单 ----------
try {
    if (typeof ObjC !== "undefined" && ObjC.available) {
        var oc = [];
        for (var name in ObjC.classes) {
            if (/voip|VOIP/i.test(name) && oc.length < 40) oc.push(name);
        }
        log("ObjC voip classes: " + (oc.join(", ") || "(无)"));
    }
} catch (e) { log("[-] objc: " + e.message); }

// ---------- 5. mars 信令面 (4.1.13.63 生产地址, 同版本直接用) ----------
// req2bufEnter: 所有出站 CGI 任务 protobuf 注入点 → 通话邀请若走 mars 这里能看到
// onPush/respDispatch: 入站推送 → 对端回铃/接听/挂断通知
function hookAt(name, hexAddr, opts) {
    if (!BASE) { log("[-] 无 base, 跳过 " + name); return; }
    try {
        var addr = BASE.add(hexAddr);
        Interceptor.attach(addr, {
            onEnter: function (a) {
                if (!allow(name, opts.max || 200)) return;
                var rec = { type: "mars", hook: name, ts: Date.now() };
                // respDispatch/req2buf 的关键参数按上下文读
                if (opts.dumpArg !== undefined) {
                    try {
                        var p = a[opts.dumpArg];
                        var n = Math.min(opts.dumpLen || 96, 2048);
                        var bytes = p.readByteArray(n);
                        rec.hex = bytes ? Array.from(new Uint8Array(bytes)).map(function (b) {
                            return ("0" + b.toString(16)).slice(-2);
                        }).join("") : null;
                        rec.ptr = p + "";
                    } catch (e) { rec.hex = "unreadable"; }
                }
                send(rec);
                if (opts.bt) bt(this.context, name + "@" + hexAddr);
            }
        });
        log("[+] hooked " + name + " @ " + hexAddr);
    } catch (e) { log("[-] " + name + ": " + e.message); }
}

hookAt("req2buf", "0x42e3450", { dumpArg: 0, dumpLen: 64 });        // 出站请求体
hookAt("onPush", "0x59b0e94", { dumpArg: 2, dumpLen: 64, max: 100 }); // 入站推送
hookAt("respDispatch", "0x42e5044", { dumpArg: 0, dumpLen: 64, max: 100 }); // 响应分发

log("=== 探针就绪, 请开始操作 ===");
