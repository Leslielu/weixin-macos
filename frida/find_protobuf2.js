// 直接 hook 序列化函数 0x5E32DC0，通过返回地址找调用点
var baseAddr = Process.getModuleByName("WeChat").base;
console.log("[+] WeChat base address: " + baseAddr);

var serializationFunc = baseAddr.add(0x5E32DC0);
var callCount = 0;

try {
    Interceptor.attach(serializationFunc, {
        onEnter: function(args) {
            callCount++;
            var lr = this.context.lr;
            var offset = lr.sub(baseAddr);
            var sp = this.context.sp;
            var spVal = sp.readU32();
            console.log("[" + callCount + "] 0x5E32DC0 被调用! " +
                "LR=" + lr + " (offset=0x" + offset.toString(16) + ") " +
                "X0=" + this.context.x0 + " X1=" + this.context.x1 +
                " X2=" + this.context.x2 +
                " SP[0]=0x" + spVal.toString(16));
        }
    });
    console.log("[+] Hooked serialization func at " + serializationFunc);
} catch(e) {
    console.log("[-] Failed: " + e);

    // 如果 hook 失败，试试 Stalker 方式或换个搜索方式
    // 先搜索所有调用 0x5E32DC0 的 BL 指令
    console.log("[*] Trying Memory.scan approach...");

    var module = Process.getModuleByName("WeChat");
    // 搜索所有可能的 protobuf 相关调用
    // 尝试 hook req2bufEnterAddr 看看是否能触发
    var req2buf = baseAddr.add(0x36fc204);
    Interceptor.attach(req2buf, {
        onEnter: function(args) {
            console.log("[*] Req2Buf entered! X1=" + this.context.x1 +
                " X24=" + this.context.x24);
        }
    });
    console.log("[+] Hooked Req2Buf at " + req2buf);
}

console.log("\n[+] 请在微信里手动发一条文本消息。");
