// 探针 v11 — 收口: 0x5595邀请/0x2474挂断 的 URI + 请求体protobuf
var REAL_MOD = Process.enumerateModules().filter(function (m) {
    return /wechat\.dylib/i.test(m.name) && m.size > 100 * 1024 * 1024;
})[0];
var BASE = REAL_MOD.base;
function log(s) { send({ type: "log", msg: s }); }
function rel(p) { return "0x" + p.sub(BASE).toString(16); }
function hex(b) { return Array.from(new Uint8Array(b)).map(function (x) { return ("0" + x.toString(16)).slice(-2); }).join(""); }

var VOIP_CMDS = { 0x5595: "INVITE", 0x2474: "HANGUP", 0x2866: "ROOM", 0x2c9d: "REPORT", 0x242e: "SYNC" };
var voipWindowUntil = 0;

// ---------- SubmitCgi: voip 任务全量dump ----------
Interceptor.attach(BASE.add("0x42e3450"), {
    onEnter: function () {
        var msg = this.context.x1;
        try {
            var cmdid = msg.add(0xc).readU32();
            if (!VOIP_CMDS[cmdid]) return;
            var tag = VOIP_CMDS[cmdid];
            voipWindowUntil = Date.now() + 3000;
            // URI: +0x18 {ptr,size,cap}, cap 高位=长串标志
            var uriStr = null;
            try {
                var up = msg.add(0x18).readPointer();
                var usize = msg.add(0x20).readU32();
                if (!up.isNull() && usize > 0 && usize < 256) uriStr = up.readUtf8String(usize);
            } catch (e) { }
            var vt = msg.readPointer();
            var serFn = vt.add(0x10).readPointer();
            var respFn = vt.add(0x18).readPointer();
            var cb = msg.add(0x68).readPointer();
            var cbVt = null;
            try { cbVt = cb.readPointer(); } catch (e) { }
            send({
                type: "voipmsg", tag: tag, cmdid: "0x" + cmdid.toString(16), uri: uriStr,
                vt: rel(vt), serFn: rel(serFn), respFn: rel(respFn),
                cb: String(cb), cbVt: cbVt ? rel(cbVt) : null,
                msgHex: hex(msg.readByteArray(0x90)), ts: Date.now()
            });
        } catch (e) { }
    }
});
log("[+] SubmitCgi voip dump 就绪 (base=" + BASE + ")");

// ---------- AutoBuffer write: 窗口内抓请求体 ----------
Interceptor.attach(BASE.add("0x4308c58"), {
    onEnter: function () {
        if (Date.now() > voipWindowUntil) return;
        try {
            var data = this.context.x1;
            var len = this.context.x2.toInt32();
            if (len <= 0 || len > 65536) return;
            var mem = data.readByteArray(Math.min(len, 1024));
            send({ type: "abwrite", len: len, hex: hex(mem), ts: Date.now() });
        } catch (e) { }
    }
});
log("[+] AutoBuffer write 窗口抓取就绪");

// ---------- 音频 beacon ----------
[["0x5470688", "audioStart"], ["0x547070c", "audioStop"]].forEach(function (p) {
    try {
        var c = 0, self = p[1];
        Interceptor.attach(BASE.add(p[0]), {
            onEnter: function () { if (++c <= 30) send({ type: "hit", hook: self, ts: Date.now() }); }
        });
    } catch (e) { }
});

log("=== v11 就绪: 点语音通话, 响几秒挂断 ===");
