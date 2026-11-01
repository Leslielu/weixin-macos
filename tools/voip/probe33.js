// 探针 v33 — 抓 UI 拨号时「会话参数结构」的真实内容
// 双保险挂载:
//   A) wechat.dylib+0x1fc07f4  UI 侧拨号函数入口(x0=manager,x1..x5=参数)
//   B) wechat.dylib+0x5706804  它内部调用的 protobuf 序列化器(x0=结构体, x1=输出std::string)
//      → onLeave 直接把序列化结果(pb)打出来, 结构体 dump 出被叫/本机字段布局
// 带心跳, 用于判断 JS 线程是否还活着(load 超时场景)
var REAL_MOD = Process.enumerateModules().filter(function (m) {
    return /wechat\.dylib/i.test(m.name) && m.size > 100 * 1024 * 1024;
})[0];
if (!REAL_MOD) throw new Error("wechat.dylib real image not found");
var BASE = REAL_MOD.base;

function log(s) { send({ type: "log", msg: s, ts: Date.now() }); }
function hexs(b, n) {
    var o = [];
    for (var i = 0; i < Math.min(b.length, n === undefined ? b.length : n); i++) o.push(("0" + b[i].toString(16)).slice(-2));
    return o.join("");
}
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
function dump(p, n) {
    var k = readable(p, n);
    if (!k) return String(p) + " <unmapped>";
    try {
        var b = new Uint8Array(p.readByteArray(k));
        return String(p) + " (" + k + "B) hex:" + hexs(b, 64) + " asc:" + asc(b.slice(0, 64));
    } catch (e) { return String(p) + " <err>"; }
}
function strAt(st) {   // libc++ std::string {ptr,size,...}
    try {
        var p = st.readPointer(), sz = st.add(8).readUInt32();
        var ss = st.add(0x17).readU8();
        if (ss & 0x80) { p = st; sz = ss & 0x7f; }      // 短串内联
        if (sz <= 0 || sz > 4096 || !readable(p, sz)) return null;
        return new Uint8Array(p.readByteArray(sz));
    } catch (e) { return null; }
}

var hb = 0;
setInterval(function () { if (hb < 5) send({ type: "hb", n: ++hb, ts: Date.now() }); }, 3000);

var nA = 0;
Interceptor.attach(BASE.add("0x1fc07f4"), {
    onEnter: function () {
        if (++nA > 2) return;
        var c = this.context;
        send({ type: "dialfn", ts: Date.now(),
               regs: ["x0", "x1", "x2", "x3", "x4", "x5"].map(function (r) { return r + "=" + c[r]; }).join(" "),
               d: ["x0", "x1", "x2", "x3", "x4", "x5"].map(function (r) {
                   var v = c[r], out = dump(v, 0x30), s = strAt(v);
                   if (s) out += "  stdstr='" + asc(s) + "'";
                   return out;
               }).join("\n    ") });
    }
});

var nB = 0;
Interceptor.attach(BASE.add("0x5706804"), {
    onEnter: function () {
        this.p0 = this.context.x0; this.p1 = this.context.x1;
    },
    onLeave: function () {
        var s = strAt(this.p1);
        if (!s || s.length < 8) return;
        var h = hexs(s);
        if (h.indexOf("766f69702d3270") < 0 && h.indexOf("776563686174") < 0) return;  // voip-2p / wechat
        if (++nB > 3) return;
        send({ type: "pb", ts: Date.now(), len: s.length, hex: h, asc: asc(s),
               inStruct: dump(this.p0, 0x80) });
    }
});
log("=== v33 就绪(双保险) 请点一次语音通话(响铃后挂断) ===");
