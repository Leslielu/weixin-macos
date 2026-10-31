// 探针 v21 — 文件触发式重放（/tmp/voip_replay.req 内容变化即重放），带服务指针校验
var REAL_MOD = Process.enumerateModules().filter(function (m) {
    return /wechat\.dylib/i.test(m.name) && m.size > 100 * 1024 * 1024;
})[0];
if (!REAL_MOD) throw new Error("wechat.dylib real image not found");
var BASE = REAL_MOD.base;
function log(s) { send({ type: "log", msg: s, ts: Date.now() }); }

// probe20 于 2026-10-31 23:19 抓取的 invite 请求（273B, cmdid 0x2866）
var PAYLOAD_HEX =
    "08ae4412e1010a13777869645f3364706f6475713137747663313210021a0022b60108cb818020120a30786632363431643366180420012a690a6508d70810fe7f187f20b201288e8810309984d0a00c3881a2bcb30f400448960150415808600a6808700a78008001008801ee019001ee01980100a00100a8010cb0010cb8010cc0010cc80104d00102d801ffffffff07a00200a80200b00200b8023fc002071200321d0a00120561726d36341a0022002a00380a40004a084170706c65204d3438800540b2014a0b0a03656e301001200430015080800428f3f481f3023a07766f69702d327018e65022252f6367692d62696e2f6d6963726f6d73672d62696e2f766f6970696c696e6b696e76697465";
var SVC = ptr("0x123877ab8");   // 同进程单例（probe19/20 中稳定）

function toBytes(h) {
    var out = [];
    for (var i = 0; i < h.length; i += 2) out.push(parseInt(h.substr(i, 2), 16));
    return out;
}

var EXPECT_VT = "0x98cbac8";   // 服务对象 vtable 偏移（4.1.13.63, probe19/20 实测；svc=0x123877ab8）
function checkService() {
    try {
        var vt = SVC.readPointer();
        var off = vt.sub(BASE);
        var inRange = off.compare(0) >= 0 && off.compare(0x20000000) < 0;
        var exact = inRange && off.toString(16) === EXPECT_VT.slice(2);
        log("svc=" + SVC + " vtable=" + vt +
            (inRange ? " (wechat+" + off.toString(16) + ")" : " (OUTSIDE wechat)") +
            (exact ? " 校验通过" : " 期望 wechat+" + EXPECT_VT + "，不匹配"));
        return exact;
    } catch (e) {
        log("svc 校验失败: " + e);
        return false;
    }
}

var bytes = toBytes(PAYLOAD_HEX);
log("payload " + bytes.length + "B 就绪");
var SVC_OK = checkService();
if (!SVC_OK) log("服务指针校验未通过 — 拒绝重放(防崩)，需先手动拨一次重新抓取");

var lastTag = null;
function tick() {
    var path = "/tmp/voip_replay.req";
    var tag = null;
    try {
        var f = new File(path, "r");
        tag = f.readText();
        f.close();
    } catch (e) { return; }
    tag = (tag || "").trim();
    if (!tag || tag === lastTag) return;
    lastTag = tag;
    if (!checkService()) {
        send({ type: "replaySkip", reason: "svc 校验失败", tag: tag, ts: Date.now() });
        return;
    }
    send({ type: "replayStart", tag: tag, ts: Date.now() });
    try {
        var fn = new NativeFunction(BASE.add("0x1fcaf64"), "void",
            ["pointer", "int", "pointer", "pointer", "int", "pointer"]);
        var mem = Memory.alloc(bytes.length);
        mem.writeByteArray(bytes);
        var t0 = Date.now();
        fn(SVC, 34, ptr(0), mem, bytes.length, ptr(0));
        send({ type: "replayDone", ok: true, tag: tag, ms: Date.now() - t0, ts: Date.now() });
    } catch (e) {
        send({ type: "replayDone", ok: false, tag: tag, error: String(e), ts: Date.now() });
    }
}
var timer = setInterval(tick, 1000);
send({ type: "ready", ts: Date.now(), timer: String(timer) });

[["0x5470688", "audioStart"], ["0x547070c", "audioStop"]].forEach(function (p) {
    var n = 0;
    Interceptor.attach(BASE.add(p[0]), {
        onEnter: function () { if (++n <= 60) send({ type: "audio", hook: p[1], ts: Date.now() }); }
    });
});
// 同时记录下一次真实拨号的 payload，便于对照
Interceptor.attach(BASE.add("0x1fcaf64"), {
    onEnter: function () {
        var c = this.context;
        if (c.x1.toUInt32() !== 34) return;
        var len = c.x4.toUInt32();
        if (!len || len > 2048) return;
        send({ type: "liveInvite", svc: String(c.x0), len: len, ts: Date.now() });
    }
});
log("=== v21 就绪(base=" + BASE + "): 写 /tmp/voip_replay.req 即触发重放 ===");
