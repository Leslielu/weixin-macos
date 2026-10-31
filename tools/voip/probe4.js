// VoIP 通话链路发现探针 v4 — 主线程 Stalker 调用追踪 + 音频引擎转储
// 策略:
//   1. Stalker.follow 主线程, onCallSummary 聚合调用目标(只留 wechat.dylib 内的)
//   2. 前 12 秒收集基线
//   3. audioEngineStart(0x5470688)命中 → dump 最近窗口的调用目标集合(带计数)
//   4. 差集分析在主机侧做: 呼叫窗口新出现的函数 = 按钮处理器→VoIP服务链

var REAL_MOD = Process.enumerateModules().filter(function (m) {
    return /wechat\.dylib/i.test(m.name) && m.size > 100 * 1024 * 1024;
})[0];
var BASE = REAL_MOD.base;
var MOD_END = BASE.add(REAL_MOD.size);

function log(s) { send({ type: "log", msg: s }); }
function inMod(p) {
    try { return p.compare(BASE) >= 0 && p.compare(MOD_END) < 0; } catch (e) { return false; }
}
function rel(p) { return "0x" + p.sub(BASE).toString(16); }

// ---------- 主线程 ----------
var pid = Process.id;
var mainT = null;
Process.enumerateThreads().forEach(function (t) { if (t.id === pid) mainT = t; });
if (!mainT) mainT = Process.enumerateThreads()[0];
log("PID=" + pid + " 主线程=" + mainT.id);

// ---------- 滚筒 ----------
var RING_MAX = 40;
var ring = [];            // [{ts, summary:{relAddr:count}}]
var baseline = {};        // {relAddr: count} 基线累计
var baselineUntil = Date.now() + 12000;
var baseTotal = 0;

Stalker.follow(mainT.id, {
    onCallSummary: function (summary) {
        var now = Date.now();
        var clean = {};
        Object.keys(summary).forEach(function (k) {
            var p = ptr(k);
            if (inMod(p)) clean[rel(p)] = summary[k];
        });
        if (now < baselineUntil) {
            Object.keys(clean).forEach(function (k) {
                baseline[k] = (baseline[k] || 0) + clean[k];
                baseTotal += clean[k];
            });
            if (ring.length === 0) log("[*] 基线采集中... " + Math.ceil((baselineUntil - now) / 1000) + "s");
            return;
        }
        ring.push({ ts: now, s: clean });
        if (ring.length > RING_MAX) ring.shift();
    }
});
log("[+] Stalker 已跟随主线程, 12秒基线后就绪");

// ---------- 转储触发: 音频引擎启动 ----------
var dumped = false;
Interceptor.attach(BASE.add("0x5470688"), {
    onEnter: function () {
        if (dumped) return;
        dumped = true;
        log("[!] audioEngineStart 命中 → 转储主线程调用窗");
        try { Stalker.unfollow(mainT.id); } catch (e) { }
        // 合并最近 8 秒窗口
        var cut = Date.now() - 8000;
        var merged = {};
        var kept = 0;
        ring.forEach(function (w) {
            if (w.ts < cut) return;
            Object.keys(w.s).forEach(function (k) {
                merged[k] = (merged[k] || 0) + w.s[k];
                kept += w.s[k];
            });
        });
        // 分包发送(每包200条)
        var keys = Object.keys(merged);
        log("[*] 窗口函数数=" + keys.length + " 调用数=" + kept + " 基线函数数=" + Object.keys(baseline).length);
        for (var i = 0; i < keys.length; i += 200) {
            var part = {};
            keys.slice(i, i + 200).forEach(function (k) { part[k] = merged[k]; });
            send({ type: "window", part: part });
        }
        send({ type: "baseline", addrs: Object.keys(baseline), total: baseTotal });
        log("[*] 转储完成");
    }
});

// ---------- onPush 保留 ----------
try {
    Interceptor.attach(BASE.add("0x59b0e94"), {
        onEnter: function () {
            try {
                var ab = this.context.x4;
                var D = ab.readPointer();
                var dataPtr = D.readPointer();
                var dataLen = D.add(0xc).readU32();
                if (dataLen < 4 || dataLen > 1024 * 1024) return;
                var mem = dataPtr.readByteArray(Math.min(dataLen, 2048));
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

log("=== 探针v4: 等12秒基线, 然后请点「语音通话」响几秒挂断 ===");
