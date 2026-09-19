// probe_cdn_activity.js - 诊断: UI 收发媒体时 mars CDN 层是否活跃
// 在每个已知 CDN 键上打频率计数 + 首次上下文 dump
var module = Process.enumerateModules().find(m => m.path.indexOf("Resources/wechat.dylib") >= 0);
var base = module.base;

var PROBES = {
  "cdnGetServiceAddr(服务定位器,每次CDN操作必经)": 0x53a7ac8,
  "cdnManagerGetterAddr(取CdnManager)": 0x551c1bc,
  "cndOnCompleteAddr(CDN完成回调)": 0x40fad60,
  "uploadGetCallbackWrapperAddr(上传wrapper)": 0x551f644,
  "uploadGetCallbackWrapperFuncAddr": 0x40fa5fc,
  "uploadOnCompleteFuncAddr(上传完成回调本体)": 0x40fb780,
  "startDownloadMedia": 0x5570d48,
  "uploadImageAddr": 0x5570098,
};

var counts = {};
var dumped = {};

function dumpStruct(p, label) {
  if (!p || p.isNull()) return;
  var module2 = Process.enumerateModules().find(m => m.path.indexOf("Resources/wechat.dylib") >= 0);
  var lo = module2.base, hi = module2.base.add(module2.size);
  var hits = [];
  for (var off = 0; off < 0x400; off += 8) {
    var v;
    try { v = p.add(off).readPointer(); } catch (e) { break; }
    if (v.compare(lo) >= 0 && v.compare(hi) < 0)
      hits.push("+0x" + off.toString(16) + "->base+0x" + v.sub(lo).toString(16));
  }
  if (hits.length) console.log("    [dump] " + label + " TEXT指针: " + hits.slice(0, 12).join(" "));
}

for (var name in PROBES) {
  counts[name] = 0;
  (function (name, off) {
    Interceptor.attach(base.add(off), {
      onEnter: function (args) {
        counts[name]++;
        if (counts[name] === 1) {
          console.log("\n[首次命中] " + name);
          console.log("    x0=" + this.context.x0 + " x1=" + this.context.x1 +
                      " x2=" + this.context.x2 + " x19=" + this.context.x19);
          dumpStruct(this.context.x0, "x0");
          dumpStruct(this.context.x1, "x1");
          dumpStruct(this.context.x19, "x19");
        }
        if (counts[name] % 100 === 0)
          console.log("[*] " + name + " 已命中 " + counts[name] + " 次");
      }
    });
  })(name, PROBES[name]);
}

setInterval(function () {
  var line = [];
  for (var n in counts) if (counts[n] > 0) line.push(n.split("(")[0] + "=" + counts[n]);
  if (line.length) console.log("[计数] " + line.join(" "));
}, 10000);

console.log("[+] CDN 活动探针就绪, base=" + base + ". 请收发图片/文件/视频各一次");
