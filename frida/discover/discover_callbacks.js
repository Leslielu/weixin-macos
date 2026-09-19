// discover_callbacks.js - 4.1.12.53 缺失的 4 个回调地址运行时发现
//
// 已知: 14/18 (partial JSON)。缺失: uploadOnCompleteAddr, downloadImagAddr,
//       downloadFileAddr, downloadVideoAddr (均为 BLR 间接调用的回调 hook 站点)。
//
// 方法: hook 已知锚点 -> dump 任务结构体内指向 __TEXT 的指针做候选 ->
//       给候选下 hook, 用 4.1.11 已知的寄存器指纹确认:
//   downloadImag/File: x19+0x2E0=fileId字符串, x19+0x2F8=cdnUrl(http开头), x2=数据长度
//   downloadVideo:     同上, 另 x20+0x178=数据指针, x23=长度
//   uploadOnComplete:  x1 -> 指针 -> fileId 字符串
//
// 用法: frida -H 127.0.0.1:27042 -n Gadget -l frida/discover/discover_callbacks.js
// 然后: 收一张图(等打点) -> 收一个文件 -> 收一个视频 -> 小号自己发一张图

var module = Process.enumerateModules().find(m => m.path.indexOf("Resources/wechat.dylib") >= 0);
var base = module.base;
var textEnd = base.add(0x9694000); // 4.1.12 __TEXT vmsize 上界(略大无妨)

var KNOWN = {
  "startDownloadMedia": 0x5570d48,
  "uploadImageAddr":    0x5570098,
  "cdnGetServiceAddr":  0x53a7ac8,
  "cdnManagerGetterAddr": 0x551c1bc,
  "uploadGetCallbackWrapperAddr": 0x551f644,
  "uploadGetCallbackWrapperFuncAddr": 0x40fa5fc,
  "cndOnCompleteAddr":  0x40fad60,
  "uploadOnCompleteFuncAddr": 0x40fb780,
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

// ---------------- 候选采集 ----------------
var candidates = {}; // offset -> {via: label}
function harvest(structPtr, label) {
  var n = 0;
  for (var off = 0; off < 0x800; off += 8) {
    var v;
    try { v = structPtr.add(off).readPointer(); } catch (e) { break; }
    if (inText(v)) {
      var rel = v.sub(base).toUInt32();
      if (!(rel in KNOWN_SET) && !(rel in candidates)) {
        candidates[rel] = {via: label + "+0x" + off.toString(16)};
        n++;
        // 立即武装, 不等 5 秒轮询 (回调可能在 harvest 后毫秒级触发)
        armOne(rel);
      }
    }
  }
  if (n > 0) console.log("[harvest] " + label + ": 新增 " + n + " 个候选 (累计 " + Object.keys(candidates).length + ")");
}

// ---------------- 指纹判定 ----------------
function fingerprint(ctx, tag) {
  // download 指纹: x19+0x2E0=fileId, x19+0x2F8=cdnUrl
  var fileId = readStrAt(ctx.x19, 0x2E0);
  var cdnUrl = readStrAt(ctx.x19, 0x2F8);
  if (fileId && cdnUrl && cdnUrl.indexOf("http") === 0) {
    console.log("\n[*** DOWNLOAD 回调命中 ***] " + tag);
    console.log("    fileId=" + fileId);
    console.log("    cdnUrl=" + cdnUrl.substring(0, 80));
    console.log("    x2(len)=" + ctx.x2.toInt32() + " x23=" + ctx.x23.toInt32());
    return true;
  }
  return false;
}

function fingerprintUpload(ctx, tag) {
  try {
    var s = readStrSafe(ctx.x1.readPointer());
    if (s && s.length > 8) {
      console.log("\n[*** UPLOAD 回调候选命中 ***] " + tag);
      console.log("    x1->str=" + s);
      return true;
    }
  } catch (e) {}
  return false;
}

// ---------------- 布设 ----------------
// 1) 已知锚点: 记录上下文的结构体指针并 harvest
Interceptor.attach(base.add(KNOWN.startDownloadMedia), {
  onEnter: function (args) {
    console.log("\n[+] startDownloadMedia 触发 (下载开始)");
    console.log("    x0=" + this.context.x0 + " x1=" + this.context.x1 + " x2=" + this.context.x2);
    harvest(this.context.x0, "startDownload.x0");
    harvest(this.context.x1, "startDownload.x1");
  }
});

Interceptor.attach(base.add(KNOWN.uploadImageAddr), {
  onEnter: function (args) {
    console.log("\n[+] uploadImageAddr 触发 (上传开始)");
    harvest(this.context.x0, "uploadImage.x0");
    harvest(this.context.x1, "uploadImage.x1");
    harvest(this.context.x19, "uploadImage.x19");
  }
});

// 2) upload 完成回调: 已知 wrapper 函数簇在附近, uploadOnCompleteAddr 是
//    wrapper(+0x7B8 偏移带) 的邻居; 直接大范围扫 wrapper 后面 0x1000 内每个
//    指令做 hook 不现实, 改为: hook 已知 uploadOnCompleteFuncAddr(回调函数本体,
//    已知!) 观察其调用来源 returnAddress -> 其调用者站点即 uploadOnCompleteAddr 候选
Interceptor.attach(base.add(KNOWN.uploadOnCompleteFuncAddr), {
  onEnter: function (args) {
    var ra = this.returnAddress;
    var rel = ra.sub(base);
    console.log("\n[*** uploadOnCompleteFunc 被调 ***] returnAddress=base+0x" + rel.toString(16));
    console.log("    => uploadOnCompleteAddr 候选 = 0x" + rel.toString(16));
    fingerprintUpload(this.context, "uploadOnCompleteFunc");
  }
});

// 3) download 回调函数本体在 JSON 里没有直接键, 但 download 完成数据到达的
//    "函数" 就是缺失键本身。无法预埋, 靠候选 hook 指纹:
var armed = {};
function armOne(rel) {
  if (armed[rel]) return;
  armed[rel] = true;
  try {
    Interceptor.attach(base.add(rel), {
      onEnter: function (args) {
        var tag = "base+0x" + rel.toString(16) + " (via " + candidates[rel].via + ")";
        if (fingerprint(this.context, tag)) {
          console.log("    => 该候选即 download 回调站点之一!");
        }
      }
    });
  } catch (e) {}
}

function armCandidates() {
  var n0 = Object.keys(armed).length;
  for (var rel of Object.keys(candidates)) armOne(Number(rel));
  var n1 = Object.keys(armed).length;
  if (n1 !== n0) console.log("[*] 候选 hook 布设: " + n1 + " 个");
}

// 每 5 秒把新 harvest 到的候选武装起来
setInterval(armCandidates, 5000);

console.log("[+] 就绪. base=" + base);
console.log("[*] 操作顺序: 1) 给小号发一张图 2) 发一个文件 3) 发一个视频 4) 小号发出一张图");
console.log("[*] 关注 [*** ... ***] 打点");
