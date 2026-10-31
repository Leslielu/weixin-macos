// VoIP 通话链路发现探针 v3 — UI 命令表反查按钮处理器
// 原理: mmui 按钮有字符串ID("audio_voip_button"), 必有 {namePtr, handlerFnPtr} 表
//   1. 模块内存扫描字符串 → 地址A
//   2. 扫描指向A的QWORD指针 → 命令表槽位T
//   3. dump T±0x40, 其中落在__TEXT可执行区的指针 = 候选处理器
//   4. 校验函数序言(pacibsp/stp x29/sub sp)后挂钩
//   5. 用户点击 → 处理器命中 → 抓参数x0-x7 + backtrace = 程序化发起通话的全部素材

var REAL_MOD = Process.enumerateModules().filter(function (m) {
    return /wechat\.dylib/i.test(m.name) && m.size > 100 * 1024 * 1024;
})[0];
var BASE = REAL_MOD.base;
var MOD_SIZE = REAL_MOD.size;

function log(s) { send({ type: "log", msg: s }); }
function bt(ctx, tag) {
    try {
        var frames = Thread.backtrace(ctx, Backtracer.FUZZY).map(DebugSymbol.fromAddress);
        send({ type: "bt", tag: tag, frames: frames.slice(0, 24).map(String) });
    } catch (e) { log("bt fail " + e); }
}

// 可执行区判定: wechat.dylib __TEXT 一般在 base..base+0x1xxxxxxx 且可读可执行
var textRanges = Process.enumerateRanges("r-x").filter(function (r) {
    return r.base.compare(BASE) >= 0 && r.base.compare(BASE.add(MOD_SIZE)) < 0;
});
// 可读区段(扫描用): 避开未映射空洞
var readRanges = Process.enumerateRanges("r--").filter(function (r) {
    return r.base.compare(BASE) >= 0 && r.base.compare(BASE.add(MOD_SIZE)) < 0;
});
log("可执行区段: " + textRanges.map(function (r) { return r.base + "+" + r.size; }).join(", "));

function scanRanges(pattern) {
    var out = [];
    readRanges.forEach(function (r) {
        try {
            Memory.scanSync(r.base, r.size, pattern).forEach(function (m) { out.push(m); });
        } catch (e) { }
    });
    return out;
}

function isCodePtr(p) {
    if (p.isNull()) return false;
    for (var i = 0; i < textRanges.length; i++) {
        var r = textRanges[i];
        if (p.compare(r.base) >= 0 && p.compare(r.base.add(r.size)) < 0) return true;
    }
    return false;
}

// 函数序言白名单 (arm64e / arm64 常见)
function looksLikeFunction(p) {
    try {
        var w = p.readU32();
        // pacibsp=0xD50323FF, stp x29,x30,[sp,#-N]! 掩码, sub sp 掩码, stp x2x 系
        if (w === 0xD50323FF) return true;                    // pacibsp
        if ((w & 0xFFE07FFF) === 0xA9807BFD) return true;     // stp x29,x30,[sp,#imm]!
        if ((w & 0xFF0003FF) === 0xD10003FF) return true;     // sub sp, sp, #imm
        if ((w & 0xFFC003E0) === 0xA9000000) return true;     // stp 系列宽匹配
        if (w === 0xD503201F) return true;                    // nop (pad)
    } catch (e) { }
    return false;
}

// ---------- 1. 扫字符串 ----------
var NEEDLES = ["audio_voip_button", "video_voip_button"];
var strAddrs = {};
function asciiHex(s) {
    var out = [];
    for (var i = 0; i < s.length; i++) {
        out.push(("0" + s.charCodeAt(i).toString(16)).slice(-2));
    }
    return out.join(" ");
}
NEEDLES.forEach(function (n) {
    scanRanges(asciiHex(n)).forEach(function (m) {
        // 只收以 NUL 结尾的完整 C 字符串
        try {
            var s = m.address.readCString();
            if (s === n) {
                strAddrs[n] = m.address;
                log("[str] " + n + " @ " + m.address);
            }
        } catch (e) { }
    });
});

// ---------- 2. 找指向字符串的指针(命令表槽位) ----------
var candidates = {};   // addr -> labels
var dumped = {};
Object.keys(strAddrs).forEach(function (n) {
    var target = strAddrs[n];
    var hexstr = target.toString(16);
    while (hexstr.length < 16) hexstr = "0" + hexstr;
    var le = "";
    for (var i = 14; i >= 0; i -= 2) le += hexstr.substr(i, 2) + " ";
    scanRanges(le.trim()).forEach(function (m) {
        var slot = m.address;
        var key = slot.toString();
        if (dumped[key]) return;
        dumped[key] = true;
        // dump 槽位附近 0x40 前后
        try {
            var around = slot.sub(0x20).readByteArray(0x80);
            send({
                type: "table", needle: n, slot: slot.toString(),
                hex: Array.from(new Uint8Array(around)).map(function (b) {
                    return ("0" + b.toString(16)).slice(-2);
                }).join("")
            });
        } catch (e) { }
        // 前后 0x20 内的 8 字节对齐 QWORD 若指向代码区 → 候选
        for (var off = -0x20; off <= 0x20; off += 8) {
            try {
                var q = slot.add(off).readPointer();
                if (isCodePtr(q) && looksLikeFunction(q)) {
                    var k = q.toString();
                    candidates[k] = (candidates[k] || []) .concat([n + (off < 0 ? "-" : "+") + Math.abs(off)]);
                }
            } catch (e) { }
        }
    });
});

log("候选处理器: " + JSON.stringify(candidates, null, 1));

// ---------- 3. 挂钩候选 ----------
var hitCount = {};
Object.keys(candidates).forEach(function (addrStr) {
    try {
        Interceptor.attach(ptr(addrStr), {
            onEnter: function (a) {
                var c = (hitCount[addrStr] = (hitCount[addrStr] || 0) + 1);
                if (c > 8) return;
                send({
                    type: "CANDIDATE_HIT", fn: addrStr, labels: candidates[addrStr],
                    x0: String(this.context.x0), x1: String(this.context.x1),
                    x2: String(this.context.x2), x3: String(this.context.x3),
                    x4: String(this.context.x4), x5: String(this.context.x5),
                    tid: this.threadId
                });
                // x0 若像指针, dump 指向内容
                try {
                    var p = this.context.x0;
                    if (!p.isNull() && p.compare(ptr(0x1000)) > 0) {
                        send({ type: "x0dump", fn: addrStr, hex: Array.from(new Uint8Array(p.readByteArray(64))).map(function (b) { return ("0" + b.toString(16)).slice(-2); }).join("") });
                    }
                } catch (e) { }
                bt(this.context, "cand@" + addrStr);
            }
        });
        log("[+] 挂上候选 " + addrStr + " (" + candidates[addrStr].join(",") + ")");
    } catch (e) { log("[-] 挂钩失败 " + addrStr + ": " + e.message); }
});

// ---------- 4. 保留 onPush (来电事件) ----------
var MAXB = 1024 * 1024;
try {
    Interceptor.attach(BASE.add("0x59b0e94"), {
        onEnter: function () {
            try {
                var ab = this.context.x4;
                var D = ab.readPointer();
                var dataPtr = D.readPointer();
                var dataLen = D.add(0xc).readU32();
                if (dataLen < 4 || dataLen > MAXB) return;
                var mem = dataPtr.readByteArray(Math.min(dataLen, 4096));
                send({
                    type: "push", cmdid: String(this.context.x3), len: String(dataLen),
                    hex: mem ? Array.from(new Uint8Array(mem)).map(function (b) {
                        return ("0" + b.toString(16)).slice(-2);
                    }).join("") : null
                });
            } catch (e) { }
        }
    });
    log("[+] onPush 已挂");
} catch (e) { log("[-] onPush: " + e.message); }

log("=== 探针v3就绪: 请再点一次「语音通话」并响几秒挂断 ===");
