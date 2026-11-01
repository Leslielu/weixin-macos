// 探针 v23 — 接通问题取证: 全量信令 + 音频 + 阶段标记
// 阶段标记: /tmp/voip_phase.txt 内容(manual / replay / answer ...) 会打在每条日志里
var REAL_MOD = Process.enumerateModules().filter(function (m) {
    return /wechat\.dylib/i.test(m.name) && m.size > 100 * 1024 * 1024;
})[0];
if (!REAL_MOD) throw new Error("wechat.dylib real image not found");
var BASE = REAL_MOD.base;
var CONF = Process.enumerateModules().filter(function (m) { return /ConfSDKdyn/i.test(m.name); });

function phase() {
    try { var f = new File("/tmp/voip_phase.txt", "r"); var t = f.readText(); f.close(); return (t || "").trim(); }
    catch (e) { return ""; }
}
function hex(a, n) {
    try { return Array.from(new Uint8Array(a.readByteArray(n))).map(function (x) { return ("0" + x.toString(16)).slice(-2); }).join(" "); }
    catch (e) { return "<unreadable>"; }
}
function modOf(addr) {
    var m = Process.findModuleByAddress(addr);
    return m ? m.name + "+0x" + addr.sub(m.base).toString(16) : String(addr);
}
function log(ev, extra) {
    send({ type: "ev", ev: ev, phase: phase(), ts: Date.now(), base: String(extra || "") });
}

log("start", "ConfSDK=" + (CONF.length ? CONF.map(function (m) { return m.name + "@" + m.base + " sz=" + m.size; }).join(",") : "none"));

// 1) 服务虚分发器: 所有 selector
Interceptor.attach(BASE.add("0x1fcaf64"), {
    onEnter: function () {
        var c = this.context;
        var sel = c.x1.toUInt32();
        var len = c.x4.toUInt32();
        var head = (len > 0 && len < 4096) ? hex(c.x3, Math.min(len, 16)) : "";
        var bt = "";
        try {
            bt = Thread.backtrace(this.context, Backtracer.ACCURATE).slice(0, 4).map(modOf).join(" <- ");
        } catch (e) { bt = "<no bt>"; }
        send({ type: "sel", phase: phase(), ts: Date.now(), sel: sel, len: len,
               svc: String(c.x0), head: head, bt: bt });
    }
});

// 2) FSM 事件处理: cmdid/URI/payload
Interceptor.attach(BASE.add("0x1fdc604"), {
    onEnter: function () {
        var c = this.context;
        var ev = c.x0;
        var cmdid = 0, uri = "", plen = 0;
        try { cmdid = ev.add(0x40).readU32(); } catch (e) {}
        try { uri = ev.add(0x48).readPointer().readCString(); } catch (e) {}
        try { plen = ev.add(0x50).readU32(); } catch (e) {}
        send({ type: "fsm", phase: phase(), ts: Date.now(), cmdid: "0x" + cmdid.toString(16), uri: uri, plen: plen });
    }
});

// 3) 音频引擎
[["0x5470688", "audioStart"], ["0x547070c", "audioStop"]].forEach(function (p) {
    Interceptor.attach(BASE.add(p[0]), {
        onEnter: function () { send({ type: "audio", phase: phase(), ts: Date.now(), hook: p[1] }); }
    });
});

// 4) 收包(响应/推送)首字节序列, 只在前 64B
var respN = 0;
Interceptor.attach(BASE.add("0x42e5044"), {
    onEnter: function () {
        if (++respN > 4000) return;
        try {
            var ab = this.context.x1;
            var D = ab.readPointer();
            var dataPtr = D.readPointer();
            var dataLen = D.add(0xc).readU32();
            if (dataLen < 4 || dataLen > 65535) return;
            var head = hex(dataPtr, Math.min(dataLen, 24));
            send({ type: "resp", phase: phase(), ts: Date.now(), len: dataLen, head: head });
        } catch (e) {}
    }
});

log("ready", "hooks: sel/fsm/audio/resp; phase file /tmp/voip_phase.txt");
