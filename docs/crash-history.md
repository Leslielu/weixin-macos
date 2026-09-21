# 微信 Bot 崩溃档案与排查手册

> 排查任何崩溃/发送异常前**先读本文**。记录历次崩溃的指纹、根因分析、已上线的修复和遗留问题。
> 最后更新：2026-09-21

## 速查：排查动作清单

1. **崩溃报告**：远端 `~/Library/Logs/DiagnosticReports/WeChat-*.ips`
   - `.ips` 第一行是 meta JSON，剩余是 body JSON
   - `exception`：类型/地址；`faultingThread`：崩溃线程号；`usedImages` 里 wechat.dylib 有 **16KB stub 和 ~147MB 真身两个**，offset 全部相对真身（`Frameworks/` 下的是 stub，`Resources/` 下的是真身，判别：name=wechat.dylib 且 size>50MB）
   - **imageOffset 就是地址**（`__TEXT` vmaddr=0），直接对照 `wechat_version/*.json` 的已知 offset
2. **onebot 日志**：远端 `~/Prog/wxgate/onebot.log`
   - 2026-09-02 起 start.sh 已改为**追加模式**（之前每次 restart 截断，会丢崩溃现场）
   - 日志里 JS 侧输出带 `[JS日志]` 前缀
3. **发送记录**：远端 `~/Prog/wxgate/wxgate.db`（SQLite，`messages` 表）
   - **`created_at` 是 UTC**，本地 = UTC+8，对照日志时务必换算
   - `direction=outgoing` 是发出的消息，`status`/`error_msg` 记录结果
4. **wxgate 日志**：远端 `~/Prog/wxgate/wxgate.log`（Go 内部写文件，追加，不会被重启冲掉；代理行不含消息内容，内容去 db 查）
5. **关键时间基准**：onebot 的 HTTP 发送接口是**阻塞等 buf2resp ack 才返回**的（`http.go` 里 `<-ch`），任务级超时 15s（`worker.go` ctx），超时报 `send timeout`。所以 wxgate 秒回 200 ≈ 发送成功；`send timeout` = ack 没到

## 崩溃分类指纹

### A 类：coroutine 红黑树 erase 崩溃（已发生 3 次，最主要威胁）

```
线程名:  coroutine *N
异常:    SIGSEGV, 读 NULL (KERN_INVALID_ADDRESS at 0x0)
栈顶:    wechat.dylib+0x21e40   ← libc++ 红黑树 rebalance (ldr x11,[x9], x9=parent=NULL)
公共帧:  wechat.dylib+0x59477a0 / +0x595c4d0 / +0x5955c20 + owl.framework+0x55bd8
中间帧:  0x3a5b*** (CGI 发包子系统, 邻近 Req2Buf=0x3ac6ec8 / Buf2Resp=0x3aec6ac) 或 0x1d8e***
```

本质：mars 任务 map 的红黑树节点被重复 erase / 迭代器失效。是**微信自有代码路径**在协程线程做任务清理时踩到脏节点。

### B 类：mars::cdn::worker 下载路径崩溃（8/11、8/15 07:51，未修）

NULL+0x10，cdn worker 线程，疑似下载路径。与注入发送无关，未深入。

### C 类（非崩溃）：CDN 秒传去重导致发送静默失败

不算崩溃但表现为"发送失败"。见下文 2026-08-27 条目。

### H 类：Interceptor.detach 拆热路径蹦床竞态（2026-09-21 23:07 实锤）

```
线程名:  frida-gadget-tcp-27042 (gadget 自己的线程, 与 G 类同线程名但机制不同)
异常:    SIGSEGV, 跳转地址 = 被撕裂的 syscall 蹦床(0x125184038)
时序:    detach 定时器到期 → forEach l.detach() ×7 syscall hook → ~1s 内崩
```

本质：对**正在被执行的** syscall 入口蹦床做 detach（恢复原始指令），与正在
蹦床里运行的线程存在天然竞态——指令恢复窗口期内有线程跳进半恢复的蹦床即崩。
与 G 类（kill onebot 会话拆除竞态）同线程名是因为 gadget 线程恰好是那个
倒霉的执行者，但机制完全不同：G 是 frida 内部拆除 bug，H 是我们主动 detach
自己挂的 hook。**铁律： hook 只挂不拆**——任何热路径 hook（syscall/高频函数）
挂上后常驻到进程死亡；空闲开销用 onEnter 快路径/tid 门控制，绝不用 detach 省。

## 崩溃/事件时间线

### 2026-08-11、08-15 07:51 —— B 类
mars::cdn::worker 线程 NULL+0x10，疑似下载路径。未修，未复发（截至 9/2）。

### 2026-08-17 11:25 —— SIGSEGV（A 类的前身，直接催生超时兜底）

**时序**：文本任务 ack 未回（buf2resp 从未触发）→ X24+0x60 长期指向 Frida 伪造结构体 → Go 侧 15s 超时后 bot 立即重发新任务，复用共享伪造结构体（taskId 被改写）→ ~19s 后 mars 自身任务超时回收死任务时踩到脏内存崩溃。

**修复**（commit `1f46848`，当日 21:41 上线）：
- `pendingBuf2RespTasks` 任务表（taskId→{addr, msgType, originalPtr, timerId}）+ 10s 超时兜底
- req2bufEnter 注入前保存原始指针 `originalInsertMsgPtr`，超时后**复原原始指针**而非清零
- buf2resp 的清理动作提到指针可读性校验**之前**（错误响应指针不可读时早退会跳过清理）

### 2026-08-17 21:53 —— A 类（bot 空闲时崩）

中间帧 0x1d8e***，崩溃时无在途任务。当时未定论。现在回看与 9/2 那次同解释：之前成功任务留下的 NULL 节点被延迟清理踩到。

### 2026-08-20 23:57 —— A 类（CGI 失败窗口）

**时序**（onebot.log）：23:57:51 发 text 任务 536871011 → 无 ack → 5 秒后崩。崩溃瞬间 mars::stn 正停在 Req2Buf 入口（重试重序列化）。推断：短链 CGI 失败（~5s) → 失败回调在协程线程 erase 任务 map + mars 重试并发 → 踩坏节点。10s 兜底跑不过 5s 失败窗口。

**修复**（commit `74af55e`，8/23 上线）：兜底超时 10s→3s，赶在 mars 失败窗口前复原指针。

**当时识别的放大因素**：① 成功路径 `writeU64(0)` 留 NULL 指针（→ 9/2 证实是主犯）；② Go 侧无全局发送锁；③ 兜底 timer 与失败窗口的时序。

### 2026-08-27 —— C 类：视频连发第二会话必失败（非崩溃）

同一视频先发个人（成功）再发群（三次重试全失败）。根因：同一文件重复上传走 CDN 秒传，`cndOnComplete` 响应里 cdnKey 相同但 **aesKey 为空**，上游脚本直接 abort（`cdnKey or aesKey 为空`），send_video 永不触发。图片不受影响（图片回调里 aesKey 始终有值）。

**修复**（commit `15294ed`）：`cdnVideoKeyCache` 按 cdnKey 缓存首次成功的 {aesKey, md5Key, videoId}，秒传响应回填。
**上游也有此 bug**，已提 issue: https://github.com/yincongcyincong/wechat_chatter/issues/35

### 2026-09-02 02:22:27 —— A 类（第三次，定位大幅收窄）

**时序**（wxgate.db + wxgate.log，db 时间为 UTC）：
```
02:22:07  文本 "MTV视频:..." → ludaohe  ✅ 成功（成功路径 writeU64(0) 埋下 NULL 节点）
02:22:08  图片 → ludaohe，发出后无 ack
02:22:11  3s 兜底触发（应已复原图片任务的原始指针）
02:22:23  Go 15s ctx 超时 → "send timeout"
02:22:27  💥 崩溃（图片失败后 ~4s，文本成功后 ~20s）
02:22:37 / 02:23:09  wxgate 两次重试图片，微信已死，pending
06:56     人工重启恢复（躺尸 4.5 小时）
```

**关键证据**：mars::stn 崩溃时停在 mutex 等待（不在 Req2Buf，排除重试并发）；3s 兜底按时触发却没防住（排除"伪造结构体残留"为唯一机制）；崩溃前 20 秒有一条**成功**的发送。

**结论**：最自洽的解释 = 放大因素①。成功路径把任务的消息指针写成 NULL，任务对象留在 mars 任务 map 里；图片失败触发清理 erase 时，红黑树遍历到脏节点崩溃。**地雷是成功的文本埋的，失败的图片只是引线。**

**修复**（commit `c0ee628`）：成功路径也复原 `originalInsertMsgPtr`，不再写 0（原始指针是 sendFunc 构造的合法消息，复原=全程原生状态）。原始指针不可用时仍回退写 0。
**配套**（wxgate 仓库 commit `f1d0017`）：start.sh 的 onebot.log 从 `>` 截断改为 `>>` 追加 + 启动分隔行。

### 2026-09-07 15:36 / 16:07 —— A 类（视频 duration=0 必崩，当日已修）

**现象**：发视频必崩（两个不同视频同指纹，均为 A 类：栈顶 0x21e40 + 中间帧 0x3a5b\*\*\*），文字/图片完全正常。时序高度一致：`发送视频消息成功` → `autoBufferWrite 完成` → **~3 秒后 SIGSEGV**；崩溃跑里视频任务从未走到 buf2resp（健康跑 1 秒内就有）。

**根因**：launchd/看门狗拉起的 onebot 进程 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`，找不到 `/opt/homebrew/bin/ffprobe` → `获取视频时长失败`（worker.go GetVideoDuration）→ **duration=0** → `BuildVideoMsgProto` 的 playlength 字段被 proto3 直接省略 → 微信协议层发送成功，但随后自身消息处理/任务回收路径踩 NULL（A 类机制）。A/B 证据：09-02~09-06 每天 07:53 定时视频（duration>0，当时 start.sh 手动调用继承交互 shell 完整 PATH）零崩溃；当天 11:2x 手动调 start.sh 同样 duration=10；15:36 起看门狗拉起后 duration=0 两次全崩；16:33 修复后 duration=10 发送成功且微信存活。

**修复**：wxgate `start.sh` 启动 onebot 前 `export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:$PATH"`（当日 16:29 部署 mac-m1 生效，16:33 验证通过）。

**验证时的坑**：同一视频重复发送会撞 C 类秒传（aesKey 空 → abort → HTTP `send timeout`），看起来像"还是失败"。绕过：`ffmpeg -c:v libx264` 重编码改变流哈希强制首传。追加尾巴没用——cdnKey 只对视频流内容敏感。

### 2026-09-20 —— 4.1.12 适配期两起崩溃（本地实验机，不影响生产）

**A. 合成文本发送必崩（free 残骸野回调指针，已修待合入）**

**现象**：本地 4.1.12 + gadget，`triggerSendTextMessage` 一发就崩，栈顶落在 sendFunc 构造的任务结构被子函数 delete/虚调用的位置。4.1.11 生产同代码零崩溃。

**根因**：`triggerX1Payload` 是从上一次真实任务捕获的指针，微信早已 free 该 slab（毒化填充）。4.1.12 任务结构多了 +0x18（info ptr 0x2a0→0x2b8），残骸里的回调子对象指针比 4.1.11 更"野"，直接复用必踩。

**修复**（staging `/tmp/onebot-run/script.js` 已验证，**待合入仓库 onebot/script.js**）：sendFunc 入口快照整块任务结构（0x300 字节），`triggerSendMediaMessage` 写 payload 前先整块恢复快照，重建合法回调子对象后再注入。

**B. UI 发图即崩（盲挂候选改写运行时 __TEXT，方法已废弃）**

**现象**：用户在 UI 手动发图，微信 SIGILL。崩溃 PC 0x53a827c，但该地址静态字节是 `mov x0,x21`——这条指令不可能 SIGILL。

**根因**：discover 驱动对 harvest 出来的未知指针直接 `Interceptor.attach`（盲挂），等于往运行时 __TEXT 里插桩打补丁。挂错点后原指令语义被破坏，用户正常操作踩中。46K+ 处 `ldaddal` 释放序列命中也证明非 distinctive 字节模式做候选过滤毫无区分度。

**教训（铁律）**：发现流程必须静态优先——字符串锚定/结构匹配 + callscan 目视确认后才允许挂运行时；绝不盲挂。配套方法论已沉淀到 `.claude/skills/wechat-version-upgrade/SKILL.md` + `tools/addrfind/string_anchor.py`。

**C. 附带发现（frida 约束）**：`Interceptor.attach` 在 `bl` 指令上必失败（"unable to intercept...please file a bug"），且该异常会中断同一 setup 函数里后续所有 hook。下载三件套 hook 点一律取 `bl` 前一条 `mov x1,xN`，数据寄存器 4.1.11 x22 → 4.1.12 x21（寄存器分配漂移，跨版本必须逐版 callscan 确认）。

**D. 文本发送崩 Req2Buf 虚调用（重构引入的执行顺序 bug，当日已修）**

**现象**：重构基址解析后首次文本发送，~1s 后 SIGSEGV。崩溃点 `wechat.dylib+0x413ea24`（`ldr x8,[x8,#0x10]`，FAR=0x10），位于 Req2Buf 内 rbtree find 之后：find 正确命中我们冒充的节点（x23=sendTextMessageAddr，key+0x20 匹配），但 `[value+0x28]` 指向的 textMessageAddr 的虚表槽读出 0。

**排查手法（值得复用）**：先把 4.1.11/4.1.12 的 Req2Buf 从 hook 点开始**逐指令对比**——两版完全同构（`ldr x9,[x24,#0x60]!` + 同一 rbtree find + 同一虚调用序列），证明 addrfind 推出的基础地址**零漂移**、注入机制本身成立；再加只读 DIAG 在 setup 末尾回读，一把抓到 `fakeVtable=0x0`。

**根因**：`initAddresses()` 被改成脚本体顶部**同步**调用（原为 Memory.scan 的 onComplete 回调）。此时脚本中部的 `var fakeVtable = ptr(0)` 等初始化**尚未执行**；setupRetOneStub 先赋值 fakeVtable，脚本继续执行到 var 初始化行又把它**重置回 0**，随后 setImmediate 的 setupSendTextMessageDynamic 把 0 写进 textMessageAddr+0x00 → 虚空调用。

**修复**：派发包进 `setImmediate`，恢复"全脚本 var 初始化完成后才 initAddresses"的语义。修复后文本全链路验证通过（BLR X8→autoBufferWrite→buf2resp ack）。

**铁律**：**initAddresses 只能异步派发（setImmediate/回调），绝不同步提前调用。** 改 script.js 顶层执行顺序时，必须确认所有 `var X = ptr(0)` 初始化与使用点的先后关系。

**E. 基址竞态：hook 全挂到堆上（"req2buf" 扫描法新失效模式，当日已修）**

**现象**：onebot 启动日志正常（"已就绪，控制通道已打通"），但登录后零同步流量、triggerX0 永远捕不到、发送报"尚未初始化"。无崩溃无报错，纯静默死亡。

**根因**："req2buf 字符串 + >100MB range" 扫描存在**竞态误命中**：堆区 MallocHelperZone（合并 range >100MB，rw-）里也有 "req2buf" 字符串拷贝，扫描回调先到就赢 → 基址定到 0x130000000 堆上（真身 __TEXT 实际在 0x148000000，vmmap 实证），全部 hook 挂空。此前只知道大 range 碎裂会"失败"，这次发现还能"**错误地成功**"。

**修复**：模块表优先（真身是全进程唯一 >50MB 的 wechat.dylib，无竞态）；字符串扫描仅兜底且必须校验 range 含可执行权限。注意修复本身曾引入 D 类 bug——见上条，两个改动必须一起回看的教训就在这。

**F. gadget 会话耗尽（运维约束）**：反复重启 onebot（一个下午 4-5 次）会耗尽 gadget 内部会话资源 → 控制通道整体卡死（frida-ps 都 hang）→ 只能重启微信进程恢复。**改 script.js 要批量改完再重启，别改一处重启一次。**另外 macOS 按 bundle ID 单例激活：日常 4.1.13 在跑时 `open` 4.1.12 是空操作，必须 `open -n`。（2026-09-21 实测预算 ~9 次/微信生命周期。）

**G. gadget 会话拆除竞态崩宿主（2026-09-21 08:48 实锤，新铁律）**：
```
触发:    kill onebot(优雅退出也算) → ~8s 后微信 SIGSEGV
线程名:  frida-gadget-tcp-27042 (gadget 自己的 TCP 控制线程)
栈顶:    野地址(0x139a38038); 后续帧全在 FridaGadget.dylib (+0x1d1d38/+0x1d1f40 会话拆除路径)
与适配代码无关: 当时两次发送均 fail-fast 未调 SubmitCgi
```

本质：kill onebot = gadget 会话拆除，拆除路径本身有竞态（同样的 kill 08:46 活了、08:48 崩了，概率性）。与 F 同族（gadget 会话生命周期脆弱）。
**修复 = 规程**：换 script.js 必须**微信+onebot 同步重启**（先重启微信再起新 onebot），永不单独 kill 存活微信上的 onebot。

### 2026-09-21 23:07:56 —— H 类：detach 拆 syscall 蹦床竞态崩微信

**时序**：出队泵 v3b 的"懒拆卸"设计（60s 队列空则 detach 7 个 syscall hook）——
23:07:55 拆卸定时器到期执行 `forEach l.detach()` → 23:07:56 微信 SIGSEGV。
崩溃报告 `WeChat-2026-09-21-230802.ips`：crashedThread = `frida-gadget-tcp-27042`，
跳转地址 0x125184038 = 被撕裂的蹦床。当日第三次重启（23:09）后泵改**首挂常驻**
（v3c），`v3SchedulePumpDisarm()` 变 no-op，复跑至今未复发。

**根因**：detach 恢复原始指令的窗口期内，正有线程在半恢复的 syscall 蹦床里运行。
**铁律：hook 只挂不拆**（热路径尤其）；空闲开销用 onEnter 快路径 + tid 门，不用 detach 省。

**同夜关联修复（短链/长链间隙饿死）**：22:50 实锤 45s 全 CGI 静默 → 三个短链
出队点零事件 → 30s 保质期放弃 → Go 504。修复 = 出队泵 v3c 常驻（7 syscall ×
合法 tid 门）+ 保质期 30s→85s + Go ctx 90s + HTTP 91s + OnPush 第 4 出队点。
详见 docs/4.1.13-submitcgi-analysis.md §8。



| commit | 仓库 | 内容 |
|---|---|---|
| `1f46848` | weixin-macos | pendingBuf2RespTasks 任务表 + 10s 超时兜底复原原始指针；大 range 扫描失败的模块表兜底 |
| `74af55e` | weixin-macos | 兜底超时 10s→3s，赶在 mars ~5s 失败窗口前 |
| `15294ed` | weixin-macos | 视频 CDN 秒传 aesKey 空时按 cdnKey 回填缓存钥匙 |
| `c0ee628` | weixin-macos | 成功路径也复原原始指针，不再写 NULL |
| `f1d0017` | wxgate | onebot.log 追加模式，保留崩溃现场 |
| `d852c00` | wxgate | start.sh export homebrew PATH（duration=0 崩溃根因，2026-09-07 部署验证） |
| `e92caf0` | weixin-macos | 视频双保险：duration 探测失败 fail-fast + CDN 钥匙持久化 `cdn_video_keys.json` 启动回灌 |

## 遗留问题（按优先级）

1. **watchdog 未做**（收益最大）：A 类崩溃发生在微信自有代码路径，根治无把握。崩了自动 `open ~/Applications/WeChat.app` + 等就绪 + `start.sh restart`，把躺尸从小时级缩到分钟级。检测信号：`pgrep -x WeChat` + 58080 健康检查。
2. **Go 侧无全局发送锁**：并发 HTTP 发送可能交错全局变量（`originalInsertMsgPtr`/`taskIdGlobal`/`sendMsgType`）。`SendWorker` 虽是单 goroutine，但图片/视频的上传是异步的（`pendingResultMap` 按 targetId 寄存），上传在途时下一条发送仍可注入。同一 target 并发媒体上传还会在 `pendingResultMap` 互相覆盖。
3. **IDA 深挖未做**：`0x3a5b***` / `0x1d8e***` 里被 erase 的到底是哪个 map、为什么节点是脏的。远端曾 lipo 出 `/tmp/wechat_arm64.dylib`（可能已被清理）。方法论：lipo -thin arm64 → objdump 反汇编 → 对照 wechat_version/*.json 已知地址。
4. **B 类（cdn worker 下载路径）**未修未复发，观察中。
5. ~~**cdnVideoKeyCache 仅内存态**~~ **已修**（`e92caf0`，2026-09-07）：钥匙落盘 `onebot/cdn_video_keys.json`，启动经 rpc `hydrateCdnVideoCache` 回灌。实测重启后重发同一视频秒传命中回灌缓存，发送成功。注意：CDN 秒传引用似乎会过期（同文件 2.5h 后重传走了全新上传），两种路径都已覆盖。
6. ~~**duration 探测失败仍继续发送**~~ **已修**（`e92caf0`，2026-09-07）：`GetVideoDuration` 失败直接 fail 该任务，不再以 duration=0 发送引爆 A 类。

## 运维要点（血泪教训）

- **script.js 是 onebot 启动时读盘的**（main.go 里 `os.ReadFile("./script.js")` 只执行一次）——改完 rsync **必须 restart onebot 才生效**，不存在热更新。而 restart onebot 对存活微信是拆除竞态（G 类）⇒ **换脚本的完整规程 = 改好 → 重启微信 → 登录 → 起新 onebot**，一步到位别反复
- **不能随意改逆向地址定位逻辑**：原 script.js 扫 "req2buf" 字符串 + >100MB 大 range 是区分 stub/真身的判别器。微信运行数小时后大 range 会碎裂（449→486 个），扫描会持续失败——兜底分支（模块表取 name=wechat.dylib 且 size>50MB 的最大者）不是理论需要，实战触发过
- onebot 裸跑不带 `-wechat_conf` 会去找 4_1_11_53 的 json（上游改了 flag 默认值），远端装的是 4.1.10.53。start.sh 已显式传参，别把 4_1_11 json 同步到远端
- onebot 断线 3 天后不会自动重连；微信崩溃后 onebot 不会自己恢复，恢复 = `open ~/Applications/WeChat.app` + `cd ~/Prog/wxgate && bash start.sh restart`
- 日常管理：`cd ~/Prog/wxgate && bash start.sh {start|stop|restart|status}`
