// 探针 v51 — 反汇编 ConfSDKdyn 引擎层 putExternal 真实实现
// thunk(+0x7a370) -> +0x38424 (x0 = [svc+8]+0xa10) -> +0x65cd4(x0=engine, x1=data, x2=len, x3=rate, x4=ch)
// 同时对比 play 侧 +0x65e20 / +0x66000。
var CONF = Process.enumerateModules().filter(function (m) {
    return m.name.indexOf("ConfSDKdyn") !== -1 && m.size > 100 * 1024;
})[0];
if (!CONF) throw new Error("ConfSDKdyn not found");

function dis(addr, n) {
    var out = [], ins = Instruction.parse(addr);
    for (var i = 0; i < n; i++) {
        var off = ins.address.sub(CONF.base);
        out.push("+0x" + off.toString(16) + "  " + ins.mnemonic + " " + ins.opStr);
        ins = Instruction.parse(ins.next);
    }
    return out;
}
[0x65cd4, 0x65e20, 0x66000].forEach(function (off) {
    send({ type: "impl", at: "+0x" + off.toString(16), lines: dis(CONF.base.add(off), 160), ts: Date.now() });
});
send({ type: "done", ts: Date.now() });
