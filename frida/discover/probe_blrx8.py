#!/usr/bin/env python3
"""probe_blrx8.py - 在 blrX8 站点读真实 x8 => sendFuncAddr 真值
心跳/真实任务触发时打印。用法: probe_blrx8.py [秒数]
"""
import sys
import time
import frida

JS = r"""
var module = Process.enumerateModules().find(m => m.path.indexOf("Resources/wechat.dylib") >= 0);
var base = module.base;
var blrX8 = base.add(0x413ea34);   // 4.1.12 blrX8Addr
send({t: "ready", v: "" + base, site: "" + blrX8});
var n = 0;
Interceptor.attach(blrX8, {
  onEnter: function () {
    n++;
    var x8rel = this.context.x8.sub(base);
    send({t: "hit", n: n, x8off: "0x" + x8rel.toString(16),
          x0: "" + this.context.x0, x1: "" + this.context.x1});
  }
});
"""

def main():
    secs = int(sys.argv[1]) if len(sys.argv) > 1 else 300
    dev = frida.get_device_manager().add_remote_device("127.0.0.1:27042")
    session = dev.attach("Gadget")
    def on_message(msg, data):
        if msg.get("type") == "send":
            p = msg["payload"]
            if p["t"] == "ready":
                print("[就绪] base=%s site=%s" % (p["v"], p["site"]), flush=True)
            else:
                print("[hit#%d] x8 = base + %s  x0=%s x1=%s" % (p["n"], p["x8off"], p["x0"], p["x1"]), flush=True)
        else:
            print("[msg]", msg, flush=True)
    script = session.create_script(JS)
    script.on("message", on_message)
    script.load()
    print("[*] 等待真实任务触发 (%d 秒)..." % secs, flush=True)
    time.sleep(secs)
    session.detach()

if __name__ == "__main__":
    main()
