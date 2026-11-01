// 探针 v35 — 在拨号函数内部, 序列化调用点(wechat.dylib+0x1fc1240)抓:
//   入参结构体 (sp+0x1e0, 0x80B)  +  序列化产物 std::string (sp+0xd0)
// 目的: 结构体哪一栏 == pb 的 field7(本机标识), 再回溯它的来源
var REAL_MOD = Process.enumerateModules().filter(function (m) {
    return /wechat\.dylib/i.test(m.name) && m.size > 100 * 1024 * 1024;
})[0];
if (!REAL_MOD) throw new Error("wechat.dylib real image not found");
var BASE = REAL_MOD.base;

function log(s) { send({ type: "log", msg: s, ts: Date.now() }); }
function hexs(b) { return Array.from(b).map(function (x) { return ("0" + x.toString(16)).slice(-2); }).join(""); }
function asc(b) {
    var s = "";
    for (var i = 0; i < b.length; i++) { var c = b[i]; s += (c >= 0x20 && c < 0x7f) ? String.fromCharCode(c) : "."; }
    return s;
}
function readable(p, n) {
    try {
        var r = Process.findRangeByAddress(p);
        if (!r || r.protection.indexOf("r") < 0) return 0;
        var avail = r.base.add(r.size).sub(p).toInt32();
        return avail > 0 ? Math.min(n, avail) : 0;
    } catch (e) { return 0; }
}
function dumpBytes(p, n) {
    var k = readable(p, n);
    if (!k) return "<unmapped>";
    var b = new Uint8Array(p.readByteArray(k));
    return "hex:" + hexs(b) + "\n    asc:" + asc(b);
}
function strAt(st) {
    try {
        var p = st.readPointer(), sz = st.add(8).readUInt32();
        if (sz <= 0 || sz > 4096 || !readable(p, sz)) return null;
        return new Uint8Array(p.readByteArray(sz));
    } catch (e) { return null; }
}

var n = 0;
Interceptor.attach(BASE.add("0x1fc1240"), {
    onEnter: function () {
        this.st = this.context.x0;          // sp+0x1e0 结构体
        this.out = this.context.x1;         // sp+0xd0 输出 std::string
    },
    onLeave: function () {
        if (++n > 2) return;
        var s = strAt(this.out);
        send({ type: "cap", ts: Date.now(),
               structAt: String(this.st), structDump: dumpBytes(this.st, 0x80),
               pbLen: s ? s.length : -1, pbHex: s ? hexs(s) : "", pbAsc: s ? asc(s) : "" });
    }
});
log("=== v35 就绪 请点一次语音通话(响铃后挂断) ===");
