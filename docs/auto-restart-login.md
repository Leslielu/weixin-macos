# 微信全自动重启登录方案

## 实施进展（2026-09-02 晚）

**✅ 微信级全自动重启已上线并实测通过**（kill -9 实测：23:15:07 崩溃 → 23:18 全链路恢复 → 23:18:19 API 发图成功）：

```
23:15:07  kill -9 微信(模拟崩溃)
23:15:24  看门狗 17s 发现 → 拉起(先清 AppEx/更新器残留)
23:15:32/38/45  三次回车(lsappinfo 前台门禁, 非微信本体不发) → 自动登录成功
23:15:50  链重启 #1(登录未落定失败) → 23:16 看门狗 30s 自愈重试
23:18:03  收敛 → Frida 就绪
23:18:19  API 发图 HTTP 200 + 冷启动解析 CdnManager(新进程新指针 0xa2bdcda98)
23:22     ⌘⇧3 合成快捷键截屏 → 截图发给 ludaohe 成功(截图里可见该消息本身)
```

**两层框架**：整机重启（FileVault 密码，~月度手动，人工输一次）与微信进程重启（高频，全自动）。

### 已部署组件（mac-m1）

- `~/Prog/wxgate/wechat-watchdog.sh` v3 + LaunchAgent `com.user.wechat_watchdog.plist`（30s 一轮）
  1. 微信死亡 → 清理全家桶残留(AppEx/XSparkle 更新器, 防更新弹窗截获回车) → 拉起 → 8/14/20s 三次回车(每次先 lsappinfo 验前台=微信本体) → **必重启 bot 链**(onebot/wxgate 不会自动重连微信!)
  2. 微信被外部重启 → PID 变化检测(/tmp/wechat_watchdog.last_pid) → 重启 bot 链
  3. 58080 未监听 → 重启 bot 链
  - 挂起：`touch /tmp/wechat_watchdog.paused`（升级微信前必挂）
- `start.sh` 补丁：find_image_path 增加 `.image_path_last` 上次成功路径兜底（登录窗口期账号目录短暂不可见）
- 崩溃报告弹窗已关（`defaults write com.apple.CrashReporter DialogType none`，.ips 照常生成）
- cliclick wrapper app（`~/Applications/clicclick.app`，带 Info.plist + adhoc 签名, 辅助功能已授权; 脚本内用 glob 解析路径）

### 实测沉淀的技术细节

- **盲回车风险**：更新弹窗默认按钮="立即更新"，误触=版本升级=地址全变。防线=清更新进程+前台门禁
- cliclick 5.1 **不支持数字键码**（`kp:3` 无效）；合成 ⌘⇧3 用 `kd:cmd kd:shift t:3 ku:...`（t: 文本输入可触发全局快捷键）
- sshd/launchd 上下文 `screencapture` 被 TCC 拦（需屏幕录制）；合成快捷键截图→桌面，绕过
- 屏幕实际逻辑分辨率 ~1512x982(截屏 3024x1964@2x)，若用坐标点击模式需按此校准（当前用回车模式，无需坐标）
- onebot 在微信重启后必须重启（不会重连 gadget），看门狗的"拉起后必重启链"覆盖
- 教训：**永远不要对这台机器跑 `tccutil reset`**（辅助功能在系统级 TCC.db，误清 RustDesk 致远程键鼠瘫痪, 见 memory）

### 弃用 / 未做

- 树莓派 Pico HID（暂不做）
- macOS 用户自动登录（FileVault 保留即无此选项；月度手动重启输一次密码可接受）
- 桌面截屏自动化（可选升级：做一个 shot.app wrapper 授屏幕录制，当前用 ⌘⇧3 快捷键方案已够用）

## 附：媒体发送冷启动问题（2026-09-02 已修，方案 3）

## 附：媒体发送冷启动问题（2026-09-02 已修，方案 3）

**问题**：每次重启后必须手动从微信发一张图片，`uploadGlobalX0` 才会被 hook 捕获，程序才能发图片/视频/语音。

**根因**（4.1.10 静态分析）：`uploadGlobalX0` 是 `mars::cdn::CdnManager` 单例（mangled 名 `N4mars3cdn10CdnManagerE`），存在全局服务注册表里：

```
std::map @ __DATA,__common 0x9524648
  └─ GetService(std::string("default"))  [0x4ca2130]
      └─ 按类型名 getter                  [0x4e59dec]
          └─ [ctx+0x40] = CdnManager 单例
```

上传分发链（0x4e5a6e4）与下载分发链（0x4e5a7f4）走**完全相同**的两步取同一对象 →
`uploadGlobalX0 === downloadGlobalX0`。该单例登录后即注册，**不需要先发图片**。
地址是堆指针，每次重启都变（进程内稳定）——不能写死。

**修复**（`onebot/script.js`，方案 3 双保险）：
1. **互回填**：上传/下载 hook 抓到任一指针时顺手赋给另一个
2. **服务定位器解析**：`ensureCdnManagerX0()` 冷启动兜底——构造 libc++ SSO 字符串
   `"default"`（24 字节，`+0x17` 写长度 7），NativeFunction 调 `GetService` → getter →
   读 `ctx+0x40`，失败回退老报错路径

需要两个新 JSON 键（`{{if}}` 条件渲染，旧版本缺键不报错）：
- `cdnGetServiceAddr`（4.1.10 = 0x4ca2130）
- `cdnManagerGetterAddr`（4.1.10 = 0x4e59dec）

**新版本找地址方法**（IDA，从已知 `uploadImageAddr` 出发）：
1. 找 `uploadImageAddr` 叶子函数的唯一 BL 调用者（包装函数，末尾 `bl` 前有 `ldr x0,[x19+0x40]` 模式）
2. 包装函数的调用者 = 分发函数（开头 `mov x20,x1; mov x19,x0`，内部先 `bl` 一个带
   `adrp x1 "default"` 的调用 = **cdnGetServiceAddr**，紧接 `bl` 的下一个函数 = **cdnManagerGetterAddr**，
   它内部 `adrp+ldr` 引用字符串 `N4mars3cdn10CdnManagerE` 可交叉确认）

**部署后验证**：重启微信 → 不发图直接让 bot 发图片 → 日志应出现
`[+] 冷启动服务定位器解析 CdnManager`；另可手动发一张图对比 hook 捕获值与解析值是否一致。
（互回填链路——"给账号发一张图就能替代手动发图"——是否成立看
`[+] 下载hook回填` 日志是否在收到图时出现，静态追不出来：全走回调表。）

---

以下为重启登录双击问题方案。

目标：Mac mini 重启后无人值守完成微信登录，供 onebot/frida 链路自动收发消息。
约束：避免让微信感知到自动化运行环境（软件合成输入属于理论风险面）。

## 两道关卡

重启后登录微信需要两次人工点击：

1. **系统层**：macOS 弹窗"微信想访问外部文件/可移动宗卷，是否同意"（TCC 授权弹窗）
2. **应用层**：微信主界面的"进入微信"登录按钮

## 关卡 1：消灭 TCC 弹窗（不靠点击）

TCC 授权正常情况下批准一次即永久记住。每次重启都弹，说明授权没存住，常见原因：

- WeChat.app 被改过（打 frida-gadget / 重新签名）→ TCC 按签名识别 App，二进制变化导致授权失效
- 或者是 Gatekeeper"从互联网下载的 App"弹窗 → `xattr -dr com.apple.quarantine /Applications/WeChat.app` 去一次隔离属性即永久消失

对策（本机 SIP 已关，权限全开）：

1. 系统设置 → 隐私与安全性 → **完全磁盘访问**，把 WeChat 加进去。开一次，之后所有"访问 XX 文件夹"类弹窗都不再出现
2. 若因 bundle 被改动导致 TCC 失效：
   - 固定用同一个签名身份重签（cdhash 稳定，授权可保住），或
   - 直接写 TCC.db（SIP 关闭时 root 可写）：向 `kTCCServiceSystemPolicyRemovableVolumes` / `kTCCServiceAllFiles` 插入 allow 记录

完成后关卡 1 不复存在。

## 关卡 2：登录按钮 → 先减到一键，再模拟这一键

### 先开"自动登录"

手机微信端确认一次"在此 Mac 上自动登录"。之后重启只需点一下"进入微信"，不用扫码、不用手机确认。
登录窗永远居中；无头 Mac mini 分辨率恒定 → 按钮坐标可写死，或用 AppleScript **只读**获取窗口位置再算偏移（读取窗口位置不属于输入注入，零痕迹）：

```bash
osascript -e 'tell application "System Events" to get position of window 1 of process "WeChat"'
```

### 点击的三条路线（按"干净程度"排序）

**a) 软件合成事件（cliclick / AppleScript CGEvent）**
一行命令。实话：微信 Mac 版无已知的合成点击检测，风控盯的是注入和协议层（frida hook 才是真正的观测面），点击方式风险很低。但属于"软件合成输入"，不是确定性答案。

**b) USB 硬件 HID（终极方案，成本 ~¥20）**
树莓派 Pico / RP2040 刷 CircuitPython + `adafruit_hid`，USB 插到 Mac mini。同一根 USB 线上同时提供：

- 一个 **USB 鼠标设备** —— 对 macOS 和微信就是物理鼠标，驱动级真实，无软件检测面
- 一个 **CDC 串口** —— Mac 端脚本写 `CLICK x y`，Pico 收到后以鼠标身份移动并点击

开机链路：`open -a WeChat` → 等窗口出现 → AppleScript 读窗口坐标 → 串口发坐标 → Pico 物理点击。全链路无合成事件进入 macOS 事件流。

**c) PiKVM / JetKVM**
顺带解决无头服务器远程管理（BIOS 级画面+键鼠），点击同样走真 HID。已有 RustDesk 的话只为点击买 KVM 偏重，Pico 足够。

## 实施路线

1. 完全磁盘访问 + 去 quarantine → 干掉关卡 1
2. 手机端开自动登录
3. 先用 cliclick 跑通整条开机链路（launchd → 启动微信 → 等窗口 → 点击），验证时序和坐标
4. 跑稳后如需消除理论风险，把最后一步 cliclick 换成 Pico HID，链路其余部分原封不动
