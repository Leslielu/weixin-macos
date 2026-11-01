// 探针 v60 — 反汇编 MultiMediaDyn 的 VoiceOpus* 取参函数, 找编解码器真实帧长/采样率
var MM = Process.enumerateModules().filter(function (m) {
    return m.name.indexOf("MultiMediaDyn") !== -1 && m.size > 1000000;
})[0];
function where(p) {
    var m = Process.findModuleByAddress(p);
    if (!m) return "?(" + p + ")";
    return m.name + "+0x" + p.sub(m.base).toString(16);
}
function dis(addr, n) {
    var out = [], ins = Instruction.parse(addr);
    for (var i = 0; i < n; i++) {
        out.push(where(ins.address) + "  " + ins.mnemonic + " " + ins.opStr);
        ins = Instruction.parse(ins.next);
    }
    return out;
}
var names = ["VoiceOpus_GetSampleRate", "VoiceOpus_GetChannels", "VoiceOpus_GetBitrate",
             "VoiceOpus_GetFrameSamples", "VoiceOpusStream_GetSampleRate", "VoiceOpusStream_GetChannels"];
var ex = MM.enumerateExports();
names.forEach(function (nm) {
    var e = ex.filter(function (x) { return x.name === nm; })[0];
    if (!e) { send({ type: "miss", name: nm, ts: Date.now() }); return; }
    send({ type: "fn", name: nm, addr: where(e.address), lines: dis(e.address, 24), ts: Date.now() });
});
// 也扫描全部语音相关导出
var all = ex.filter(function (x) { return /voice|opus|silk|amr|aac/i.test(x.name); });
send({ type: "all", n: all.length, list: all.map(function (x) { return x.name + "@0x" + x.address.sub(MM.base).toString(16); }).join("\n"), ts: Date.now() });
send({ type: "done", ts: Date.now() });
