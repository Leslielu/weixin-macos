var baseAddr = Process.getModuleByName("WeChat").base;
console.log("[+] WeChat base address: " + baseAddr);

// 1. Hook req2bufEnterAddr - 这个地址已验证正确
var req2buf = baseAddr.add(0x36fc204);
try {
    Interceptor.attach(req2buf, {
        onEnter: function(args) {
            console.log("[*] Req2Buf ENTER! X0=" + this.context.x0 +
                " X1=" + this.context.x1 + " X24=" + this.context.x24 +
                " LR=" + this.context.lr +
                " (LR offset=0x" + this.context.lr.sub(baseAddr).toString(16) + ")");
        }
    });
    console.log("[+] Hooked req2bufEnterAddr at " + req2buf);
} catch(e) {
    console.log("[-] Failed to hook req2buf: " + e);
}

// 2. Hook sendFuncAddr (MMStartTask)
var sendFunc = baseAddr.add(0x47fe448);
try {
    Interceptor.attach(sendFunc, {
        onEnter: function(args) {
            console.log("[*] MMStartTask ENTER! X0=" + this.context.x0 +
                " LR=" + this.context.lr +
                " (LR offset=0x" + this.context.lr.sub(baseAddr).toString(16) + ")");
        }
    });
    console.log("[+] Hooked sendFuncAddr at " + sendFunc);
} catch(e) {
    console.log("[-] Failed to hook sendFunc: " + e);
}

// 3. Hook buf2RespAddr
var buf2resp = baseAddr.add(0x3721fa4);
try {
    Interceptor.attach(buf2resp, {
        onEnter: function(args) {
            console.log("[*] Buf2Resp ENTER! X0=" + this.context.x0 +
                " X1=" + this.context.x1 +
                " LR=" + this.context.lr);
        }
    });
    console.log("[+] Hooked buf2RespAddr at " + buf2resp);
} catch(e) {
    console.log("[-] Failed to hook buf2resp: " + e);
}

console.log("\n[+] 请在微信里手动发一条文本消息，查看哪些 hook 被触发。");
