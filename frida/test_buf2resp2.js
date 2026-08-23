var baseAddr = Process.getModuleByName("WeChat").base;
var buf2resp = baseAddr.add(0x3721FA0);

Interceptor.attach(buf2resp, {
    onEnter: function(args) {
        var x1 = this.context.x1;
        var x2 = this.context.x2.toInt32();
        var firstByte = x1.readU8();
        if (firstByte !== 0x08) return;

        console.log("\n[HIT] buf2Resp x2=" + x2);

        // Dump first 0x30 bytes to see structure
        console.log(hexdump(x1, { length: Math.min(x2, 0x40), header: true, ansi: true }));

        // Check what's at offsets 0x1d and 0x1e
        var val1d = x1.add(0x1d).readU8();
        var val1e = x1.add(0x1e).readU8();
        console.log("  offset 0x1d = 0x" + val1d.toString(16) + " (" + val1d + ")");
        console.log("  offset 0x1e = 0x" + val1e.toString(16) + " (" + val1e + ")");

        // Try to find the actual wxid string
        for (var i = 0x10; i < 0x30; i++) {
            try {
                var b = x1.add(i).readU8();
                if (b >= 0x0a && b <= 0x20) {
                    var nextLen = x1.add(i).readU8();
                    var strStart = x1.add(i + 1);
                    var preview = strStart.readUtf8String(Math.min(nextLen, 30));
                    if (preview && preview.indexOf("wxid_") === 0) {
                        console.log("  Found wxid at offset 0x" + i.toString(16) + " len=" + nextLen + " : " + preview);
                    }
                }
            } catch(e) {}
        }
    }
});

console.log("[+] Hooked, 请让别人发消息...");
