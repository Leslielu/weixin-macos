// 用于查找正确的 protobufAddr
// 使用方法: frida -H 127.0.0.1:27042 -n Gadget -l ./frida/find_protobuf.js
// 然后在微信里手动发一条文本消息，看哪个地址被触发

var baseAddr = Process.getModuleByName("WeChat").base;
console.log("[+] WeChat base address: " + baseAddr);

// 三个候选 protobufAddr (都是 BL 0x5E32DC0 的调用点，带 BRK+MOV+大栈帧特征)
var candidates = [
    { name: "Candidate1", offset: 0x24433D8 },
    { name: "Candidate2", offset: 0x245E9B0 },
    { name: "Candidate3", offset: 0x24678C4 },
];

candidates.forEach(function(c) {
    var addr = baseAddr.add(c.offset);
    try {
        Interceptor.attach(addr, {
            onEnter: function(args) {
                var sp = this.context.sp;
                var taskId = sp.readU32();
                console.log("[***] " + c.name + " (offset 0x" + c.offset.toString(16) +
                    ") 被触发! SP[0]=0x" + taskId.toString(16) +
                    " X0=" + this.context.x0 +
                    " X1=" + this.context.x1);
            }
        });
        console.log("[+] Hooked " + c.name + " at " + addr + " (offset 0x" + c.offset.toString(16) + ")");
    } catch(e) {
        console.log("[-] Failed to hook " + c.name + " at " + addr + ": " + e);
    }
});

// 也 hook Req2Buf 里直接调用 0x5E32DC0 的位置
var req2bufBL = baseAddr.add(0x36FC178);
try {
    Interceptor.attach(req2bufBL, {
        onEnter: function(args) {
            var sp = this.context.sp;
            var taskId = sp.readU32();
            console.log("[***] Req2Buf-BL (offset 0x36FC178) 被触发! SP[0]=0x" +
                taskId.toString(16) + " X1=" + this.context.x1);
        }
    });
    console.log("[+] Hooked Req2Buf-BL at " + req2bufBL);
} catch(e) {
    console.log("[-] Failed to hook Req2Buf-BL: " + e);
}

// 也检查 vtable 里的两个 BL 0x5E32DC0 调用点
[0x24664C0, 0x24665F0].forEach(function(offset) {
    var addr = baseAddr.add(offset);
    try {
        Interceptor.attach(addr, {
            onEnter: function(args) {
                var sp = this.context.sp;
                var taskId = sp.readU32();
                console.log("[***] VTable-BL (offset 0x" + offset.toString(16) +
                    ") 被触发! SP[0]=0x" + taskId.toString(16) +
                    " X0=" + this.context.x0 + " X1=" + this.context.x1);
            }
        });
        console.log("[+] Hooked VTable-BL at " + addr + " (offset 0x" + offset.toString(16) + ")");
    } catch(e) {
        console.log("[-] Failed to hook VTable-BL at " + addr + ": " + e);
    }
});

console.log("\n[+] 所有 hook 已设置。请在微信里手动发一条文本消息，然后查看哪些地址被触发。");
