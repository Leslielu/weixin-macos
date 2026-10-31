// 探针 v12 — 通话窗口全量 cmdid 记录(不漏任何一个信令)
var REAL_MOD = Process.enumerateModules().filter(function (m) {
    return /wechat\.dylib/i.test(m.name) && m.size > 100 * 1024 * 1024;
})[0];
var BASE = REAL_MOD.base;
function log(s) { send({ type: "log", msg: s }); }
function rel(p) { return "0x" + p.sub(BASE).toString(16); }
function hex(b) { return Array.from(new Uint8Array(b)).map(function (x) { return ("0" + x.toString(16)).slice(-2); }).join(""); }

// 触发器: 音频引擎启动前后 12s 窗口 (点击→邀请→房间→接通全在窗口内)
var windowUntil = 0;
var armed = true;   // 首个 audioStart 前也记(点击到audio有~1s)

Interceptor.attach(BASE.add("0x42e3450"), {
    onEnter: function () {
        var msg = this.context.x1;
        try {
            var cmdid = msg.add(0xc).readU32();
            // 心跳类跳过(0x8a/0x206 常见高频)
            if (cmdid === 0x8a || cmdid === 0x206) return;
            var uriStr = null;
            try {
                var up = msg.add(0x18).readPointer();
                var usize = msg.add(0x20).readU32();
                if (!up.isNull() && usize > 0 && usize < 256) uriStr = up.readUtf8String(usize);
            } catch (e) { }
            if (!armed && !/voip|ilink/i.test(uriStr || "")) {
                // 非窗口期只记 voip/ilink 相关
                return;
            }
            windowUntil = Date.now() + 15000;   // 见到任何疑似信令, 窗口续期
            armed = true;
            var vt = msg.readPointer();
            send({ type: "cgi", cmdid: "0x" + cmdid.toString(16), uri: uriStr, vt: rel(vt), ts: Date.now() });
        } catch (e) { }
    }
});

// AutoBuffer write: 窗口内全记
Interceptor.attach(BASE.add("0x4308c58"), {
    onEnter: function () {
        if (!armed || Date.now() > windowUntil) return;
        try {
            var data = this.context.x1;
            var len = this.context.x2.toInt32();
            if (len <= 0 || len > 65536) return;
            send({ type: "body", len: len, hex: hex(data.readByteArray(Math.min(len, 2048))), ts: Date.now() });
        } catch (e) { }
    }
});

// 音频 beacon: 呼叫确认 + 窗口
[["0x5470688", "audioStart"], ["0x547070c", "audioStop"]].forEach(function (p) {
    try {
        var c = 0, self = p[1];
        Interceptor.attach(BASE.add(p[0]), {
            onEnter: function () {
                if (++c <= 30) send({ type: "hit", hook: self, ts: Date.now() });
                windowUntil = Date.now() + 15000;
            }
        });
    } catch (e) { }
});

log("=== v12 就绪: 点语音通话, 响几秒挂断 (全程信令记录) ===");
