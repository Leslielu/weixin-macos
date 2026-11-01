// 探针 v25 — 先建会话(SEL 39)再发 invite(SEL 34)，让 ConfSDK 接管后半程
// 触发: /tmp/voip_replay.req 内容变化; 被叫: /tmp/voip_target.txt
var REAL_MOD = Process.enumerateModules().filter(function (m) {
    return /wechat\.dylib/i.test(m.name) && m.size > 100 * 1024 * 1024;
})[0];
if (!REAL_MOD) throw new Error("wechat.dylib real image not found");
var BASE = REAL_MOD.base;
var SVC = ptr("0x123877ab8");
var EXPECT_VT_OFF = "98cbac8";

function log(s) { send({ type: "log", msg: s, ts: Date.now() }); }
function hex2bytes(h) {
    var out = [];
    for (var i = 0; i < h.length; i += 2) out.push(parseInt(h.substr(i, 2), 16));
    return out;
}
// 2026-11-01 09:05 手动拨号抓包
var P39_HEX = "0a067765636861741207766f69702d32701801200228b38ca4f302";
var INVITE_HEX = "08ba4412e1010a13777869645f3364706f6475713137747663313210021a0022b60108cb818020120a30786632363431643366180420012a690a6508d70810fe7f187f20b201288e8810309984d0a00c3881a2bcb30f400448960150415808600a6808700a78008001008801ee019001ee01980100a00100a8010cb0010cb8010cc0010cc80104d00102d801ffffffff07a00200a80200b00200b8023fc002071200321d0a00120561726d36341a0022002a00380a40004a084170706c65204d3438800540b2014a0b0a03656e301001200430015080800428b38ca4f3023a07766f69702d327018e65022252f6367692d62696e2f6d6963726f6d73672d62696e2f766f6970696c696e6b696e76697465";

function checkService() {
    try {
        var vt = SVC.readPointer();
        var off = vt.sub(BASE);
        var exact = off.compare(0) >= 0 && off.compare(0x20000000) < 0 && off.toString(16) === EXPECT_VT_OFF;
        return exact;
    } catch (e) { return false; }
}
function readVarint(arr, i) {
    var n = 0, shift = 0, b;
    do { b = arr[i++]; n += (b & 0x7f) * Math.pow(2, shift); shift += 7; } while (b & 0x80);
    return [n, i];
}
function encVarint(n) {
    var out = [];
    while (true) { var b = n & 0x7f; n = Math.floor(n / 128); if (n) out.push(b | 0x80); else { out.push(b); return out; } }
}
var parts = (function () {
    var a = hex2bytes(INVITE_HEX), i = 1;
    var r = readVarint(a, i); i = r[1];
    var prefix = a.slice(0, i);
    var br = readVarint(a, i + 1);
    var body = a.slice(br[1], br[1] + br[0]);
    var tail = a.slice(br[1] + br[0]);
    var wr = readVarint(body, 1);
    return { prefix: prefix, rest: body.slice(wr[1] + wr[0]), tail: tail };
})();
function buildInvite(wxid) {
    var w = [];
    for (var i = 0; i < wxid.length; i++) w.push(wxid.charCodeAt(i) & 0xff);
    var body = [0x0a].concat(encVarint(w.length), w, parts.rest);
    return parts.prefix.concat([0x12], encVarint(body.length), body, parts.tail);
}
function readText(p) {
    try { var f = new File(p, "r"); var t = f.readText(); f.close(); return t; } catch (e) { return null; }
}
function callSel(sel, bytes) {
    var fn = new NativeFunction(BASE.add("0x1fcaf64"), "void",
        ["pointer", "int", "pointer", "pointer", "int", "pointer"]);
    var mem = Memory.alloc(bytes.length);
    mem.writeByteArray(bytes);
    fn(SVC, sel, ptr(0), mem, bytes.length, ptr(0));
}

// 记录所有 selector, 看 ConfSDK 是否接管后半程
Interceptor.attach(BASE.add("0x1fcaf64"), {
    onEnter: function () {
        var c = this.context;
        send({ type: "sel", sel: c.x1.toUInt32(), len: c.x4.toUInt32(), ts: Date.now() });
    }
});
[["0x5470688", "audioStart"], ["0x547070c", "audioStop"]].forEach(function (p) {
    Interceptor.attach(BASE.add(p[0]), {
        onEnter: function () { send({ type: "audio", hook: p[1], ts: Date.now() }); }
    });
});

log("v25 就绪 svc=" + SVC + " 校验=" + (checkService() ? "OK" : "FAIL") +
    " invite模板=" + (parts.prefix.length + parts.rest.length + parts.tail.length + 21) + "B");

var lastTag = null;
setInterval(function () {
    var tag = readText("/tmp/voip_replay.req");
    if (!tag) return;
    tag = tag.trim();
    if (!tag || tag === lastTag) return;
    lastTag = tag;
    var wxid = (readText("/tmp/voip_target.txt") || "").trim();
    if (!wxid) { send({ type: "skip", reason: "no target" }); return; }
    if (!checkService()) { send({ type: "skip", reason: "svc check fail" }); return; }
    var inv = buildInvite(wxid);
    send({ type: "start", wxid: wxid, inviteLen: inv.length, ts: Date.now() });
    try {
        callSel(39, hex2bytes(P39_HEX));
        setTimeout(function () {
            try {
                callSel(34, inv);
                send({ type: "inviteSent", wxid: wxid, ts: Date.now() });
            } catch (e) { send({ type: "err", where: "invite", msg: String(e) }); }
        }, 30);
    } catch (e) { send({ type: "err", where: "sel39", msg: String(e) }); }
}, 1000);
