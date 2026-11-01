// 探针 v50 — 跟随 ConfSDKdyn 的 thunk 跳转到真实实现并反汇编
// vt[17]=+0x7a370 PutExternalRecordData / vt[18]=+0x7a388 / vt[19]=+0x7a3a8
// 三个都是 "ldr x0,[x0,#8]; cbz; b target" 形式, 这里解析 b 目标后反汇编。
var CONF = Process.enumerateModules().filter(function (m) {
    return m.name.indexOf("ConfSDKdyn") !== -1 && m.size > 100 * 1024;
})[0];
if (!CONF) throw new Error("ConfSDKdyn not found");

function dis(addr, n) {
    var out = [], ins = Instruction.parse(addr);
    for (var i = 0; i < n; i++) {
        out.push((ins.address.sub(CONF.base) >= 0 ? "+0x" + ins.address.sub(CONF.base).toString(16) : ins.address.toString())
                 + "  " + ins.mnemonic + " " + ins.opStr);
        ins = Instruction.parse(ins.next);
    }
    return out;
}

[0x7a370, 0x7a388, 0x7a3a8].forEach(function (off) {
    var thunk = CONF.base.add(off);
    var lines = dis(thunk, 6);
    // 找尾跳转目标
    var target = null;
    var ins = Instruction.parse(thunk);
    for (var i = 0; i < 6; i++) {
        if (ins.mnemonic === "b" || ins.mnemonic === "bl") {
            var op = ins.opStr.replace("#", "");
            try {
                var a = ptr(op);
                if (a.compare(CONF.base) >= 0 && a.compare(CONF.base.add(CONF.size)) < 0) target = a;
            } catch (e) {}
        }
        ins = Instruction.parse(ins.next);
    }
    send({ type: "thunk", at: "0x" + off.toString(16), target: target ? "+0x" + target.sub(CONF.base).toString(16) : null,
           lines: lines, ts: Date.now() });
    if (target) {
        send({ type: "impl", at: "+0x" + target.sub(CONF.base).toString(16), lines: dis(target, 90), ts: Date.now() });
        // 再看它内部调用的第一个 bl 目标
        var ins2 = Instruction.parse(target), calls = [];
        for (var k = 0; k < 90; k++) {
            if (ins2.mnemonic === "bl") {
                var t = ins2.opStr.replace("#", "");
                try {
                    var a2 = ptr(t);
                    if (a2.compare(CONF.base) >= 0) calls.push("+0x" + a2.sub(CONF.base).toString(16));
                } catch (e) {}
            }
            ins2 = Instruction.parse(ins2.next);
        }
        send({ type: "calls", at: "+0x" + target.sub(CONF.base).toString(16), calls: calls, ts: Date.now() });
    }
});
send({ type: "done", ts: Date.now() });
