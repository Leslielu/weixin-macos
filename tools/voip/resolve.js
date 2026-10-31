// 一次性地址解析：将 probe19 原始线程栈映射到模块与偏移
var addrs = [
    "0x10693c1e4", "0x10693f6b4", "0x106948f7c", "0x1069335c0", "0x106933fc8",
    "0x10694d524", "0x10693cf6c", "0x10693c640", "0x106949344",
    "0x10693baf4", "0x1069430e8", "0x106931cd4"
];
var out = [];
addrs.forEach(function (s) {
    var p = ptr(s);
    var m = Process.findModuleByAddress(p);
    out.push({
        address: s,
        module: m ? m.name : null,
        offset: m ? "0x" + p.sub(m.base).toString(16) : null,
        symbol: String(DebugSymbol.fromAddress(p))
    });
});
send({ type: "resolved", frames: out });
send({ type: "modules", modules: Process.enumerateModules().filter(function (m) {
    return addrs.some(function (s) { return Process.findModuleByAddress(ptr(s)) === m; });
}).map(function (m) { return { name: m.name, path: m.path, base: String(m.base), size: m.size }; }) });
