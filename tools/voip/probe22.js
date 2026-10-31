// 探针 v22 — 参数化拨打：/tmp/voip_target.txt 指定被叫 wxid，/tmp/voip_replay.req 变化即发起
// payload 模板来自 probe20 抓包（273B），仅替换 field2.field1 的 wxid 并重算长度。
var REAL_MOD = Process.enumerateModules().filter(function (m) {
    return /wechat\.dylib/i.test(m.name) && m.size > 100 * 1024 * 1024;
})[0];
if (!REAL_MOD) throw new Error("wechat.dylib real image not found");
var BASE = REAL_MOD.base;
function log(s) { send({ type: "log", msg: s, ts: Date.now() }); }

var TEMPLATE_HEX =
    "08ae4412e1010a13777869645f3364706f6475713137747663313210021a0022b60108cb818020120a30786632363431643366180420012a690a6508d70810fe7f187f20b201288e8810309984d0a00c3881a2bcb30f400448960150415808600a6808700a78008001008801ee019001ee01980100a00100a8010cb0010cb8010cc0010cc80104d00102d801ffffffff07a00200a80200b00200b8023fc002071200321d0a00120561726d36341a0022002a00380a40004a084170706c65204d3438800540b2014a0b0a03656e301001200430015080800428f3f481f3023a07766f69702d327018e65022252f6367692d62696e2f6d6963726f6d73672d62696e2f766f6970696c696e6b696e76697465";
var TEMPLATE = (function () {
    var out = [];
    for (var i = 0; i < TEMPLATE_HEX.length; i += 2) out.push(parseInt(TEMPLATE_HEX.substr(i, 2), 16));
    return out;
})();
var SVC = ptr("0x123877ab8");
var EXPECT_VT_OFF = "98cbac8";

function checkService() {
    try {
        var vt = SVC.readPointer();
        var off = vt.sub(BASE);
        var exact = off.compare(0) >= 0 && off.compare(0x20000000) < 0 && off.toString(16) === EXPECT_VT_OFF;
        if (!exact) log("svc 校验失败 svc=" + SVC + " vtable=wechat+" + off.toString(16) + " 期望 +" + EXPECT_VT_OFF);
        return exact;
    } catch (e) { log("svc 校验异常: " + e); return false; }
}

function readVarint(arr, i) {
    var n = 0, shift = 0, b;
    do { b = arr[i++]; n += (b & 0x7f) * Math.pow(2, shift); shift += 7; } while (b & 0x80);
    return [n, i];
}
function encVarint(n) {
    var out = [];
    while (true) {
        var b = n & 0x7f; n = Math.floor(n / 128);
        if (n) { out.push(b | 0x80); } else { out.push(b); return out; }
    }
}

// 拆包：[f1 tag+val] [f2 tag+len] [body: 0a len wxid REST] [tail]
var parts = (function () {
    var a = TEMPLATE, i = 1;
    var r = readVarint(a, i);           // field1 value
    i = r[1];
    var prefix = a.slice(0, i);
    if (a[i] !== 0x12) throw new Error("field2 tag 非 0x12");
    var br = readVarint(a, i + 1);
    var bodyLen = br[0], bodyStart = br[1];
    var body = a.slice(bodyStart, bodyStart + bodyLen);
    var tail = a.slice(bodyStart + bodyLen);
    if (body[0] !== 0x0a) throw new Error("body field1 tag 非 0x0a");
    var wr = readVarint(body, 1);
    var origWxidLen = wr[0];
    var rest = body.slice(wr[1] + origWxidLen);
    return { prefix: prefix, origWxidLen: origWxidLen, rest: rest, tail: tail };
})();

function buildPayload(wxid) {
    var w = [];
    for (var i = 0; i < wxid.length; i++) w.push(wxid.charCodeAt(i) & 0xff);
    var body = [0x0a].concat(encVarint(w.length), w, parts.rest);
    return parts.prefix.concat([0x12], encVarint(body.length), body, parts.tail);
}

function readText(path) {
    try { var f = new File(path, "r"); var t = f.readText(); f.close(); return t; }
    catch (e) { return null; }
}

log("模板 " + TEMPLATE.length + "B（原 wxid 长 " + parts.origWxidLen + "）");
(function () {
    var rt = buildPayload("wxid_3dpoduq17tvc12");
    var ok = rt.length === TEMPLATE.length && rt.every(function (v, i) { return v === TEMPLATE[i]; });
    log("round-trip 重建: " + (ok ? "OK 与原包逐字节一致" : "不一致 len=" + rt.length));
})();
log("svc=" + SVC + ": " + (checkService() ? "校验通过" : "校验失败"));

var lastTag = null;
setInterval(function () {
    var tag = readText("/tmp/voip_replay.req");
    if (!tag) return;
    tag = tag.trim();
    if (!tag || tag === lastTag) return;
    lastTag = tag;
    var wxid = (readText("/tmp/voip_target.txt") || "").trim();
    if (!wxid) { send({ type: "replaySkip", reason: "缺 /tmp/voip_target.txt", tag: tag }); return; }
    if (!checkService()) { send({ type: "replaySkip", reason: "svc 校验失败", tag: tag }); return; }
    var bytes = buildPayload(wxid);
    send({ type: "replayStart", tag: tag, wxid: wxid, len: bytes.length, ts: Date.now() });
    try {
        var fn = new NativeFunction(BASE.add("0x1fcaf64"), "void",
            ["pointer", "int", "pointer", "pointer", "int", "pointer"]);
        var mem = Memory.alloc(bytes.length);
        mem.writeByteArray(bytes);
        var t0 = Date.now();
        fn(SVC, 34, ptr(0), mem, bytes.length, ptr(0));
        send({ type: "replayDone", ok: true, wxid: wxid, ms: Date.now() - t0, ts: Date.now() });
    } catch (e) {
        send({ type: "replayDone", ok: false, error: String(e), ts: Date.now() });
    }
}, 1000);

[["0x5470688", "audioStart"], ["0x547070c", "audioStop"]].forEach(function (p) {
    var n = 0;
    Interceptor.attach(BASE.add(p[0]), {
        onEnter: function () { if (++n <= 40) send({ type: "audio", hook: p[1], ts: Date.now() }); }
    });
});
log("=== v22 就绪: 写 /tmp/voip_target.txt + /tmp/voip_replay.req 即拨号 ===");
