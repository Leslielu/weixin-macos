#!/usr/bin/env python3
"""probe_realtask.py - 抓真实 newsendmsg(cmdid 0x20a) 任务并全量 dump
在 sendFuncAddr 入口过滤 x1+0x60==0x20a, dump 0x220 字节全量 qword。
用法: probe_realtask.py [超时秒]
"""
import sys
import time
import frida

SEND_OFF = 0x53E4ECC  # 4.1.12 sendFuncAddr

JS = r"""
var module = Process.enumerateModules().find(m => m.path.indexOf("Resources/wechat.dylib") >= 0);
var base = module.base;
var sendFunc = base.add(%d);
var MAXHIT = 3;
var n = 0;

Interceptor.attach(sendFunc, {
  onEnter: function () {
    var x1 = this.context.x1;
    var cmdid;
    try { cmdid = x1.add(0x60).readU32(); } catch (e) { return; }
    if (cmdid !== 0x20a) return;
    n++;
    var info = {t: "newsendmsg", n: n, x0: "" + this.context.x0, x1: "" + x1, words: []};
    try {
      for (var off = 0; off <= 0x218; off += 8) {
        var w = x1.add(off).readPointer();
        var tag = "";
        try {
          var s = w.readCString(96);
          if (s && s.length >= 4 && /^[\\x20-\\x7e]+$/.test(s)) tag = "str:'" + s + "'";
        } catch (e) {}
        if (!tag && w.compare(x1) >= 0 && w.compare(x1.add(0x300)) < 0)
          tag = "SELF->x1+0x" + w.sub(x1).toString(16);
        if (!tag && w.compare(base) >= 0 && w.compare(base.add(module.size)) < 0)
          tag = "dylib base+0x" + w.sub(base).toString(16);
        info.words.push("x1+0x" + off.toString(16) + " = " + w + (tag ? "  " + tag : ""));
      }
    } catch (e) { info.err = "" + e; }
    send(info);
    if (n >= MAXHIT) send({t: "done"});
  }
});
send({t: "ready", v: "" + base});
""" % SEND_OFF


def main():
    secs = int(sys.argv[1]) if len(sys.argv) > 1 else 900
    dev = frida.get_device_manager().add_remote_device("127.0.0.1:27042")
    session = dev.attach("Gadget")
    state = {"done": False}

    def on_message(msg, data):
        if msg.get("type") != "send":
            print("[msg]", msg, flush=True)
            return
        p = msg["payload"]
        if p["t"] == "ready":
            print("[就绪] base=" + p["v"], flush=True)
        elif p["t"] == "newsendmsg":
            print("\n[newsendmsg#%d] x0=%s x1=%s" % (p["n"], p["x0"], p["x1"]), flush=True)
            for wline in p["words"]:
                print("   " + wline, flush=True)
            if "err" in p:
                print("   [err] " + p["err"], flush=True)
        elif p["t"] == "done":
            state["done"] = True

    script = session.create_script(JS)
    script.on("message", on_message)
    script.load()
    print("[*] 等 UI 手动发文本 (cmdid 0x20a), 超时 %d 秒..." % secs, flush=True)
    t0 = time.time()
    while time.time() - t0 < secs and not state["done"]:
        time.sleep(0.5)
    session.detach()


if __name__ == "__main__":
    main()
