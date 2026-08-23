var baseAddr = Process.getModuleByName("WeChat").base;
var moduleSize = Process.getModuleByName("WeChat").size;
console.log("[+] WeChat base: " + baseAddr + " size: 0x" + moduleSize.toString(16));

// Hook Req2Buf, 追踪进入后调用了哪些函数
var req2buf = baseAddr.add(0x36fc204);
var traced = false;

Interceptor.attach(req2buf, {
    onEnter: function(args) {
        var taskId = this.context.x1.toInt32();
        console.log("[*] Req2Buf ENTER, X1(taskId)=0x" + taskId.toString(16));

        // 只追踪一次，避免太多日志
        if (traced) return;
        traced = true;

        var tid = this.threadId;
        var calledFuncs = [];

        Stalker.follow(tid, {
            events: { call: true },
            onReceive: function(events) {
                var parsed = Stalker.parse(events, {annotate: true, stringify: false});
                for (var i = 0; i < parsed.length; i++) {
                    var ev = parsed[i];
                    // ev = [type, from, to] for call events
                    if (ev[0] === 'call') {
                        var from = ptr(ev[1]);
                        var to = ptr(ev[2]);
                        var fromOff = from.sub(baseAddr);
                        var toOff = to.sub(baseAddr);
                        // 只记录 WeChat 模块内的调用
                        if (toOff.compare(ptr(0)) > 0 && toOff.compare(ptr(moduleSize)) < 0) {
                            calledFuncs.push({
                                from: "0x" + fromOff.toString(16),
                                to: "0x" + toOff.toString(16)
                            });
                        }
                    }
                }
            }
        });

        // 200ms 后停止追踪并打印结果
        setTimeout(function() {
            Stalker.unfollow(tid);
            Stalker.flush();
            console.log("\n[+] Req2Buf 调用追踪结果 (" + calledFuncs.length + " calls):");
            // 去重并打印
            var seen = {};
            calledFuncs.forEach(function(c) {
                var key = c.from + "->" + c.to;
                if (!seen[key]) {
                    seen[key] = true;
                    console.log("  CALL from " + c.from + " -> " + c.to);
                }
            });
        }, 200);
    }
});

console.log("[+] 请在微信里手动发一条文本消息。");
