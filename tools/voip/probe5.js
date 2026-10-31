// VoIP 通话链路发现探针 v5 — mmcronet URL 层抓信令
// 每次 cronet 请求必过 Cronet_UrlRequest_url_set(Cronet_String url)
// 邀请/挂断信令若走 ilink-over-cronet, 点击时刻的 URL + backtrace 即现形

var REAL_MOD = Process.enumerateModules().filter(function (m) {
    return /wechat\.dylib/i.test(m.name) && m.size > 100 * 1024 * 1024;
})[0];
var BASE = REAL_MOD.base;

function log(s) { send({ type: "log", msg: s }); }
function bt(ctx, tag) {
    try {
        var frames = Thread.backtrace(ctx, Backtracer.FUZZY).map(DebugSymbol.fromAddress);
        send({ type: "bt", tag: tag, frames: frames.slice(0, 28).map(String) });
    } catch (e) { log("bt fail " + e); }
}
var counters = {};
function allow(key, max) {
    counters[key] = (counters[key] || 0) + 1;
    return counters[key] <= max;
}

// ---------- cronet 请求 URL/方法 ----------
[["Cronet_UrlRequest_url_set", "url"], ["Cronet_UrlRequest_http_method_set", "method"]].forEach(function (p) {
    try {
        var addr = Module.getGlobalExportByName(p[0]);
        if (!addr || addr.isNull()) { log("[-] " + p[0] + " 未找到"); return; }
        Interceptor.attach(addr, {
            onEnter: function (a) {
                if (!allow(p[0], 100)) return;
                var val = "";
                try { val = a[1].readCString(); } catch (e) { val = "?"; }
                send({ type: "cronet", kind: p[1], val: val });
                bt(this.context, "cronet_" + p[1] + ":" + (val || "").slice(0, 48));
            }
        });
        log("[+] hooked " + p[0]);
    } catch (e) { log("[-] " + p[0] + ": " + e.message); }
});

// ---------- cronet upload 数据(请求体, 邀请 protobuf 应在这里) ----------
try {
    var addr = Module.getGlobalExportByName("Cronet_Buffer_InitWithDataAndCallback");
    if (addr && !addr.isNull()) {
        Interceptor.attach(addr, {
            onEnter: function (a) {
                if (!allow("bufinit", 200)) return;
                try {
                    var data = a[1];
                    var size = a[2].toInt32();
                    if (size <= 0 || size > 65536) return;
                    var mem = data.readByteArray(Math.min(size, 512));
                    send({
                        type: "cronet_body", size: size,
                        hex: mem ? Array.from(new Uint8Array(mem)).map(function (b) {
                            return ("0" + b.toString(16)).slice(-2);
                        }).join("") : null
                    });
                } catch (e) { }
            }
        });
        log("[+] hooked Cronet_Buffer_InitWithDataAndCallback");
    }
} catch (e) { log("[-] bufinit: " + e.message); }

// ---------- 音频引擎 beacon (时间轴) ----------
[["0x5470688", "audioStart"], ["0x547070c", "audioStop"]].forEach(function (p) {
    try {
        Interceptor.attach(BASE.add(p[0]), {
            onEnter: function () {
                if (!allow(p[1], 30)) return;
                send({ type: "hit", hook: p[1], ts: Date.now() });
            }
        });
        log("[+] " + p[1]);
    } catch (e) { log("[-] " + p[1]); }
});

// ---------- onPush ----------
try {
    Interceptor.attach(BASE.add("0x59b0e94"), {
        onEnter: function () {
            try {
                var ab = this.context.x4;
                var D = ab.readPointer();
                var dataPtr = D.readPointer();
                var dataLen = D.add(0xc).readU32();
                if (dataLen < 4 || dataLen > 1024 * 1024) return;
                var mem = dataPtr.readByteArray(Math.min(dataLen, 2048));
                send({
                    type: "push", cmdid: String(this.context.x3), len: String(dataLen),
                    hex: mem ? Array.from(new Uint8Array(mem)).map(function (b) {
                        return ("0" + b.toString(16)).slice(-2);
                    }).join("") : null
                });
            } catch (e) { }
        }
    });
    log("[+] onPush");
} catch (e) { log("[-] onPush"); }

log("=== 探针v5就绪: 请点「语音通话」响几秒挂断 ===");
