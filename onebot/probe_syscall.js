// probe_syscall.js — 只读探针: 探测微信网络线程空闲期高频进入的 syscall
// 用途: 为出队泵扩容找候选符号(生产 7 符号泵空闲期零命中实锤)
// 纯观测: 只计数不打扰, 不 drain 不写内存。本机开发环境专用, 会 detach, 禁止上生产。
// 基址 = 真身 wechat.dylib(全进程唯一 >50MB 同名模块, 复刻 script.js 模块表解析)
var wechatModules = Process.enumerateModules().filter(function (m) { return m.name === "wechat.dylib"; });
wechatModules.sort(function (a, b) { return b.size - a.size; });
var moduleBase = wechatModules.length ? wechatModules[0].base : null;
if (!moduleBase) { throw new Error("[-] Cannot find wechat.dylib"); }
console.log("[probe] wechat.dylib base: " + moduleBase);

// 4.1.13.63 offsets (wechat_version/4_1_13_63_mac.json)
var respDispatchAddr = moduleBase.add(0x42e5044);
var onPushAddr = moduleBase.add(0x59b0e94);
var req2bufEnterAddr = moduleBase.add(0x42e3450);

var validTids = {};
var counts = {};
var evCounts = { resp: 0, push: 0, submit: 0 };

// 三个原生事件点: 合法 tid 来源(与生产 v3ValidTids 同源)
Interceptor.attach(respDispatchAddr, { onEnter: function () { validTids[this.threadId] = 1; evCounts.resp++; } });
Interceptor.attach(onPushAddr, { onEnter: function () { validTids[this.threadId] = 1; evCounts.push++; } });
Interceptor.attach(req2bufEnterAddr, { onEnter: function () { validTids[this.threadId] = 1; evCounts.submit++; } });
console.log("[probe] event hooks armed (resp-dispatch/onPush/submitCgi-entry)");

function symAddr(name) {
    var addr = null;
    try { if (typeof Module.getGlobalExportByName === "function") addr = Module.getGlobalExportByName(name); } catch (e1) {}
    if (!addr) { try { addr = Module.findExportByName(null, name); } catch (e2) {}
    if (!addr) { try { addr = Process.getModuleByName("libsystem_kernel.dylib").getExportByName(name); } catch (e3) {} } }
    return (addr && !addr.isNull()) ? addr : null;
}

// 候选 syscall 全集: 现有7个 + 高频原语候选
var CANDIDATES = ["mach_msg", "psynch_cvwait", "kevent", "kevent64", "kevent_qos",
    "select", "poll", "recvfrom", "read", "write", "sendto", "recvfrom",
    "workq_kernreturn", "__semwait_signal", "proc_info", "mach_msg_overwrite",
    "gettimeofday", "clock_gettime", "host_create_mach_voucher", "task_info"];
var armed = [];
var perTid = {};  // tid -> {syscallName -> n}
CANDIDATES.forEach(function (name) {
    var addr = symAddr(name);
    if (!addr) return;
    try {
        counts[name] = 0;
        Interceptor.attach(addr, {
            onEnter: function () {
                var tid = this.threadId;
                if (!validTids[tid]) return;
                counts[name]++;
                var bucket = perTid[tid];
                if (!bucket) { bucket = perTid[tid] = {}; }
                bucket[name] = (bucket[name] || 0) + 1;
            }
        });
        armed.push(name);
    } catch (eA) { /* skip */ }
});
console.log("[probe] syscall counters armed: " + armed.join(","));

// 10s 汇总(setTimeout 自循环): 事件点流量 + 每tid每符号命中数
function probeReport() {
    var tidLines = [];
    for (var tid in perTid) {
        var parts = [];
        var b = perTid[tid];
        for (var name in b) { if (b[name] > 0) { parts.push(name + "=" + b[name]); b[name] = 0; } }
        if (parts.length) tidLines.push("tid" + tid + "{" + parts.join(" ") + "}");
    }
    console.log("[probe10s] ev(resp/push/submit)=" + evCounts.resp + "/" + evCounts.push + "/" + evCounts.submit +
        " | " + (tidLines.join(" | ") || "(合法tid零syscall)"));
    evCounts.resp = 0; evCounts.push = 0; evCounts.submit = 0;
    setTimeout(probeReport, 10000);
}
setTimeout(probeReport, 10000);
