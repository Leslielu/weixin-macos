#!/usr/bin/env python3
"""probe_crash.py - Process.setExceptionHandler 抓 EXC_BAD_ACCESS/SIGABRT 现场
任何线程崩溃都打印: 异常类型/地址/寄存器/backtrace(base相对偏移)。
用法: probe_crash.py [秒数]
"""
import sys
import time
import frida

JS = r"""
var module = Process.enumerateModules().find(m => m.path.indexOf("Resources/wechat.dylib") >= 0);
var base = module.base;

Process.setExceptionHandler(function (details) {
  var msg = {
    t: "EXC",
    type: details.type,
    address: "" + details.address,
    pc: "" + details.context.pc,
    pcRel: "base+0x" + details.context.pc.sub(base).toString(16),
    frames: []
  };
  try {
    var bt = Thread.backtrace(details.context, Backtracer.ACCURATE);
    for (var a of bt) {
      var s = "" + a;
      if (a.compare(base) >= 0 && a.compare(base.add(module.size)) < 0)
        s = "dylib base+0x" + a.sub(base).toString(16);
      msg.frames.push(s);
      if (msg.frames.length >= 16) break;
    }
  } catch (e) { msg.bterr = "" + e; }
  send(msg);
  return false;  // 交给默认处理(让 frida NativeFunction 吞掉或进程崩溃)
});
send({t: "ready", v: "" + base});
"""


def main():
    secs = int(sys.argv[1]) if len(sys.argv) > 1 else 600
    dev = frida.get_device_manager().add_remote_device("127.0.0.1:27042")
    session = dev.attach("Gadget")

    def on_message(msg, data):
        if msg.get("type") != "send":
            print("[msg]", msg, flush=True)
            return
        p = msg["payload"]
        if p["t"] == "ready":
            print("[就绪] base=" + p["v"], flush=True)
        elif p["t"] == "EXC":
            print("\n[*** 异常 %s @ %s ***] pc=%s (%s)" % (p["type"], p["address"], p["pc"], p["pcRel"]), flush=True)
            for i, f in enumerate(p["frames"]):
                print("  #%02d %s" % (i, f), flush=True)

    script = session.create_script(JS)
    script.on("message", on_message)
    script.load()
    print("[*] 异常抓取就绪 (%d 秒), 请触发发送..." % secs, flush=True)
    time.sleep(secs)
    session.detach()


if __name__ == "__main__":
    main()
