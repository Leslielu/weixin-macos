// probe_basic.js - 4.1.12 分层自检: 文本接收 -> CDN 活动
// 第1层: buf2RespAddr (消息回包解析, 任何收发必经) + req2bufEnterAddr (任务创建)
// 第2层: CDN 服务定位器/回调
var module = Process.enumerateModules().find(m => m.path.indexOf("Resources/wechat.dylib") >= 0);
var base = module.base;

var L1 = {  // 文本链路 (req2buf 组, 签名 32/32 高置信)
  "req2bufEnterAddr": 0x413e9b4,
  "buf2RespAddr":     0x4163f4c,
};
var L2 = {  // CDN 链路
  "cdnGetServiceAddr": 0x53a7ac8,
  "cndOnCompleteAddr": 0x40fad60,
  "uploadOnCompleteFuncAddr": 0x40fb780,
  "startDownloadMedia": 0x5570d48,
  "uploadImageAddr":   0x5570098,
};

var counts = {};
function probe(name, off) {
  counts[name] = 0;
  try {
    Interceptor.attach(base.add(off), {
      onEnter: function (args) {
        counts[name]++;
        if (counts[name] <= 3)
          console.log("[命中#" + counts[name] + "] " + name +
            " x0=" + this.context.x0 + " x1=" + this.context.x1 + " x2=" + this.context.x2);
        if (counts[name] === 100) console.log("[*] " + name + " 已达100次");
      }
    });
  } catch (e) { console.log("[!] attach 失败 " + name + ": " + e); }
}
for (var n in L1) probe(n, L1[n]);
for (var n in L2) probe(n, L2[n]);

setInterval(function () {
  var line = [];
  for (var n in counts) if (counts[n] > 0) line.push(n + "=" + counts[n]);
  console.log("[计数] " + (line.length ? line.join(" ") : "(全静默)"));
}, 15000);

console.log("[+] 分层探针就绪 base=" + base);
console.log("[*] 第1步: 给小号发一条文本 -> 应见 buf2RespAddr/req2bufEnterAddr 命中");
console.log("[*] 第2步: 再发图片/文件/视频 -> 应见 CDN 键命中");
