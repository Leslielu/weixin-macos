// 探针 v9 — 武装式 Stalker: 鼠标事件突发(点击)触发, 只追 2.5s, 自动停+转储
var REAL_MOD = Process.enumerateModules().filter(function (m) {
    return /wechat\.dylib/i.test(m.name) && m.size > 100 * 1024 * 1024;
})[0];
var BASE = REAL_MOD.base;
var MOD_END = BASE.add(REAL_MOD.size);
function log(s) { send({ type: "log", msg: s }); }
function rel(p) { return "0x" + p.sub(BASE).toString(16); }
function inMod(p) { try { return p.compare(BASE) >= 0 && p.compare(BASE.add(0x20000000)) < 0; } catch (e) { return false; } }

var pid = Process.id;
var mainT = null;
Process.enumerateThreads().forEach(function (t) { if (t.id === pid) mainT = t; });
if (!mainT) mainT = Process.enumerateThreads()[0];
log("主线程 " + mainT.id);

var state = "baseline";   // baseline -> armed_wait -> hunting -> done
var baseline = {};
var hunting = {};
var huntStart = 0;

function dump() {
    var news = {};
    Object.keys(hunting).forEach(function (k) {
        if (!baseline[k]) news[k] = hunting[k];
    });
    log("[dump] 窗口函数 " + Object.keys(hunting).length + " 基线 " + Object.keys(baseline).length + " 新增 " + Object.keys(news).length);
    var keys = Object.keys(news).sort(function (a, b) { return news[b] - news[a]; });
    for (var i = 0; i < keys.length; i += 150) {
        var part = {};
        keys.slice(i, i + 150).forEach(function (k) { part[k] = news[k]; });
        send({ type: "newfuncs", part: part });
    }
    state = "done";
}

// 基线: 开跑先追 3 秒
Stalker.follow(mainT.id, {
    onCallSummary: function (summary) {
        var t = state === "baseline" ? baseline : hunting;
        Object.keys(summary).forEach(function (k) {
            if (inMod(ptr(k))) t[rel(ptr(k))] = (t[rel(ptr(k))] || 0) + summary[k];
        });
    }
});
log("[*] 基线采集中(3s)...");
setTimeout(function () {
    Stalker.unfollow(mainT.id);
    state = "armed_wait";
    log("[+] 基线完成(" + Object.keys(baseline).length + " 函数), 已武装 — 请点击语音通话");
}, 3000);

// 触发: 鼠标事件 burst
var lastEv = 0, inBurst = 0;
try {
    var cgAddr = Module.getGlobalExportByName("CGEventGetIntegerValueField");
    Interceptor.attach(cgAddr, {
        onEnter: function () {
            var now = Date.now();
            if (state === "armed_wait") {
                if (now - lastEv > 600) inBurst = 1; else inBurst++;
                if (inBurst >= 2) {
                    state = "hunting";
                    huntStart = now;
                    log("[!] 点击检测 → 开始追踪 2.5s");
                    Stalker.follow(mainT.id, {
                        onCallSummary: function (summary) {
                            Object.keys(summary).forEach(function (k) {
                                if (inMod(ptr(k))) hunting[rel(ptr(k))] = (hunting[rel(ptr(k))] || 0) + summary[k];
                            });
                        }
                    });
                    setTimeout(function () {
                        if (state === "hunting") {
                            try { Stalker.unfollow(mainT.id); } catch (e) { }
                            dump();
                        }
                    }, 2500);
                }
            }
            lastEv = now;
        }
    });
    log("[+] 点击触发器就绪");
} catch (e) { log("[-] 触发器: " + e.message); }

// audioStart 也提前转储
try {
    var dumped = false;
    Interceptor.attach(BASE.add("0x5470688"), {
        onEnter: function () {
            send({ type: "hit", hook: "audioStart", ts: Date.now() });
            if (state === "hunting" && !dumped) {
                dumped = true;
                try { Stalker.unfollow(mainT.id); } catch (e) { }
                log("[!] audioStart 提前结束追踪");
                setTimeout(dump, 200);
            }
        }
    });
} catch (e) { }

log("=== v9 就绪 ===");
