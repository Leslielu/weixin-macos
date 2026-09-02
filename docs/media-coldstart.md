# 媒体上传冷启动：CdnManager 自动解析

> 2026-09 新增。解决"每次微信重启后必须手动发一张图片激活上传"的问题。

## 问题

`uploadGlobalX0`（图片/视频/语音上传、媒体下载共用的 `this` 指针）此前只能靠 hook
捕获一次真实调用获得。微信重启后它是空的，必须有人在微信里手动发一张图，API 才能
发媒体。这阻碍无人值守自动重启。

## 原理（4.1.10.53 静态分析结论）

`uploadGlobalX0` 是 `mars::cdn::CdnManager` 单例（mangled 类型名
`N4mars3cdn10CdnManagerE`），由微信的服务定位器管理：

```
全局服务注册表 (std::map, __DATA,__common)
  └─ GetService(std::string("default"))        ← cdnGetServiceAddr
      └─ 按类型名 "N4mars3cdn10CdnManagerE" 取 ctx   ← cdnManagerGetterAddr
          └─ [ctx + 0x40] = CdnManager 单例    ← 就是 uploadGlobalX0 / downloadGlobalX0
```

两个关键事实：

1. **上传与下载是同一个对象**。上传分发链与下载分发链都调用同一个
   `GetService("default")` + 同一个 getter，从同一上下文的 `+0x40` 取单例。
   即 `uploadGlobalX0 === downloadGlobalX0`。
2. **该单例在登录后、未发送任何图片时就已经注册在服务表里**。不需要"发一张图"
   它才存在。但它是堆指针，每次进程重启都会变化，不能写死。

## 修复（三层，任一生效即可用）

1. **互回填**：上传/下载 hook 抓到任一指针时顺手赋给另一个（同一单例）
2. **冷启动解析**：`ensureCdnManagerX0()` 兜底——手工构造 libc++ SSO 短字符串
   `"default"`（24 字节缓冲：`+0` 写数据，`+0x17` 写长度），NativeFunction 依次调
   `GetService` → getter → 读 `[ctx+0x40]`。失败自动回退老的报错路径
3. 新 JSON 键用 `{{if}}` 条件渲染，**旧版本配置缺键不报错**，自动退回"hook 捕获"老行为

## 新增 JSON 键

| 键 | 含义 | 4.1.10.53 已确认值 |
|---|---|---|
| `cdnGetServiceAddr` | `GetService(std::string)` 服务定位器 | `0x4ca2130` |
| `cdnManagerGetterAddr` | 按类型名取 CdnManager 上下文的 getter | `0x4e59dec` |

`ctx+0x40` 的字段偏移写死在 `script.js`（跨版本一般稳定；若新版本解析失败需复核此偏移）。

## 其他版本如何获取这两个地址（IDA）

从每版本本来就要找的 `uploadImageAddr` 出发反追两步：

1. 找 `uploadImageAddr` 的**唯一 BL 调用者**（包装函数；尾部特征
   `mov x1, sp; mov x0, x19; bl uploadImageAddr`）
2. 再找这个包装函数的**调用者**（分发函数；开头特征 `mov x20, x1; mov x19, x0`）
3. 分发函数上部有两连发调用：
   - 引用字符串 `"default"` 之后的 `bl X` → **X = cdnGetServiceAddr**
   - 紧随其后、吃掉 X 返回值的 `bl Y` → **Y = cdnManagerGetterAddr**
4. 交叉确认：Y 内部有一处 `adrp+ldr` 引用全局指针，指向字符串
   `N4mars3cdn10CdnManagerE`

反向入口更省事：在二进制里搜字符串 `N4mars3cdn10CdnManagerE` → 引用它的函数就是
getter（Y）→ Y 的调用者即分发函数，里面紧挨着的另一个 `bl` 即 GetService（X）。

## 验证记录（4.1.10.53，macOS arm64，gadget 模式）

- 重启 onebot 后**不发任何图**，直接 API 发图：日志出现
  `[+] 冷启动服务定位器解析 CdnManager: 0xb8946ef18`，发送成功（filehelper 与私聊各一次）
- 重启 onebot 后给 bot 账号发一张图（微信自动下载）：日志出现
  `[+] 下载hook回填 uploadGlobalX0: 0xb8946ef18`，且事后用该指针上传成功
- 两条独立路径得到同一指针，互为印证
