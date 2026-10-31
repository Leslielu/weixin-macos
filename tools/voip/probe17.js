// 探针 v17 — 从通用队列当前任务取 std::function vtable，反查 UI 侧入队构造点
var REAL_MOD = Process.enumerateModules().filter(function (m) {
    return /wechat\.dylib/i.test(m.name) && m.size > 100 * 1024 * 1024;
})[0];
if (!REAL_MOD) throw new Error("wechat.dylib real image not found");
var BASE = REAL_MOD.base;
function log(s) { send({ type: "log", msg: s }); }
function hex(b) {
    return Array.from(new Uint8Array(b)).map(function (x) {
        return ("0" + x.toString(16)).slice(-2);
    }).join("");
}
function safeHex(p, n) {
    try { return hex(p.readByteArray(n)); } catch (e) { return null; }
}
function off(a) {
    try {
        var d = a.sub(BASE);
        if (d.compare(0) >= 0 && d.compare(0x20000000) < 0) return "wechat+0x" + d.toString(16);
    } catch (e) { }
    return String(a);
}
function bt(ctx) {
    try { return Thread.backtrace(ctx, Backtracer.FUZZY).slice(0, 24).map(off); }
    catch (e) { return ["bt-fail:" + e]; }
}
function inlineString(p) {
    try {
        var s = p.readUtf8String(80);
        if (s && /^[\x20-\x7e]+$/.test(s)) return s;
    } catch (e) { }
    return null;
}
function ptrFields(p, n) {
    var out = [];
    for (var i = 0; i < n; i += 8) {
        try {
            var q = p.add(i).readPointer();
            if (!q.isNull()) out.push({ off: "0x" + i.toString(16), value: off(q) });
        } catch (e) { }
    }
    return out;
}
function vtableFields(p, n) {
    var out = [];
    for (var i = 0; i < n; i += 8) {
        try {
            var q = p.add(i).readPointer();
            var d = q.sub(BASE);
            if (d.compare(0) >= 0 && d.compare(0x20000000) < 0) {
                out.push({ at: "0x" + i.toString(16), table: off(q), slots: ptrFields(q, 0x40) });
            }
        } catch (e) { }
    }
    return out;
}

var currentTasks = {};
Interceptor.attach(BASE.add("0x62c0508"), {
    onEnter: function () {
        currentTasks[this.threadId] = { queue: this.context.x0, task: this.context.x1 };
    }
});

var n = 0;
Interceptor.attach(BASE.add("0x1fdc604"), {
    onEnter: function () {
        if (++n > 8) return;
        var c = this.context;
        var ev = c.x0;
        var rec = {
            type: "fsmEvent", n: n, ts: Date.now(), tid: this.threadId,
            event: String(ev), cmdid: "0x" + ev.add(0x40).readU32().toString(16),
            eventRaw: safeHex(ev, 0x80), eventPtrs: ptrFields(ev, 0x80), bt: bt(c)
        };
        try {
            rec.uri = inlineString(ev.add(0x48).readPointer());
        } catch (e) { }
        try {
            var payload = ev.add(0x10).readPointer();
            rec.payload = String(payload);
            rec.payloadRaw = safeHex(payload, 0x100);
            rec.payloadStrings = {
                first: inlineString(payload.add(8)),
                second: inlineString(payload.add(0x28))
            };
            rec.payloadPtrs = ptrFields(payload, 0x100);
            rec.payloadVtables = vtableFields(payload, 0x100);
        } catch (e) { }
        var t = currentTasks[this.threadId];
        if (t) {
            rec.queue = String(t.queue);
            rec.task = String(t.task);
            rec.taskRaw = safeHex(t.task, 0x100);
            rec.taskPtrs = ptrFields(t.task, 0x100);
            rec.taskVtables = vtableFields(t.task, 0x100);
        }
        send(rec);
    }
});
log("=== v17 就绪(base=" + BASE + "): 请再点一次语音通话，几秒后挂断 ===");
