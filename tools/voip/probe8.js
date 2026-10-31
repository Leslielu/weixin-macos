// 探针 v8 — 指针考古(无需用户操作, 加载即跑)
// 1. 找数据段中 QWORD == BASE+0x5470644 (音频启动runnable的vtable槽)
// 2. 找 QWORD == BASE+0x17f914 (类型门卫thunk的注册表槽)
// 3. 读 0x9b73000 typeinfo 的名字, 确认 mmui 类
var REAL_MOD = Process.enumerateModules().filter(function (m) {
    return /wechat\.dylib/i.test(m.name) && m.size > 100 * 1024 * 1024;
})[0];
var BASE = REAL_MOD.base;
var SPAN_END = BASE.add(0x20000000);
function log(s) { send({ type: "log", msg: s }); }
function rel(p) { return "0x" + p.sub(BASE).toString(16); }
function qwordPat(p) {
    var h = p.toString(16); while (h.length < 16) h = "0" + h;
    var le = []; for (var i = 14; i >= 0; i -= 2) le.push(h.substr(i, 2));
    return le.join(" ");
}
var ranges = [];
Process.enumerateRanges("r--").forEach(function (r) {
    var s = r.base.compare(BASE) < 0 ? BASE : r.base;
    var e = r.base.add(r.size).compare(SPAN_END) > 0 ? SPAN_END : r.base.add(r.size);
    if (s.compare(e) < 0) ranges.push({ base: s, size: e.sub(s).toInt32() });
});
function scan(pat) {
    var out = [];
    ranges.forEach(function (r) {
        try { Memory.scanSync(r.base, r.size, pat).forEach(function (m) { out.push(m.address); }); } catch (e) { }
    });
    return out;
}
function hexAround(p, n) {
    try {
        var b = p.readByteArray(n);
        return Array.from(new Uint8Array(b)).map(function (x) { return ("0" + x.toString(16)).slice(-2); }).join("");
    } catch (e) { return "unreadable"; }
}

// ---------- typeinfo@0x9b73000 名字 ----------
try {
    var ti = BASE.add("0x9b73000");
    var namePtr = ti.add(8).readPointer();
    var nm = "";
    try { nm = namePtr.readCString(); } catch (e) { nm = "(不可读 " + namePtr + ")"; }
    log("typeinfo@0x9b73000 name=" + nm + " vptr=" + ti.readPointer());
} catch (e) { log("typeinfo 读失败: " + e); }

// ---------- 0x17f914 thunk 的注册槽 ----------
var THUNK = BASE.add("0x17f914");
var hits1 = scan(qwordPat(THUNK));
log("引用 0x17f914 的槽位 " + hits1.length + " 个");
hits1.slice(0, 6).forEach(function (h) {
    log("  slot " + rel(h) + " ctx: " + hexAround(h.sub(0x10), 0x40));
});

// ---------- 0x5470644 音频runnable 的vtable槽 ----------
var RUN = BASE.add("0x5470644");
var hits2 = scan(qwordPat(RUN));
log("引用 0x5470644 的槽位 " + hits2.length + " 个");
hits2.slice(0, 6).forEach(function (h) {
    log("  slot " + rel(h) + " ctx: " + hexAround(h.sub(0x18), 0x60));
});

log("=== v8 完成 ===");
