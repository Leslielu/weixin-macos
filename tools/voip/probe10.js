// 探针 v10 — SubmitCgi(0x42e3450) msg 结构 dump (项目范式: 入口hook安全)
// SubmitCgi(mgr=x0, msg=x1): msg+0x0c=cmdid, msg+0x18=URI(libc++串{ptr,size})
// v1 教训: 之前 dump 的 x0 是 mgr 单例(字节恒定), 真请求在 x1!
var REAL_MOD = Process.enumerateModules().filter(function (m) {
    return /wechat\.dylib/i.test(m.name) && m.size > 100 * 1024 * 1024;
})[0];
var BASE = REAL_MOD.base;
function log(s) { send({ type: "log", msg: s }); }

// libc++ string 读取: {ptr,size,cap} 或 SSO
function readCppStr(p) {
    try {
        var cap = p.add(0x10).readU64();
        if (cap & 1) {  // long
            var ptr = p.readPointer();
            var size = p.add(0x8).readU64();
            if (size > 0 && size < 4096) return { str: ptr.readUtf8String(size), size: Number(size) };
        } else {
            var size2 = p.add(0x8).readU8() >> 1;
            if (size2 > 0) return { str: p.readUtf8String(size2), size: size2 };
        }
    } catch (e) { }
    return { str: null, size: 0 };
}

var seen = {};
var n = 0;
Interceptor.attach(BASE.add("0x42e3450"), {
    onEnter: function (a) {
        var msg = this.context.x1;   // SubmitCgi(mgr, msg)
        if (++n > 300) return;
        try {
            var cmdid = msg.add(0xc).readU32();
            var uri = readCppStr(msg.add(0x18));
            var key = cmdid + "|" + (uri.str || "");
            var isNew = !seen[key];
            seen[key] = (seen[key] || 0) + 1;
            send({
                type: "cgi", cmdid: "0x" + cmdid.toString(16), uri: uri.str,
                size: uri.size, nth: seen[key], isNew: isNew, ts: Date.now()
            });
            // 新出现的 cmdid 顺带 dump msg 前 0x80 字节
            if (isNew) {
                try {
                    var b = msg.readByteArray(0x80);
                    send({ type: "msgdump", key: key, hex: Array.from(new Uint8Array(b)).map(function (x) { return ("0" + x.toString(16)).slice(-2); }).join("") });
                } catch (e) { }
            }
        } catch (e) { }
    }
});
log("[+] SubmitCgi msg dump 就绪");

// 时间轴: 音频引擎 beacon
[["0x5470688", "audioStart"], ["0x547070c", "audioStop"]].forEach(function (p) {
    try {
        var c = 0, self = p[1];
        Interceptor.attach(BASE.add(p[0]), {
            onEnter: function () { if (++c <= 30) send({ type: "hit", hook: self, ts: Date.now() }); }
        });
    } catch (e) { }
});

// onPush (来电信令) 生产读法
try {
    Interceptor.attach(BASE.add("0x59b0e94"), {
        onEnter: function () {
            try {
                var ab = this.context.x4, D = ab.readPointer(), dataPtr = D.readPointer();
                var dataLen = D.add(0xc).readU32();
                if (dataLen < 4 || dataLen > 1024 * 1024) return;
                var mem = dataPtr.readByteArray(Math.min(dataLen, 2048));
                send({ type: "push", cmdid: String(this.context.x3), len: String(dataLen), hex: mem ? Array.from(new Uint8Array(mem)).map(function (b) { return ("0" + b.toString(16)).slice(-2); }).join("") : null });
            } catch (e) { }
        }
    });
} catch (e) { }

log("=== v10 就绪: 先静置10秒看基线, 然后点语音通话 ===");
