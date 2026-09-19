#!/usr/bin/env python3
"""discover_driver.py - 4.1.12 缺失 4 回调运行时发现 (python frida 驱动版)
用法: ~/.venvs/wechat-re/bin/python3 frida/discover/discover_driver.py [秒数]
操作: 加载后依次 收图(点开)/收文件/收视频/小号发图
"""
import sys
import time
import frida

JS = r"""
var module = Process.enumerateModules().find(m => m.path.indexOf("Resources/wechat.dylib") >= 0);
var base = module.base;
var textEnd = base.add(module.size);

var KNOWN = {
  "startDownloadMedia": 0x5570d48,
  "uploadImageAddr":    0x5570098,
  "cdnGetServiceAddr":  0x53a7ac8,
  "cdnManagerGetterAddr": 0x551c1bc,
  "uploadGetCallbackWrapperAddr": 0x551f644,
  "uploadGetCallbackWrapperFuncAddr": 0x40fa5fc,
  "cndOnCompleteAddr":  0x40fad60,
  "uploadOnCompleteFuncAddr": 0x40fb780,
  "buf2RespAddr": 0x4163f4c,
};
var KNOWN_SET = {};
for (var k in KNOWN) KNOWN_SET[KNOWN[k]] = k;

function inText(v) {
  return v.compare(base) >= 0 && v.compare(textEnd) < 0 && (v.and(3).toInt32() === 0);
}
function readStrSafe(p) {
  try {
    if (p.isNull()) return null;
    var s = p.readUtf8String();
    if (s && s.length > 0 && s.length < 512) return s;
  } catch (e) {}
  return null;
}
function readStrAt(objPtr, off) {
  try { return readStrSafe(objPtr.add(off).readPointer()); } catch (e) { return null; }
}

// ---- 候选采集 ----
var candidates = {};
var armed = {};
function armOne(rel) {
  if (armed[rel]) return;
  armed[rel] = true;
  try {
    Interceptor.attach(base.add(rel), {
      onEnter: function () {
        var fileId = readStrAt(this.context.x19, 0x2E0);
        var cdnUrl = readStrAt(this.context.x19, 0x2F8);
        if (fileId && cdnUrl && cdnUrl.indexOf("http") === 0) {
          send({t: "DOWNLOAD_HIT", off: "0x" + rel.toString(16),
                via: candidates[rel].via, fileId: fileId,
                url: cdnUrl.substring(0, 100),
                x2: this.context.x2.toInt32(), x23: this.context.x23.toInt32()});
        }
      }
    });
  } catch (e) {}
}
function harvest(structPtr, label) {
  var n = 0;
  for (var off = 0; off < 0x800; off += 8) {
    var v;
    try { v = structPtr.add(off).readPointer(); } catch (e) { break; }
    if (inText(v)) {
      var rel = v.sub(base).toUInt32();
      if (!(rel in KNOWN_SET) && !(rel in candidates)) {
        candidates[rel] = {via: label + "+0x" + off.toString(16)};
        armOne(rel);
        n++;
      }
    }
  }
  if (n > 0) send({t: "harvest", via: label, n: n, total: Object.keys(candidates).length});
}

// ---- 已知锚点 ----
Interceptor.attach(base.add(KNOWN.startDownloadMedia), {
  onEnter: function () {
    send({t: "anchor", k: "startDownloadMedia", x0: "" + this.context.x0, x1: "" + this.context.x1});
    harvest(this.context.x0, "startDownload.x0");
    harvest(this.context.x1, "startDownload.x1");
    // 下载任务结构全量 dump (定位 download trio 的调用现场)
    var words = [];
    try {
      for (var off = 0; off <= 0x1f8; off += 8) {
        var w = this.context.x1.add(off).readPointer();
        var tag = "";
        try {
          var s = w.readCString(96);
          if (s && s.length >= 4 && /^[\\x20-\\x7e]+$/.test(s)) tag = "str:'" + s + "'";
        } catch (e) {}
        if (!tag && w.compare(base) >= 0 && w.compare(textEnd) < 0) tag = "dylib+0x" + w.sub(base).toString(16);
        words.push("x1+0x" + off.toString(16) + "=" + w + (tag ? " " + tag : ""));
      }
    } catch (e) {}
    send({t: "STRUCT", k: "startDownloadMedia.x1", words: words});
  }
});
Interceptor.attach(base.add(KNOWN.uploadImageAddr), {
  onEnter: function () {
    send({t: "anchor", k: "uploadImageAddr", x0: "" + this.context.x0, x1: "" + this.context.x1});
    harvest(this.context.x0, "uploadImage.x0");
    harvest(this.context.x1, "uploadImage.x1");
    harvest(this.context.x19, "uploadImage.x19");
    // 上传任务结构全量 dump: 真实 UI 上传时逐字段对照合成模板的偏移
    var words = [];
    try {
      for (var off = 0; off <= 0x258; off += 8) {
        var w = this.context.x1.add(off).readPointer();
        var tag = "";
        try {
          var s = w.readCString(96);
          if (s && s.length >= 4 && /^[\\x20-\\x7e]+$/.test(s)) tag = "str:'" + s + "'";
        } catch (e) {}
        if (!tag && w.compare(base) >= 0 && w.compare(textEnd) < 0) tag = "dylib+0x" + w.sub(base).toString(16);
        words.push("x1+0x" + off.toString(16) + "=" + w + (tag ? " " + tag : ""));
      }
    } catch (e) {}
    send({t: "STRUCT", k: "uploadImageAddr.x1", words: words});
  }
});

// CDN 完成回调(已知): 任何 CDN 传输完成都会过, harvest 其上下文
Interceptor.attach(base.add(KNOWN.cndOnCompleteAddr), {
  onEnter: function () {
    send({t: "anchor", k: "cndOnCompleteAddr", x0: "" + this.context.x0, x1: "" + this.context.x1});
    harvest(this.context.x0, "cndOnComplete.x0");
    harvest(this.context.x1, "cndOnComplete.x1");
    harvest(this.context.x19, "cndOnComplete.x19");
    harvest(this.context.x20, "cndOnComplete.x20");
  }
});

// uploadOnCompleteFunc(本体已知) returnAddress -> uploadOnCompleteAddr
Interceptor.attach(base.add(KNOWN.uploadOnCompleteFuncAddr), {
  onEnter: function () {
    var rel = this.returnAddress.sub(base);
    var s = null;
    try { s = readStrSafe(this.context.x1.readPointer()); } catch (e) {}
    send({t: "UPLOAD_HIT", off: "0x" + rel.toString(16), x1str: s || "(空)"});
  }
});
send({t: "ready", v: "" + base});
"""

def main():
    secs = int(sys.argv[1]) if len(sys.argv) > 1 else 600
    dev = frida.get_device_manager().add_remote_device("127.0.0.1:27042")
    session = dev.attach("Gadget")

    def on_message(msg, data):
        if msg.get("type") == "send":
            p = msg["payload"]
            t = p.get("t")
            if t == "ready":
                print("[就绪] base=" + p["v"], flush=True)
            elif t == "anchor":
                print("[锚点触发] %s x0=%s x1=%s" % (p["k"], p.get("x0"), p.get("x1")), flush=True)
            elif t == "harvest":
                print("[harvest] %s 新增%d个候选 (累计%d)" % (p["via"], p["n"], p["total"]), flush=True)
            elif t == "DOWNLOAD_HIT":
                print("\n[*** DOWNLOAD 回调命中 ***] base+%s (via %s)" % (p["off"], p["via"]), flush=True)
                print("    fileId=%s" % p["fileId"], flush=True)
                print("    url=%s" % p["url"], flush=True)
                print("    x2=%d x23=%d" % (p["x2"], p["x23"]), flush=True)
            elif t == "UPLOAD_HIT":
                print("\n[*** uploadOnCompleteAddr 候选 ***] base+%s x1->%s" % (p["off"], p["x1str"]), flush=True)
            elif t == "STRUCT":
                print("\n[结构dump %s]" % p["k"], flush=True)
                for wline in p["words"]:
                    print("   " + wline, flush=True)
        elif msg.get("type") == "log":
            print("[log]", msg.get("payload"), flush=True)
        else:
            print("[msg]", msg, flush=True)

    script = session.create_script(JS)
    script.on("message", on_message)
    script.load()
    print("[*] 发现会话已加载, 运行 %d 秒" % secs, flush=True)
    time.sleep(secs)
    session.detach()

if __name__ == "__main__":
    main()
