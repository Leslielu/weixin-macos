var baseAddr = Process.getModuleByName("WeChat").base;
console.log("[+] WeChat base: " + baseAddr);

// Test buf2RespAddr from JSON: 0x3721FA0
var buf2resp1 = baseAddr.add(0x3721FA0);
try {
    Interceptor.attach(buf2resp1, {
        onEnter: function(args) {
            var x1 = this.context.x1;
            var x2 = this.context.x2.toInt32();
            console.log("[HIT-0x3721FA0] buf2Resp triggered! x1=" + x1 + " x2=" + x2);
            if (x2 > 0 && x2 < 4096) {
                try {
                    var firstByte = x1.readU8();
                    console.log("  firstByte=0x" + firstByte.toString(16));
                } catch(e) {}
            }
        }
    });
    console.log("[+] Hooked buf2Resp at 0x3721FA0: " + buf2resp1);
} catch(e) {
    console.log("[-] Failed 0x3721FA0: " + e);
}

// Also try 0x3721FA4 (the old value from find_protobuf3.js)
var buf2resp2 = baseAddr.add(0x3721FA4);
try {
    Interceptor.attach(buf2resp2, {
        onEnter: function(args) {
            var x1 = this.context.x1;
            var x2 = this.context.x2.toInt32();
            console.log("[HIT-0x3721FA4] buf2Resp triggered! x1=" + x1 + " x2=" + x2);
        }
    });
    console.log("[+] Hooked buf2Resp at 0x3721FA4: " + buf2resp2);
} catch(e) {
    console.log("[-] Failed 0x3721FA4: " + e);
}

console.log("\n[+] 请让别人给你发一条微信消息，看哪个地址被触发。");
