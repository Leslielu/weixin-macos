// 探针 v70 — 本机侧: 按触发文件调用 MuteMicPhone(confEngine, on), 用于验证 AEC/半双工假设
// 触发: /tmp/mute.req 内容 = "0" 或 "1"; 每次内容变化执行一次
var CONF = Process.getModuleByName("ConfSDKdyn");
var BASE = CONF.base;
var gx = (typeof Module.getGlobalExportByName === "function")
    ? function (n) { try { return Module.getGlobalExportByName(n); } catch (e) { return null; } }
    : function (n) { try { return Module.findExportByName(null, n); } catch (e) { return null; } };
var getter = gx("GetWXConfService");
var svc = new NativeFunction(getter, "pointer", ["int"])(0x1352707);
var inner = svc.add(8).readPointer();
var engine = inner.add(0xa10).readPointer();
var muteFn = new NativeFunction(BASE.add(0x662e0), "int", ["pointer", "int"]);
function rd(p) { try { var f = new File(p, "r"); var t = f.readText(); f.close(); return t.trim(); } catch (e) { return null; } }
globalThis.__last = rd("/tmp/mute.req");
setInterval(function () {
    var s = rd("/tmp/mute.req");
    if (s === null || s === globalThis.__last) return;
    globalThis.__last = s;
    var on = s === "1" ? 1 : 0;
    var r = muteFn(engine, on);
    send({ type: "mute", on: on, ret: r, engine: String(engine) });
}, 250);
send({ type: "ready", svc: String(svc), engine: String(engine) });
