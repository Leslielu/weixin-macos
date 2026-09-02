# 微信 Bot 崩溃档案与排查手册

> 排查任何崩溃/发送异常前**先读本文**。记录历次崩溃的指纹、根因分析、已上线的修复和遗留问题。
> 最后更新：2026-09-02

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

## 已上线修复汇总

| commit | 仓库 | 内容 |
|---|---|---|
| `1f46848` | weixin-macos | pendingBuf2RespTasks 任务表 + 10s 超时兜底复原原始指针；大 range 扫描失败的模块表兜底 |
| `74af55e` | weixin-macos | 兜底超时 10s→3s，赶在 mars ~5s 失败窗口前 |
| `15294ed` | weixin-macos | 视频 CDN 秒传 aesKey 空时按 cdnKey 回填缓存钥匙 |
| `c0ee628` | weixin-macos | 成功路径也复原原始指针，不再写 NULL |
| `f1d0017` | wxgate | onebot.log 追加模式，保留崩溃现场 |

## 遗留问题（按优先级）

1. **watchdog 未做**（收益最大）：A 类崩溃发生在微信自有代码路径，根治无把握。崩了自动 `open ~/Applications/WeChat.app` + 等就绪 + `start.sh restart`，把躺尸从小时级缩到分钟级。检测信号：`pgrep -x WeChat` + 58080 健康检查。
2. **Go 侧无全局发送锁**：并发 HTTP 发送可能交错全局变量（`originalInsertMsgPtr`/`taskIdGlobal`/`sendMsgType`）。`SendWorker` 虽是单 goroutine，但图片/视频的上传是异步的（`pendingResultMap` 按 targetId 寄存），上传在途时下一条发送仍可注入。同一 target 并发媒体上传还会在 `pendingResultMap` 互相覆盖。
3. **IDA 深挖未做**：`0x3a5b***` / `0x1d8e***` 里被 erase 的到底是哪个 map、为什么节点是脏的。远端曾 lipo 出 `/tmp/wechat_arm64.dylib`（可能已被清理）。方法论：lipo -thin arm64 → objdump 反汇编 → 对照 wechat_version/*.json 已知地址。
4. **B 类（cdn worker 下载路径）**未修未复发，观察中。

## 运维要点（血泪教训）

- **script.js 是 onebot 启动时读盘的**（main.go 里 `os.ReadFile("./script.js")` 只执行一次）——改完 rsync **必须 restart onebot 才生效**，不存在热更新
- **不能随意改逆向地址定位逻辑**：原 script.js 扫 "req2buf" 字符串 + >100MB 大 range 是区分 stub/真身的判别器。微信运行数小时后大 range 会碎裂（449→486 个），扫描会持续失败——兜底分支（模块表取 name=wechat.dylib 且 size>50MB 的最大者）不是理论需要，实战触发过
- onebot 裸跑不带 `-wechat_conf` 会去找 4_1_11_53 的 json（上游改了 flag 默认值），远端装的是 4.1.10.53。start.sh 已显式传参，别把 4_1_11 json 同步到远端
- onebot 断线 3 天后不会自动重连；微信崩溃后 onebot 不会自己恢复，恢复 = `open ~/Applications/WeChat.app` + `cd ~/Prog/wxgate && bash start.sh restart`
- 日常管理：`cd ~/Prog/wxgate && bash start.sh {start|stop|restart|status}`
