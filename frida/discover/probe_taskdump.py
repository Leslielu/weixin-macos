#!/usr/bin/env python3
"""probe_taskdump.py - 在 sendFuncAddr 入口 dump 真实 Task 结构体布局
验证 script.js 写入的三个硬编码偏移在 4.1.12 是否仍然成立:
  +0x18  -> CGI 路径字符串指针
  +0xb8  -> 自指针 x1+0xc0
  +0x190 -> 自指针 x1+0x198
用法: probe_taskdump.py [命中次数] [超时秒]
"""
import sys
import time
import frida

SEND_FUNC_OFF = 0x53E4ECC  # 4.1.12 sendFuncAddr

JS = r"""
var module = Process.enumerateModules().find(m => m.path.indexOf("Resources/wechat.dylib") >= 0);
var base = module.base;
var sendFunc = base.add(%d);
var MAXHIT = %d;
var n = 0;

function tryStr(p) {
  try {
    var s = p.readCString(64);
    if (s && s.length >= 4 && /^[\\x20-\\x7e]+$/.test(s)) return s;
  } catch (e) {}
  return null;
}

Interceptor.attach(sendFunc, {
  onEnter: function () {
    n++;
    var x0 = this.context.x0;
    var x1 = this.context.x1;
    var info = {t: "task", n: n, x0: "" + x0, x1: "" + x1, words: []};
    try {
      for (var off = 0; off <= 0x1b8; off += 8) {
        var w = x1.add(off).readPointer();
        var tag = "";
        var s = tryStr(w);
        if (s) tag = "str:'" + s + "'";
        else if (w.compare(x1) >= 0 && w.compare(x1.add(0x200)) < 0)
          tag = "SELF->x1+0x" + w.sub(x1).toString(16);
        else if (w.compare(base) >= 0 && w.compare(base.add(module.size)) < 0)
          tag = "code/dylib base+0x" + w.sub(base).toString(16);
        if (tag) info.words.push("x1+0x" + off.toString(16) + " = " + w + "  " + tag);
      }
    } catch (e) { info.err = "" + e; }
    send(info);
    if (n >= MAXHIT) send({t: "done"});
  }
});
send({t: "ready", v: "" + base});
""" % (SEND_FUNC_OFF, int(sys.argv[1]) if len(sys.argv) > 1 else 8)


def main():
    hits = int(sys.argv[1]) if len(sys.argv) > 1 else 8
    secs = int(sys.argv[2]) if len(sys.argv) > 2 else 90
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
        elif p["t"] == "task":
            print("\n[task#%d] x0=%s x1=%s" % (p["n"], p["x0"], p["x1"]), flush=True)
            for wline in p["words"]:
                print("   " + wline, flush=True)
            if "err" in p:
                print("   [dump err] " + p["err"], flush=True)
        elif p["t"] == "done":
            state["done"] = True

    script = session.create_script(JS)
    script.on("message", on_message)
    script.load()
    print("[*] 等待真实任务 (心跳即可), 目标 %d 次命中, 超时 %d 秒..." % (hits, secs), flush=True)
    t0 = time.time()
    while time.time() - t0 < secs and not state["done"]:
        time.sleep(0.5)
    session.detach()


if __name__ == "__main__":
    main()
