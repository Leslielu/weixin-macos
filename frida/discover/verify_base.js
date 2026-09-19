// verify_base.js - 校验运行时基址与静态偏移吻合（4.1.12.53）
var module = Process.enumerateModules().find(m => m.path.indexOf("Resources/wechat.dylib") >= 0);
console.log("[+] module: " + module.name + " path=" + module.path);
console.log("[+] base: " + module.base + " size=0x" + module.size.toString(16));

// 已知锚点（4.1.12.53 partial JSON）：
// startDownloadMedia = 0x5570d48, 该处 4.1.11 里是函数序曲; 4.1.12 应也是
var base = module.base;
var checks = {
  "req2bufEnterAddr": 0x413e9b4,
  "sendFuncAddr": 0x53e4ecc,
  "uploadImageAddr": 0x5570098,
  "startDownloadMedia": 0x5570d48
};
for (var k in checks) {
  var p = base.add(checks[k]);
  var bytes = p.readByteArray(16);
  console.log("[*] " + k + " @0x" + checks[k].toString(16) + ": " +
    Array.from(new Uint8Array(bytes)).map(b => ("0"+b.toString(16)).slice(-2)).join(""));
}
