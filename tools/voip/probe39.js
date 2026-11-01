// 探针 v39 — 抓「UI 拨号 → 音频引擎启动」这条链上每一层的入口参数
// 结论驱动: v38 已证实 程序化 vt[6] 拨号 **不启动** 本机音频引擎(无任何 beacon),
//           UI 拨号才启动。v37 拿到了 6 帧栈, 但多数是虚调用(blr x8), 静态追不动。
// 本版在**已确认的函数入口**上挂钩(逐个反汇编核对过 prologue), 打印 x0..x5 与
// 每个指针的 vtable 归属(模块+偏移), 目标是找到能由我们直接调用、且自带
// 「建引擎+起采集+拨号」的那一层。
// 安全约束(v37 事故教训): 不挂任何靠位置猜的地址; 音频线程上的钩子不做 backtrace。
var REAL_MOD = Process.enumerateModules().filter(function (m) {
    return /wechat\.dylib/i.test(m.name) && m.size > 100 * 1024 * 1024;
})[0];
if (!REAL_MOD) throw new Error("wechat.dylib real image not found");
var BASE = REAL_MOD.base;

function log(s, extra) {
    var m = { type: "log", msg: s, ts: Date.now() };
    if (extra) for (var k in extra) m[k] = extra[k];
    send(m);
}
function modOf(addr) {
    try {
        var m = Process.findModuleByAddress(addr);
        return m ? m.name + "+0x" + addr.sub(m.base).toString(16) : String(addr);
    } catch (e) { return String(addr); }
}
function objInfo(p) {
    try {
        if (!p || p.isNull()) return "null";
        var r = Process.findRangeByAddress(p);
        if (!r || r.protection.indexOf("r") < 0) return "unmapped";
        var vt = p.readPointer();
        return "vt=" + modOf(vt);
    } catch (e) { return "?"; }
}
function btOnce(ctx, n) {
    try { return Thread.backtrace(ctx, Backtracer.FUZZY).slice(0, n).map(modOf).join(" <- "); }
    catch (e) { return "<bt err>"; }
}

// ---------- 控制器层(入口已核对) ----------
// 0x1fe14a8  聊天窗「语音通话」按钮处理函数(内部 bl 0x1fc07f4)
// 0x1c56cec  拨号链最上层(runloop/事件分发侧)
// 0x434dc00 / 0x4350030  音频引擎启动链上层
var CTRL = ["0x1fe14a8", "0x1c56cec", "0x434dc00", "0x4350030"];
var ctrlSeen = {};
CTRL.forEach(function (off) {
    Interceptor.attach(BASE.add(off), {
        onEnter: function () {
            var n = (ctrlSeen[off] = (ctrlSeen[off] || 0) + 1);
            if (n > 3) return;
            var c = this.context;
            send({ type: "ctrl", off: off, n: n, ts: Date.now(),
                   x0: String(c.x0), x0i: objInfo(c.x0),
                   x1: String(c.x1), x1i: objInfo(c.x1),
                   x2: String(c.x2), x2i: objInfo(c.x2),
                   x3: String(c.x3), x4: String(c.x4), x5: String(c.x5),
                   bt: btOnce(c, 8) });
        }
    });
});

// ---------- 引擎层(§5 已验证 + 反汇编核对过的构造/创建入口) ----------
// 0x5470f7c 引擎创建(内部 malloc 0x28)  0x546a558 引擎包装/初始化
var ENG = { "0x546a558": "engineWrap", "0x5470f7c": "engineCreate",
            "0x54704e4": "engineCtor", "0x5470644": "engineStart容器",
            "0x5470688": "engineStart", "0x547070c": "engineStop" };
var engSeen = {};
Object.keys(ENG).forEach(function (off) {
    Interceptor.attach(BASE.add(off), {
        onEnter: function () {
            var n = (engSeen[off] = (engSeen[off] || 0) + 1);
            if (n > 4) return;
            var c = this.context;
            // 音频线程上不取 backtrace(v37 的 SIGBUS 教训), 只记寄存器
            send({ type: "eng", off: off, name: ENG[off], n: n, ts: Date.now(),
                   x0: String(c.x0), x0i: objInfo(c.x0),
                   x1: String(c.x1), x1i: objInfo(c.x1),
                   x2: String(c.x2), x2i: objInfo(c.x2), x3: String(c.x3) });
        }
    });
});

// ---------- UI 拨号入口 + 信令分发 ----------
Interceptor.attach(BASE.add("0x1fc07f4"), {
    onEnter: function () {
        var c = this.context, callee = null;
        try { callee = c.x1.readUtf8String(); } catch (e) {}
        send({ type: "uidial", callee: callee, ts: Date.now(),
               x0: String(c.x0), x0i: objInfo(c.x0), x2: String(c.x2),
               x3: String(c.x3), x4: String(c.x4), x5: String(c.x5) });
    }
});
Interceptor.attach(BASE.add("0x1fcaf64"), {
    onEnter: function () {
        var c = this.context;
        send({ type: "sel", sel: c.x1.toUInt32(), len: c.x4.toUInt32(), ts: Date.now() });
    }
});

log("=== v39 就绪: 请再在微信 UI 里手动拨一次语音通话(响铃 5 秒后挂断, 不用接) ===");
