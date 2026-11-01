// 探针 v34 — 在 wechat.dylib 数据段里找 field7 本机标识 (0x20E6F20F3) 的存放位置
// 目的: 判断能否运行时直接读出来(而不是每台机器抓一次常量)
var REAL_MOD = Process.enumerateModules().filter(function (m) {
    return /wechat\.dylib/i.test(m.name) && m.size > 100 * 1024 * 1024;
})[0];
if (!REAL_MOD) throw new Error("wechat.dylib real image not found");
var BASE = REAL_MOD.base;
var CONF = Process.enumerateModules().filter(function (m) {
    return /ConfSDKdyn/i.test(m.name) && m.size > 100 * 1024;
})[0];

var UIN = 0x20E6F20F3;
var UIN2 = 0x20E690633;   // invite 里那个字段的值, 一并找

function log(s) { send({ type: "log", msg: s, ts: Date.now() }); }

function scanRange(name, base, size, val) {
    var pats = [
        ["u64", (function () { var b = []; var v = val; for (var i = 0; i < 8; i++) { b.push(("0" + ((v & 0xff).toString(16))).slice(-2)); v = Math.floor(v / 256); } return b.join(" "); })()],
        ["be32hi", null]
    ];
    var u64 = pats[0][1];
    var out = [];
    try {
        Memory.scanSync(base, size, u64).slice(0, 8).forEach(function (m) {
            out.push("u64@" + m.address + " (mod+" + m.address.sub(base).toString(16) + ")");
        });
    } catch (e) { out.push("<scan err " + e + ">"); }
    // varint 形式 f3 c1 a4 f3 02
    try {
        Memory.scanSync(base, size, "f3 c1 a4 f3 02").slice(0, 8).forEach(function (m) {
            out.push("varint@" + m.address + " (mod+" + m.address.sub(base).toString(16) + ")");
        });
    } catch (e) { out.push("<scan2 err " + e + ">"); }
    log(name + " 0x" + val.toString(16) + ": " + (out.length ? out.join(" | ") : "无命中"));
}

log("wechat.dylib base=" + BASE + " size=0x" + REAL_MOD.size.toString(16));
scanRange("wechat.dylib", BASE, REAL_MOD.size, UIN);
scanRange("wechat.dylib", BASE, REAL_MOD.size, UIN2);
if (CONF) {
    log("ConfSDKdyn base=" + CONF.base + " size=0x" + CONF.size.toString(16));
    scanRange("ConfSDKdyn", CONF.base, CONF.size, UIN);
}

// 当前拨号 pb 模板里 field7 的 hex
log("field7 varint hex = f3 c1 a4 f3 02 ; decimal = " + UIN);
