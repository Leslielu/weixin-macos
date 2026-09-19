#!/usr/bin/env python3
"""probe_abort.py - 钩 abort/__assert_rtn/__stack_chk_fail, 抓 MMStartTask 中止现场
用法: probe_abort.py [秒数]   (挂着期间触发一次 API 发文本)
"""
import sys
import time
import frida

JS = r"""
var module = Process.enumerateModules().find(m => m.path.indexOf("Resources/wechat.dylib") >= 0);
var base = module.base;
function hookAbort(name) {
  var p = Module.findGlobalExportByName(name);
  if (!p) { send({t: "noexport", k: name}); return; }
  Interceptor.attach(p, {
    onEnter: function () {
      var frames = [];
      var bt = Thread.backtrace(this.context, Backtracer.ACCURATE);
      for (var a of bt) {
        var s = "" + a;
        if (a.compare(base) >= 0) s = "base+0x" + a.sub(base).toString(16);
        frames.push(s);
      }
      send({t: "ABORT", k: name, frames: frames.slice(0, 12)});
    }
  });
}
hookAbort("abort");
hookAbort("__assert_rtn");
hookAbort("__stack_chk_fail");
hookAbort("_os_assert_bt");
// objc terminate 常见入口
hookAbort("_ZNSt9terminateEv");
send({t: "ready", v: "" + base});
"""

def main():
    secs = int(sys.argv[1]) if len(sys.argv) > 1 else 120
    dev = frida.get_device_manager().add_remote_device("127.0.0.1:27042")
    session = dev.attach("Gadget")
    def on_message(msg, data):
        if msg.get("type") == "send":
            p = msg["payload"]
            if p["t"] == "ready":
                print("[就绪] base=" + p["v"], flush=True)
            elif p["t"] == "noexport":
                print("[无导出] " + p["k"], flush=True)
            elif p["t"] == "ABORT":
                print("\n[*** %s 被调 ***] 回溯:" % p["k"], flush=True)
                for i, f in enumerate(p["frames"]):
                    print("  #%02d %s" % (i, f), flush=True)
        else:
            print("[msg]", msg, flush=True)
    script = session.create_script(JS)
    script.on("message", on_message)
    script.load()
    print("[*] abort 现场抓取就绪 (%d 秒), 请触发发送..." % secs, flush=True)
    time.sleep(secs)
    session.detach()

if __name__ == "__main__":
    main()
