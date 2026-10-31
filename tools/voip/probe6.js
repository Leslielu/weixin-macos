// VoIP 通话链路发现探针 v6 — RTTI→vtable→虚函数运行时追踪
// 文件里指针是 chained-fixups 相对编码, 静态扫不出; 运行时加载后是真实指针:
//   RTTI名字串 --QWORD--> typeinfo(name字段在+8) --QWORD--> vtable槽 --QWORD--> 虚函数
// 挂 VoIP 各类虚函数前几个, 点击呼叫时命中者带 backtrace = 调用链

var REAL_MOD = Process.enumerateModules().filter(function (m) {
    return /wechat\.dylib/i.test(m.name) && m.size > 100 * 1024 * 1024;
})[0];
var BASE = REAL_MOD.base, MOD_END = BASE.add(REAL_MOD.size);

function log(s) { send({ type: "log", msg: s }); }
function bt(ctx, tag) {
    try {
        var frames = Thread.backtrace(ctx, Backtracer.FUZZY).map(DebugSymbol.fromAddress);
        send({ type: "bt", tag: tag, frames: frames.slice(0, 28).map(String) });
    } catch (e) { log("bt fail " + e); }
}
function inMod(p) { try { return p.compare(BASE) >= 0 && p.compare(SPAN_END) < 0; } catch (e) { return false; } }
function rel(p) { return "0x" + p.sub(BASE).toString(16); }
// 模块真实跨度可能超过 enumerateModules 报的 size(typeinfo 在 0x9b7xxxx > size),
// 用 512MB 跨度, 扫描时按实际相交区段裁剪
var SPAN_END = BASE.add(0x20000000);
function asciiHex(s) {
    var o = [];
    for (var i = 0; i < s.length; i++) o.push(("0" + s.charCodeAt(i).toString(16)).slice(-2));
    return o.join(" ");
}
function qwordPat(p) {
    var h = p.toString(16); while (h.length < 16) h = "0" + h;
    var le = []; for (var i = 14; i >= 0; i -= 2) le.push(h.substr(i, 2));
    return le.join(" ");
}

// 模块可读数据区(扫 typeinfo/vtable 用): 与 [BASE, SPAN_END) 相交的进程区段, 裁剪到跨度内
var dataRanges = [];
Process.enumerateRanges("r--").forEach(function (r) {
    var s = r.base.compare(BASE) < 0 ? BASE : r.base;
    var e = r.base.add(r.size).compare(SPAN_END) > 0 ? SPAN_END : r.base.add(r.size);
    if (s.compare(e) < 0) dataRanges.push({ base: s, size: e.sub(s).toInt32() });
});
log("模块数据区 " + dataRanges.length + " 个, 总量 " + (dataRanges.reduce(function (a, r) { return a + r.size; }, 0) / 1048576).toFixed(0) + "MB");

function scanModule(pat) {
    var out = [];
    dataRanges.forEach(function (r) {
        try { Memory.scanSync(r.base, r.size, pat).forEach(function (m) { out.push(m.address); }); } catch (e) { }
    });
    return out;
}

// ---------- 1. RTTI 名字 → typeinfo → vtable ----------
var CLASSES = ["mmui::P2PVOIPViewModel", "mmui::VOIPWindow", "mmui::ChatVoIPView",
    "mmui::P2PVOIPTrayViewModel", "mmui::VOIPAnimateTextView", "mmui::VoipNewInviteView",
    "kernel::VOIPSessionInfo"];

var vtables = {};   // className -> [vtablePtr(vptr指向处)]
CLASSES.forEach(function (cn) {
    var strHits = scanModule(asciiHex(cn));
    if (strHits.length === 0) { log("[-] 字符串未找到: " + cn); return; }
    var typeinfos = [];
    strHits.forEach(function (s) {
        scanModule(qwordPat(s)).forEach(function (slot) {
            var ti = slot.sub(8);           // typeinfo 结构起始
            if (inMod(ti)) typeinfos.push(ti);
        });
    });
    if (typeinfos.length === 0) { log("[-] typeinfo 未找到: " + cn); return; }
    var vts = [];
    typeinfos.forEach(function (ti) {
        scanModule(qwordPat(ti)).forEach(function (slot) {
            // vtable 中 typeinfo 槽: [top, typeinfo, fn0, fn1...]; vptr = typeinfo槽+8
            var vptrSlot = slot.add(8);
            if (inMod(vptrSlot)) {
                try {
                    var fn0 = vptrSlot.readPointer();
                    if (inMod(fn0)) vts.push(vptrSlot);
                } catch (e) { }
            }
        });
    });
    vtables[cn] = vts;
    log("[+] " + cn + ": str=" + strHits.length + " typeinfo=" + typeinfos.length + " vtable=" + vts.length +
        (vts[0] ? " 首个vptr槽=" + rel(vts[0]) : ""));
});

// ---------- 2. 挂虚函数 ----------
var counters = {};
function allow(k, max) { counters[k] = (counters[k] || 0) + 1; return counters[k] <= max; }

Object.keys(vtables).forEach(function (cn) {
    var seen = {};
    vtables[cn].slice(0, 2).forEach(function (vptrSlot) {
        for (var i = 0; i < 6; i++) {
            try {
                var fn = vptrSlot.add(i * 8).readPointer();
                if (!inMod(fn) || seen[fn.toString()]) continue;
                seen[fn.toString()] = true;
                (function (fnAddr, label) {
                    Interceptor.attach(fnAddr, {
                        onEnter: function (a) {
                            if (!allow(label, 10)) return;
                            send({ type: "VHIT", fn: rel(fnAddr), cls: label, this: String(this.context.x0), tid: this.threadId });
                            bt(this.context, label);
                        }
                    });
                    log("    hooked " + rel(fnAddr) + " (" + label + ")");
                })(fn, cn + "[" + i + "]");
            } catch (e) { }
        }
    });
});

// ---------- 3. 存活实例扫描(关键服务对象) ----------
["mmui::P2PVOIPViewModel", "kernel::VOIPSessionInfo"].forEach(function (cn) {
    if (!vtables[cn] || !vtables[cn][0]) return;
    var vptr = vtables[cn][0];
    var pat = qwordPat(vptr);
    var found = 0;
    Process.enumerateRanges("rw-").forEach(function (r) {
        if (found > 5) return;
        try {
            Memory.scanSync(r.base, r.size, pat).forEach(function (m) {
                if (found++ > 5) return;
                send({ type: "INSTANCE", cls: cn, addr: String(m.address), where: inMod(m.address) ? "module" : "heap" });
            });
        } catch (e) { }
    });
    log("[*] " + cn + " 存活实例: " + found);
});

// ---------- 4. 音频 beacon + onPush ----------
[["0x5470688", "audioStart"], ["0x547070c", "audioStop"]].forEach(function (p) {
    try {
        Interceptor.attach(BASE.add(p[0]), {
            onEnter: function () { if (allow(p[1], 30)) send({ type: "hit", hook: p[1], ts: Date.now() }); }
        });
    } catch (e) { }
});
try {
    Interceptor.attach(BASE.add("0x59b0e94"), {
        onEnter: function () {
            try {
                var ab = this.context.x4, D = ab.readPointer(), dataPtr = D.readPointer();
                var dataLen = D.add(0xc).readU32();
                if (dataLen < 4 || dataLen > 1024 * 1024) return;
                var mem = dataPtr.readByteArray(Math.min(dataLen, 2048));
                send({ type: "push", cmdid: String(this.context.x3), len: String(dataLen), hex: mem ? Array.from(new Uint8Array(mem)).map(function (b) { return ("0" + b.toString(16)).slice(-2); }).join("") : null });
            } catch (e) { }
        }
    });
} catch (e) { }

log("=== 探针v6就绪: 请点「语音通话」响几秒挂断 ===");
