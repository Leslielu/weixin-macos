// 探针 v42 — 原生 VoIP 客户端单例直接拨号, 修正 v41 的 libc++ 字符串布局
//
// 静态结论:
//   客户端是静态单例 BASE+0x9b93ab8 (工厂 0x1fdeac0, 构造 0x1fbb050),
//   vtable = BASE+0x98cbac8; +0x28=1 表示服务已初始化, 不是一次性拨号门禁。
//   0x1fc07f4 内部序列化(0x5706804)后调 ConfSDK vt[6]; vt[6] 返回 0 时,
//   0x1fc07f4 返回 1, 因此这里 ret=1 才是发送成功。
//
// v41/v42 前两轮失败根因: Frida 内存未保活 + libc++ 短串布局判断错误。
// 以生成代码 0x1f89514/0x570673c 的实际读取为准:
// 短串文本从 +0 开始, +0x17 直接保存长度(不左移);
// 长串 ptr@+0,size@+8,+0x17 最高位置位。probe19 的旧解读不适用于这里。
//
// 安全: 不挂任何 0x546xxxx/0x547xxxx 音频函数; 状态机 0x434dc00 与
//       序列化器 0x5706804 都在前期探针中验证可挂。
// 触发: /tmp/voip_uidial.req 写入新内容; 被叫读 /tmp/voip_target.txt。
//       加载时已有 trigger 内容不会自动执行, 避免陈旧文件误拨。
var REAL_MOD = Process.enumerateModules().filter(function (m) {
    return /wechat\.dylib/i.test(m.name) && m.size > 100 * 1024 * 1024;
})[0];
if (!REAL_MOD) throw new Error("wechat.dylib real image not found");
var BASE = REAL_MOD.base;
var CLIENT = BASE.add("0x9b93ab8");
// Frida Memory.alloc 由 JS GC 管理; 局部指针退出作用域后内存可能被复用。
// vector/string/调用参数都必须显式保活到拨号结束(探针生命周期内保留最稳妥)。
var KEEP = [];

function log(s, extra) {
    var m = { type: "log", msg: s, ts: Date.now() };
    if (extra) for (var k in extra) m[k] = extra[k];
    send(m);
}
function hexs(b) {
    return Array.from(b).map(function (x) { return ("0" + x.toString(16)).slice(-2); }).join("");
}
function readText(p) {
    try { var f = new File(p, "r"); var t = f.readText(); f.close(); return t; } catch (e) { return null; }
}
function readCStr(p) { try { return p.readUtf8String(); } catch (e) { return null; } }

// 本进程 libc++ std::string -> Uint8Array; 同时返回原始字节便于核验布局。
function strBytes(st) {
    try {
        var isLong = (st.add(0x17).readU8() & 0x80) !== 0;
        var p = isLong ? st.readPointer() : st;
        var n = isLong ? st.add(8).readU64().toNumber() : st.add(0x17).readU8();
        if (n < 0 || n > 4096) return null;
        return new Uint8Array(p.readByteArray(n));
    } catch (e) { return null; }
}
function strAt(st) {
    var b = strBytes(st);
    if (b === null) return null;
    var s = "";
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return s;
}
function raw(p, n) {
    try { return hexs(new Uint8Array(p.readByteArray(n))); } catch (e) { return null; }
}
function vecInfo(vp) {
    try {
        var beg = vp.readPointer(), end = vp.add(8).readPointer();
        var n = end.sub(beg).toInt32() / 24;
        var out = [];
        for (var i = 0; i < Math.min(n, 8); i++) {
            var st = beg.add(i * 24);
            out.push({ text: strAt(st), raw24: raw(st, 24) });
        }
        return { n: n, items: out };
    } catch (e) { return { error: String(e) }; }
}

// 构造本进程真实布局的 libc++ std::vector<std::string>(一个元素)。
function buildVec(wxid) {
    var sb = Memory.alloc(24);
    KEEP.push(sb);
    var bytes = new Array(24);
    for (var i = 0; i < 24; i++) bytes[i] = 0;
    if (wxid.length <= 22) {
        for (i = 0; i < wxid.length; i++) bytes[i] = wxid.charCodeAt(i) & 0xff;
        bytes[0x17] = wxid.length;
    } else {
        var data = Memory.allocUtf8String(wxid);
        KEEP.push(data);
        sb.writePointer(data);
        sb.add(8).writeU64(wxid.length);
        sb.add(0x17).writeU8(0x80);
        var vecLong = Memory.alloc(24);
        KEEP.push(vecLong);
        vecLong.writePointer(sb);
        vecLong.add(8).writePointer(sb.add(24));
        vecLong.add(16).writePointer(sb.add(24));
        return vecLong;
    }
    sb.writeByteArray(bytes);
    var vec = Memory.alloc(24);
    KEEP.push(vec);
    vec.writePointer(sb);
    vec.add(8).writePointer(sb.add(24));
    vec.add(16).writePointer(sb.add(24));
    return vec;
}

function clientState() {
    try {
        return {
            obj: String(CLIENT), vt: String(CLIENT.readPointer()),
            svc: String(CLIENT.add(0x20).readPointer()),
            initialized: CLIENT.add(0x28).readU8(),
            flags140: CLIENT.add(0x140).readU32()
        };
    } catch (e) { return { error: String(e) }; }
}

log("BASE=" + BASE + " CLIENT=" + CLIENT, clientState());

// 只读观测: 所有原生客户端拨号(人工 UI 或本探针)的参数与参与者真实布局。
Interceptor.attach(BASE.add("0x1fc07f4"), {
    onEnter: function () {
        var c = this.context;
        send({ type: "clientDialEnter", ts: Date.now(), callee: readCStr(c.x1),
               obj: String(c.x0), vec: String(c.x2), vecInfo: vecInfo(c.x2),
               x3: String(c.x3), x4: String(c.x4), x5: String(c.x5),
               client: clientState() });
    }
});

// 抓最终送给 ConfSDK 的 pb, 不再只凭 ret/selector 猜请求内容。
Interceptor.attach(BASE.add("0x5706804"), {
    onEnter: function () { this.out = this.context.x1; },
    onLeave: function () {
        var b = strBytes(this.out);
        if (!b || b.length > 2048) return;
        var h = hexs(b);
        // 只记录 VoIP 拨号相关产物, 避免无关序列化噪音。
        if (h.indexOf("766f69702d3270") < 0 && h.indexOf("776563686174") < 0 && b.length !== 0) return;
        send({ type: "dialPb", len: b.length, hex: h, ts: Date.now() });
    }
});

Interceptor.attach(BASE.add("0x1fcaf64"), {
    onEnter: function () {
        var c = this.context;
        send({ type: "sel", sel: c.x1.toUInt32(), len: c.x4.toUInt32(), ts: Date.now() });
    }
});

// 安全的状态机 beacon: 验证原生客户端层是否把上层通话流程带起来。
Interceptor.attach(BASE.add("0x434dc00"), {
    onEnter: function () {
        send({ type: "callState", state: this.context.x1.toUInt32(), ts: Date.now() });
    }
});

var dialFn = new NativeFunction(BASE.add("0x1fc07f4"), "int",
    ["pointer", "pointer", "pointer", "pointer", "int", "pointer"]);
var lastTag = (readText("/tmp/voip_uidial.req") || "").trim();
setInterval(function () {
    var tag = readText("/tmp/voip_uidial.req");
    if (!tag || !(tag = tag.trim()) || tag === lastTag) return;
    lastTag = tag;
    var target = (readText("/tmp/voip_target.txt") || "").trim();
    if (!target) { send({ type: "skip", reason: "no target" }); return; }
    var st = clientState();
    if (st.initialized !== 1) {
        send({ type: "skip", reason: "client not initialized; 先人工 UI 拨一次完成初始化", client: st });
        return;
    }
    var cstr = Memory.allocUtf8String(target);
    KEEP.push(cstr);
    var vec = buildVec(target);
    send({ type: "replayPrecheck", wxid: target, vec: String(vec),
           vecInfo: vecInfo(vec), client: st, ts: Date.now() });
    var ret = null, err = null;
    try {
        ret = dialFn(CLIENT, cstr, vec, ptr(1), 0, ptr("0x2e6981b3"));
    } catch (e) { err = String(e); }
    send({ type: "dial", mode: "native-client", wxid: target, ret: ret,
           retMeaning: ret === 1 ? "ConfSDK vt[6] returned 0 (send ok)" : "send failed/not initialized",
           err: err, clientAfter: clientState(), ts: Date.now() });
}, 500);

log("=== v42 就绪: 写 /tmp/voip_uidial.req 新内容即原生客户端拨号 ===");
