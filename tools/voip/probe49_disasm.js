// 探针 v49 — 静态反汇编 ConfSDKdyn 的 PutExternalRecordData (+0x7a370) 及邻近符号
// 用途: 弄清 putExternal 的语义(是否入环形缓冲/是否有固定帧长/返回值含义)，解释注入音频被吞半、
//       周期性断流的根因。只读，不发任何调用。
var CONF = Process.enumerateModules().filter(function (m) {
    return m.name.indexOf("ConfSDKdyn") !== -1 && m.size > 100 * 1024;
})[0];
if (!CONF) throw new Error("ConfSDKdyn not found");
send({ type: "log", msg: "base=" + CONF.base + " path=" + CONF.path, ts: Date.now() });

function dis(addr, n) {
    var out = [], ins = Instruction.parse(addr);
    for (var i = 0; i < n; i++) {
        out.push(ins.address.sub(CONF.base) + "  " + ins.mnemonic + " " + ins.opStr);
        ins = Instruction.parse(ins.next);
    }
    return out;
}

[-0x40, 0, 0x20].forEach(function (delta) {
    try {
        send({ type: "disasm", at: "+0x7a370" + (delta >= 0 ? "+" : "") + (delta ? "0x" + delta.toString(16) : ""),
               lines: dis(CONF.base.add(0x7a370 + delta), 48), ts: Date.now() });
    } catch (e) { send({ type: "err", msg: String(e) }); }
});

// 邻居: 播放侧三个函数各前 24 条
[0x7a388, 0x7a3a8].forEach(function (off) {
    try { send({ type: "disasm", at: "+0x" + off.toString(16), lines: dis(CONF.base.add(off), 24), ts: Date.now() }); }
    catch (e) { send({ type: "err", msg: String(e) }); }
});
