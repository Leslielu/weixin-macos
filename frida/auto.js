
function scanPatterns(patterns) {
    var module = Process.getModuleByName("WeChat");
    if (!module) {
        console.error("[!] 找不到 WeChat 模块基址，请检查进程名。");
    }

    patterns.forEach((item, index) => {
        const { name, pattern } = item;

        // 2. 使用 Memory.scan 进行异步扫描
        Memory.scan(module.base, module.size, pattern, {
            onMatch: function(address, size) {
                // 计算相对偏移 (RVA)
                const offset = address.sub(module.base);
                console.log(`[!] 找到特征 [${name}], 绝对地址: ${address} 相对偏移: ${offset}`);

                // 如果你只想找第一个匹配项，可以在这里 return 'stop';
            },
            onError: function(reason) {
                console.error(`[-] 扫描 [${name}] 时出错: ${reason}`);
            },
            onComplete: function() {
                // 扫描完成的回调
            }
        });
    });
}


// 特征码数组：? 代表通配符，空格可选
const myPatterns = [
    {
        name: "uploadOnCompleteAddr",
        pattern: "08 19 40 F9 E1 03 14 AA E2 03 15 AA 00 01 3F D6"
    },
    {
        name: "uploadGetCallbackWrapperAddr",
        pattern: "08 09 40 F9 E1 03 15 AA E2 03 14 AA E3 03 13 AA 00 01 3F D6 F3 07 40 F9 B3 00 00 B4"
    },
    {
        name: "req2bufEnterAddr",
        pattern: "09 0F 46 F8 C9 01 00 B4 E8 03 18 AA 2A 21 40 B9"
    },
    {
        name: "downloadImagAddr",
        pattern: "FF 07 00 B9 68 52 41 F9  15 89 41 F9 E0 03 14 AA"
    },
    {
        name: "uploadImageAddr",
        pattern: "F8 5F 02 A9 F6 57 03 A9 F4 4F 04 A9 FD 7B 05 A9 FD 43 01 91 FF 43 0B D1 F3 03 01 AA F4 03 00 AA 68 E1 01 F0 08 71 44 F9 08 01 40 F9 A8 83 1A F8"
    },
    {
        name: "sendFuncAddr",
        pattern: "FF 03 05 D1 FC 6F 11 A9 F4 4F 12 A9 FD 7B 13 A9  FD C3 04 91 F3 03 01 AA F4 03 00 AA A8 EB 01 D0  08 71 44 F9 08 01 40 F9 A8 83 1D F8"
    },
    {
        name: "buf2RespAddr",
        pattern: "3C 00 80 52  E0 C3 00 91"
    }
];

// 执行扫描
scanPatterns(myPatterns);