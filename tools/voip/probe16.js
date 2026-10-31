// 探针 v16 — 抓 FSM 事件/队列项中的被叫 wxid，并用条件变量通知栈反查 UI 入队函数
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
    try {
        return Thread.backtrace(ctx, Backtracer.FUZZY).slice(0, 24).map(off);
    } catch (e) { return ["bt-fail:" + e]; }
}
function printable(s) {
    return /^[\x20-\x7e]+$/.test(s);
}
function pointedString(p) {
    try {
        if (p.isNull() || p.compare(0x10000) < 0) return null;
        var r = Process.findRangeByAddress(p);
        if (!r || r.protection.indexOf("r") < 0) return null;
        var s = p.readUtf8String(160);
        if (s && s.length >= 3 && printable(s)) return s;
    } catch (e) { }
    return null;
}
function dumpPtrFields(p, n) {
    var out = [];
    for (var i = 0; i < n; i += 8) {
        try {
            var q = p.add(i).readPointer();
            var s = pointedString(q);
            if (s) out.push({ off: "0x" + i.toString(16), ptr: String(q), str: s });
        } catch (e) { }
    }
    return out;
}

// UI 入队通常以 condition_variable 通知唤醒 worker。先只存轻量栈，FSM 事件到达时再回传最近记录。
var notifications = [];
function remember(ctx, kind) {
    try {
        notifications.push({ ts: Date.now(), kind: kind, tid: this.threadId, frames: bt(ctx) });
        if (notifications.length > 300) notifications.splice(0, notifications.length - 300);
    } catch (e) { }
}
[
    ["_ZNSt3__118condition_variable10notify_oneEv", "notify_one"],
    ["_ZNSt3__118condition_variable10notify_allEv", "notify_all"]
].forEach(function (spec) {
    try {
        var p = Module.getGlobalExportByName(spec[0]);
        Interceptor.attach(p, {
            onEnter: function () { remember(this.context, spec[1]); }
        });
        log("notify hook ok: " + spec[1]);
    } catch (e) { log("notify hook skip: " + spec[1] + " " + e); }
});

var n = 0;
Interceptor.attach(BASE.add("0x1fdc604"), {
    onEnter: function () {
        if (++n > 8) return;
        var c = this.context;
        var ev = c.x0;
        var rec = {
            type: "fsmEvent", n: n, ts: Date.now(), tid: this.threadId,
            event: String(ev), cmdid: "0x" + ev.add(0x20).readU32().toString(16),
            eventRaw: safeHex(ev, 0x80), eventStrings: dumpPtrFields(ev, 0x80),
            bt: bt(c)
        };
        try {
            var item = ev.readPointer();
            rec.queueItem = String(item);
            rec.queueItemRaw = safeHex(item, 0x100);
            rec.queueItemStrings = dumpPtrFields(item, 0x100);
        } catch (e) { }
        try {
            var payload = ev.add(0x10).readPointer();
            rec.payload = String(payload);
            rec.payloadRaw = safeHex(payload, 0x100);
            rec.payloadStrings = dumpPtrFields(payload, 0x100);
        } catch (e) { }
        var now = Date.now();
        rec.notifications = notifications.filter(function (x) { return now - x.ts <= 4000; });
        notifications = [];
        send(rec);
    }
});
log("=== v16 就绪(base=" + BASE + "): 请点一次语音通话，接通几秒后挂断 ===");
