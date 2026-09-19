#!/usr/bin/env python3
"""probe_driver.py - 用 python frida 绑定挂探针并收集输出
用法: ~/.venvs/wechat-re/bin/python3 frida/discover/probe_driver.py [秒数]
"""
import sys
import frida

JS = r"""
var module = Process.enumerateModules().find(m => m.path.indexOf("Resources/wechat.dylib") >= 0);
var base = module.base;
send({t: "base", v: "" + base});

// 1) hook 机制自检: memcpy 必热
var libc = Process.enumerateModules().find(m => m.name === "libsystem_c.dylib");
var hotN = 0;
Interceptor.attach(libc.findExportByName("memcpy"), { onEnter: function () { hotN++; } });

// 2) 业务探针
var PROBES = {
  "req2bufEnterAddr": 0x413e9b4,
  "buf2RespAddr":     0x4163f4c,
  "cdnGetServiceAddr": 0x53a7ac8,
  "cndOnCompleteAddr": 0x40fad60,
  "startDownloadMedia": 0x5570d48,
  "uploadImageAddr":   0x5570098,
};
var counts = {};
for (var name in PROBES) {
  counts[name] = 0;
  (function (name, off) {
    try {
      Interceptor.attach(base.add(off), {
        onEnter: function () {
          counts[name]++;
          if (counts[name] <= 3) send({t: "hit", k: name, n: counts[name]});
        }
      });
    } catch (e) { send({t: "attachfail", k: name, v: "" + e}); }
  })(name, PROBES[name]);
}

setInterval(function () {
  var line = [];
  for (var n in counts) if (counts[n] > 0) line.push(n + "=" + counts[n]);
  send({t: "tick", hot: hotN, v: line.length ? line.join(" ") : "(业务全静默)"});
}, 5000);
"""

def main():
    secs = int(sys.argv[1]) if len(sys.argv) > 1 else 30
    dev = frida.get_device_manager().add_remote_device("127.0.0.1:27042")
    session = dev.attach("Gadget")

    def on_message(msg, data):
        if msg.get("type") == "send":
            p = msg["payload"]
            t = p.get("t")
            if t == "base":
                print("[base]", p["v"], flush=True)
            elif t == "hit":
                print("[命中#%d] %s" % (p["n"], p["k"]), flush=True)
            elif t == "attachfail":
                print("[attach失败] %s: %s" % (p["k"], p["v"]), flush=True)
            elif t == "tick":
                print("[tick] memcpy=%d | %s" % (p["hot"], p["v"]), flush=True)
        else:
            print("[msg]", msg, flush=True)

    script = session.create_script(JS)
    script.on("message", on_message)
    script.load()
    print("[*] 已加载, 观察 %d 秒..." % secs, flush=True)
    import time
    time.sleep(secs)
    session.detach()

if __name__ == "__main__":
    main()
