#!/usr/bin/env python3
"""probe_taskdump2.py - 全量 dump 真实 Task 结构体 (qword 全打印 + newsendmsg 识别)
用法: probe_taskdump2.py <send_func_off_hex> <gadget_port> [命中次数] [超时秒]
"""
import sys
import time
import frida

SEND_OFF = int(sys.argv[1], 16) if len(sys.argv) > 1 else 0x53E4ECC
PORT = sys.argv[2] if len(sys.argv) > 2 else "27042"
MAXHIT = int(sys.argv[3]) if len(sys.argv) > 3 else 10
SECS = int(sys.argv[4]) if len(sys.argv) > 4 else 300

JS = r"""
var module = Process.enumerateModules().find(m => m.path.indexOf("Resources/wechat.dylib") >= 0);
var base = module.base;
var sendFunc = base.add(%d);
var MAXHIT = %d;
var n = 0;

function tryStr(p) {
  try {
    var s = p.readCString(96);
    if (s && s.length >= 4 && /^[\\x20-\\x7e]+$/.test(s)) return s;
  } catch (e) {}
  return null;
}

Interceptor.attach(sendFunc, {
  onEnter: function () {
    n++;
    var x0 = this.context.x0;
    var x1 = this.context.x1;
    var info = {t: "task", n: n, x0: "" + x0, x1: "" + x1, words: [], newsendmsg: false};
    try {
      for (var off = 0; off <= 0x1b8; off += 8) {
        var w = x1.add(off).readPointer();
        var tag = "";
        var s = tryStr(w);
        if (s) {
          tag = "str:'" + s + "'";
          if (s.indexOf("newsendmsg") >= 0) info.newsendmsg = true;
        }
        else if (w.compare(x1) >= 0 && w.compare(x1.add(0x200)) < 0)
          tag = "SELF->x1+0x" + w.sub(x1).toString(16);
        else if (w.compare(base) >= 0 && w.compare(base.add(module.size)) < 0)
          tag = "dylib base+0x" + w.sub(base).toString(16);
        info.words.push("x1+0x" + off.toString(16) + " = " + w + (tag ? "  " + tag : ""));
      }
      info.head = x1.readByteArray(0x40);
    } catch (e) { info.err = "" + e; }
    send(info);
    if (n >= MAXHIT) send({t: "done"});
  }
});
send({t: "ready", v: "" + base});
""" % (SEND_OFF, MAXHIT)


def main():
    dev = frida.get_device_manager().add_remote_device("127.0.0.1:" + PORT)
    session = dev.attach("Gadget")
    state = {"done": False}

    def on_message(msg, data):
        if msg.get("type") != "send":
            print("[msg]", msg, flush=True)
            return
        p = msg["payload"]
        if p["t"] == "ready":
            print("[就绪] base=" + p["v"], flush=True)
        elif p["t"] == "task":
            mark = " <<< newsendmsg" if p.get("newsendmsg") else ""
            print("\n[task#%d]%s x0=%s x1=%s" % (p["n"], mark, p["x0"], p["x1"]), flush=True)
            for wline in p["words"]:
                print("   " + wline, flush=True)
            if "err" in p:
                print("   [dump err] " + p["err"], flush=True)
        elif p["t"] == "done":
            state["done"] = True

    script = session.create_script(JS)
    script.on("message", on_message)
    script.load()
    print("[*] dump 就绪 port=%s sendoff=0x%x, 目标 %d 次, 超时 %d 秒" % (PORT, SEND_OFF, MAXHIT, SECS), flush=True)
    t0 = time.time()
    while time.time() - t0 < SECS and not state["done"]:
        time.sleep(0.5)
    session.detach()


if __name__ == "__main__":
    main()
