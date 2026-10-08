# 语音 3600B 截断战役 — 状态总览与续战手册

> **本文是战役唯一入口文档。** 历史逐轮记录见
> `docs/voice-upload-investigation-2026-10-06.md`（第一~六轮全程实验、崩溃报告、教训）。
> 本文件回答："现在到哪一步了、下一步做什么、所有地址/文件/命令在哪"。
> 更新于 2026-10-07 晚（第八轮：rig 环境全链路胜利）。

## 0. 一句话状态

**目标**：OneBot 发语音 >3600B（≈1.5s）不再截断，接收端完整播放。
**当前**：✅ **rig 环境全链路打通（2026-10-07 16:10，v3.8 路径A）**——
19438B/10s 语音经旧路 CGI 直传，接收端（手机 filehelper）**完整播放**，
微信零崩溃、泵零调用。剩余 = 生产移植（§4 落地清单）。
**保底**：生产 mac-m1 走 record→file 降级，全程未受影响。

## 1. 机制全景（全部实证，本地/生产同址）

### 1.1 两条上传路（由 `TryMultiphase` 闸门选择）

```
start_c2c_upload(本地0x575bef4 / 生产同址但JSON当年记的是内层0x575c75c)
  └─ _startUploadMedia(0x575c75c, = 生产 uploadImageAddr)
       ├─ TryMultiphase(0x574c0c4, appconfig.cc) == true  → c2c multiphase 流式
       │    协议: c2c/upload_init → upload_part(/small_fragment) → finish → complete
       │    传输: HTTP/Cronet; "cdntask %_ must serial upload."(串行)
       │    ★ 依赖录音会话状态机 —— 合成任务复刻不出 → 只出 3600B(截断根因)
       └─ == false → 旧路(自包含 CGI 直传, 不需要会话)
            task+0x40==1 → 0x575d210 → 0x58c3b44(mgr, task, 1, flag)   ← force-legacy 走这条
            task+0x40==2 → 0x58c9124(mgr, task, 1)
            task+0x40==3 → 0x58c9940(mgr, task, 0)
```

- `uploadvoice` CGI（cmdid 19）仍在 4.1.13 mars 路由表
  （`<cgi reqid="19" respid="1000000019">uploadvoice</cgi>`）——旧版（旁人成功案例）
  走的就是它，4.1.13 只是默认不开。
- **TryMultiphase 语义**：task[0x40]==2→false；==8→true；task[0x9C]∈{7,9,0x4EEA,0x4F4E}→true；
  其余（voice=0x0F/img/video）落长判定树（+0x178 向量 26MB 上限、apptype 等）→ 语音默认 true。
- **force-legacy** = Interceptor.attach(0x574c0c4) onLeave 对 0x9C==0x0F 的任务
  `retval.replace(0)`。✅ 已实测：引擎进 0x58c3b44，**上传 result=0，钥匙全返回**。

### 1.2 任务对象模型（task = 0x2A0 模板，引擎会重建）

| 区段 | 内容 |
|---|---|
| task+0x0 / +0x8 | **std::shared_ptr<数据源>{T\*, 控制块\*}** — 截断战役的绝对核心 |
| +0x40/+0x44 | {1,1}：+0x40=请求类型(1=multiphase可用)，+0x44=apptype(TryMultiphase 输入) |
| +0x48/+0x50/+0x58 | fileId 的 std::string（alita_1_\<md5(自己wxid)\>_15_0_\<seq\>） |
| +0x68/+0x7F | receiver（inline SSO + 长度字节） |
| +0x9C | 媒体类型 u8：0x0F=voice / 0x01=img / 0x04=video |
| +0xD8 | {3600, 1800} 常量（协议分片参数，非任务大小） |
| +0x100/+0x108/+0x110 | silk 数据 std::string {ptr, len, cap=ceil8(len)\|0x8000...} |
| +0xe8/0x118/0x148 | 路径槽三连（img/video 用，**语音原生全零**） |

- 控制块 CB = {析构虚表@0x9962540, **引用计数@+8**（binder `ldadd`+1，这里挂 hook 会
  mprotect 页 → SIGBUS，已入铁律）, 计数@+0x10, 销毁fn@+0x18(0x99CBC18), T\*@+0x20}
- T（数据源对象，**0x3F8 字节**）：{二级虚表0x99CBD00@+0, T-8@+8, CB@+0x10,
  主虚表0x99CBE08@+0x18, 堆ptr@+0x20, 0x32aaaba7@+0x28} + 8×0x78 子块
- **0x32aaaba7 = macOS `_PTHREAD_MUTEX_SIG`**（高度疑似）——T 内所有该常量 = 初始化过的
  pthread mutex 签名
- T 的虚表（0x99CBD00，12 槽）：+0x10=0x429e890(→0x429e4fc GetCallbackWrapper)、
  +0x30=0x429fa14(→**0x429eff4=cndOnComplete 本尊**)；upstream 的 fake uploadCallback
  就是此接口的残缺复刻（只填 2 槽，img/video 靠路径槽够用，语音没有路径槽）
- 引擎调用链：内部任务+0x40 持 shared_ptr → 0x570a0a0 调 `vt+0x10(T,x1,x2,x3)` →
  T+0x10 里还有第二层 shared_ptr（真录音会话闭包）

### 1.3 worker 上传泵（崩溃层，当前卡点）

- worker 线程（0x62c9ee0 入口 → 0x42a1d98 的 F 函数）与上传并行；
  **0x248aaac(x0=T+0x180, x1, x2=need, x3=have) = 泵内"have≥need 检查"**，
  原生实测两次调用（x2=147/x3=14656、x2=x3=14648）均 rv=0 秒回
- **[T+0x188] = P（数据队列）**：mars 标签同步对象——MUTZ(0x4d55545a)@0x00/0x20、
  MUTX(0x4d555458)@0x40/0x58、游标@+0x0c/+0x54、+0x30=-1、+0x38={0x9c1a267f,-2}
- 0x6d963ac = libc++ mutex/throw 族 stub；P 不满足 → `__throw_system_error` → terminate
  （crash: 0x248ab0c ← 0x42a1d98 ← 0x62c9ee0，已见 3 次）
- **假 T 曾 alloc 0x80（实际需 0x3F8）→ 引擎写 [T+0x188] 越界踩坏 frida 堆**——
  曾经的 gadget 内部崩溃/类型怪错全源于此，v3.6 已修（0x400）

### 1.4 旧路上传完成结构（VOICEDUMP 实测）

fileId@0x28、receiver@0x48、**cdnKey@0x68（202hex）、aesKey@0x80、md5Key@0x98**、
len@0x110（语义未定，10377≠19423 待解）、CDN IP@0x1c8/0x228。
已实测拿到全套钥匙（md5(ludaohe)=6520ba91... 的 alita id）。

## 2. 当前实现栈（onebot/rigcapture.js，全部已入仓库）

| 组件 | 状态 | 说明 |
|---|---|---|
| force-legacy hook | ✅ 实测有效 | TryMultiphase onLeave 对 voice 任务 retval.replace(0) |
| 旧路 handler 观察点 | ✅ | 0x58c3b44/0x58c9124 进入日志 |
| **假 T/CB/P 数据源对象** | 🆕 未验证 | 0x400 alloc（修越界）、12→10 槽 CModule vtable、P 标签+游标=全长 |
| **泵 no-op** | 🆕 未验证 | forceLegacy 时 Interceptor.replace(0x248aaac, CModule 返回 0) |
| **legacy completion 直发** | 🆕 未验证 | cndOnComplete 叠加 hook，按固定布局(0x28/0x48/0x68/0x80)直读直发 upload_voice_finish |
| sync trace / binder 全量 dump | ✅ 只读 | 原生录音时抓 T[0x3F8]/P[0x100] |
| worker.go | ✅ | triggerUploadVoice 改为内存式签名（传 silk hex） |

## 3. 续战操作手册

### 3.1 恢复现场（/tmp 会被清，一条命令重建）

```bash
cd /Users/leslielu/Prog/weixin-macos && bash onebot/rig-setup.sh
```
（脚本做：rig JSON + 脚本包 + 渲染语法预检 + 探针命令文件 + 测试物料，并打印启动命令）

### 3.2 会话流程

1. 打开 `~/Applications/WeChat-4.1.13.app` 登录
2. 启动 onebot（命令见 rig-setup.sh 输出；**必须带 `-wechat_id=ludaohe`**，
   否则 fileId 的 md5 是 md5("")；`-image_path` 不带则图片发不出去）
3. 等 60s 登录稳定门；**新实例需一次媒体活动激活 CdnManager 单例**
   （手机给 ludaohe 发张图 → 下载 hook 回填 uploadGlobalX0）
4. 发测试语音：`curl -s -X POST -H "Content-Type:application/json" -d @/tmp/probe_send.json
   --max-time 130 http://127.0.0.1:58080/send_private_msg`
5. 看日志：`grep -E "RIGCAP3|RIGPROBE|LEGACY|VOICEDUMP" /tmp/onebot-run/onebot.log`

### 3.3 预期与判读

正常链 = `bp *` 全 ok → `P cursors set` → `LEGACY handler entered` →
`LEGACY completion OK` → `upload_voice_finish sent to Go` → Go 日志 send_voice →
**手机文件助手收到语音，播放 10s**。若崩：看最新
`~/Library/Logs/DiagnosticReports/WeChat-*.ips` 的 faultingThread——
- `0x248ab0c` = 泵 no-op 未生效或 P 仍不满足 → 检查 forceLegacy 与 P 内容
- FridaGadget 全栈 = 又踩了堆 → 检查对象尺寸/越界
- 引擎侧新地址 = 下一层缺失字段（把帧址记入调查文档）

### 3.4 参数通道（会话内换行为，不重载脚本）

`/tmp/rig_probe_cmd.json`：`{"mode": 0, "forceLegacy": true}` — mode 位含 serve 契约
A/B（未启用）；forceLegacy 控制泵 no-op 与 TryMultiphase 强制。

## 4. 若全链验证通过 → 落地清单

1. rigcapture.js 的 force-legacy/泵 no-op/legacy completion 逻辑移植进生产
   `onebot/script.js`（生产地址已验证与本地同址，九函数字节级一致）
2. `make build` → 重签名（**铁律：每次 build 必签**）→ rsync 到 mac-m1 →
   `~/Prog/wxgate/start.sh restart`
3. pause watchdog → 五媒体回归（test-assets）→ 恢复 watchdog
4. 目标：voice 走真语音（替换 record→file 降级）
5. 风险边界：bot 号（wxid_4erh8rirquu921）= 可接受风控；ludaohe = 主号，
   仅限 filehelper 目标的验证性发送

## 5. 待解清单（按优先级）

~~1. v3.7 会话未跑~~ → **第八轮 v3.8 全链路胜利（见 §8）**
~~2. 对象完整性：+0x110=10377 ≠ silk 19448，播放是终极验证~~ → **手机完整播放 10s，终极验证通过**
~~3. v3 locator 锚扫描为何在 legacy 完成结构上未命中~~ → **干净状态（无假P/无泵干扰）下直接命中 delta=0x8**
~~4. P 游标/字段语义精确定义~~ → **不需要：旧路任务根本不启动 worker 泵，假 P 整条线撤销**
5. img/video 回归：force-legacy 只对 0x9C==0x0F 生效，理论上零影响（生产部署时顺手回归）

## 6. 铁律速查（战役专属，通用铁律见 AGENTS.md / 调查文档）

1. **引擎 mmap 闭包池只读不 hook**（frida mprotect → 引擎 ldadd 引用计数 → SIGBUS）
2. 一切被引擎调用的自有代码 = CModule（frida code allocator 页）
3. CModule(TCC) 不认 `__sync_fetch_and_add`；本地 frida-go 运行时对 uint64/pointer
   参数严格——**先 cmodtest 预验证再进会话**
4. 假对象尺寸必须 ≥ 原生（0x3F8）——越界写踩 frida 堆 = 漂移症状之源
5. 换脚本 = WeChat+onebot 完整重启（不 kill 存活微信的 onebot）
6. 会话内参数切换走 `/tmp/rig_probe_cmd.json`（JS 每次发送前读）

## 7. 2026-10-07 晚间追加：v3.7 会话结果与下一步修正

**v3.7 会话（15:55）**：泵 no-op 生效（0x248aaac 的 system_error 消失，引擎流走通），
但崩溃点转移进 **frida gadget 内部**（全 gadget 栈，SIGSEGV@JS堆指针）——
替换后的泵蹦床或回调链出了新问题。同时确认：v3.4 的 "NativePointer object expected"
是暂态（v3.5 加检查点后 rigBuildProbe 全步通过，疑与 x0 解析时序相关，未再复现）。

**候选路径（按收敛成本排序）：**

- **路径 A（最便宜，先试）："跑赢竞态"策略**。回退泵 no-op 与假 P（回到第五轮状态：
  上传同步完成+钥匙+约 18s 后泵炸）。completion 直发 hook（v3.2 已实现）在
  cndOnComplete 时刻（同步上传内）就触发 upload_voice_finish → Go 发消息只需 2-5s，
  远快于泵崩溃的 ~18s 窗口。第五轮实测竞态时序：完成 ~34s、崩 ~52s（送出后 18s）。
  一次会话成功率约五成，崩了重来即可（消息一旦送出，服务端已受理）。
- **路径 B（彻底）**：静态啃完 0x248aaac 全函数（0x62d0f9c 判定、list 迭代、节点虚表）
  + 0x6d963ac 真身（GOT 0x9696638 auth-fixup 未解码），构造完全合法的 P——
  泵自然跑完不崩。工程量 1-2 个静态会话 + 1 个验证会话。
- **路径 C（保底）**：维持 record→file 降级。

**当前推荐**：先 A（改动最小：rigcapture 删泵 no-op 与 T+0x188=P 两段即可，
其余保持），A 失败两次再考虑 B。

### 泵语义补充（第六/七轮新证）

- 0x248aaac 原生两次调用均 **rv=0 秒回**（x2=147/x3=14656、x2=x3=14648），
  即 have≥need 时**不阻塞**——阻塞/抛错发生在其后段（锁后队列状态判定）。
- P+0x40 的 MUTX 标签在原生任务下锁定成功、在假 P 下抛 system_error，
  二者字节相同 → 差异不在标签，在其后段读取的队列状态字段（空列表/游标）。
- 0x6d963ac 真身 = GOT 0x9696638（auth-fixup 编码，未解码）→ libc++ throw 族。

## 8. 2026-10-07 16:10 第八轮：v3.8 路径A — 全链路胜利 🏁

**改动**（`onebot/rigcapture.js` v3.8）：删三处——假 P 构造（v3.4）、泵 no-op replace
（v3.7）、发送时 P 游标写入。假 T 保持 v3.6 形态（0x400 全零），泵 0x248aaac 保留
原生实现只 attach 观察。force-legacy + LEGACY handler 观察点 + completion 直发全保留。

**实测时序（ludaohe → filehelper，19438B silk / 10s）**：

**可重复性验证（16:18 / 16:22 追加两轮）**：同物料重发 + 13.8s/26712B 真人 TTS
（mac-m1 `~/Prog/wxgate/botmedia/58_1791292141.wav`，≈7.4× 截断阈值）三轮连发
全部 result=1、手机完整播放、微信零崩溃；第三轮日志链更深一层：
`SubmitCgi 原生线程提交 → V3 ack 命中 → buf2resp 响应成功 → 任务完成`
（服务端受理回包确认）。seq 递增（1/2/3）无冲突。**结论：稳定可复现。**

| 时刻 | 事件 |
|---|---|
| 16:10:34 | triggerUploadVoice → bp 全 ok（无 P 段）→ LEGACY handler 0x58c3b44 entered |
| 16:10:36 | `startUploadMedia rv=0`（旧路同步 CGI 直传完成）；引擎经假 T vtable 调 GetCallbackWrapper（freshT=引擎重建）正常 |
| 16:10:36 | **script.js 原有 v3 locator 命中**：`cnd定位成功(全槽验证通过) delta=0x8`，cdn(202hex)/aes/md5 全返回 |
| 16:10:36 | Go `混合式语音上传结果 duration_ms=10000 result=0` |
| 16:10:37 | Go `send_voice 发送语音任务执行结果 result=1` |
| 之后 | **手机 filehelper 收到语音，完整播放 10s**（用户确认）；微信存活零崩溃，发送后 80s+ 无 .ips |

**三个推翻旧假设的发现**：

1. **回钥匙的是 script.js 原有 v3 locator，不是 rigcapture 的 completion 直发**
   （`upload_voice_finish` 0 次触发，locator 直接命中 delta=0x8）。
   第五轮时代 locator 不命中 = 假 P / 泵 no-op 干扰所致；干净状态下旧路完成结构
   与 c2c 同族，locator 全槽验证直接过。→ completion 直发（v3.2）可整段删除。
2. **旧路（同步 CGI 直传）根本不启动 worker 泵**——泵对假 T 与引擎重建 freshT
   均 0 次调用（sync trace 证实）。第五轮"~18s 后泵炸"是 v3.4 假 P / 0x80 假 T
   时代畸形状态的产物，v3.6+v3.8 形态下不存在。→ 路径 B（静态啃泵）永久关闭。
3. **全链 <2s 完成**（34→36→37s 三跳全在同一秒级内），无竞态窗口可言。

**生产移植面（比预想小得多）**：rig 链路复用了 script.js 全部既有组件
（locator 抓钥匙、Go 混合式两段任务、CdnManager 互回填），需要移植的只有：
- rigcapture 的 **force-legacy hook**（TryMultiphase onLeave retval.replace(0)，约 20 行）
- **假 T/CB/vtable CModule 对象**（0x400 假 T + 10 槽 vtable + ring，约 80 行）
- **triggerUploadVoice 接管**（内存式签名 + task 字段组装，约 60 行）
worker.go 内存式签名改动已在仓库。

## 9. 2026-10-07 傍晚：生产移植 — 上传通、完成链崩（进行中）

**移植内容**（本地已 commit 待推）：
- `wechat_version/4_1_13_63_mac.json` 新键 `tryMultiphaseAddr=0x574c0c4`
  （script.js `{{if .tryMultiphaseAddr}}` 可选键渲染，旧 JSON 缺键自动走原路径，
  4.1.11 渲染验证通过）
- `onebot/script.js`：VOICE_PROBE_C（与 rigcapture 逐字节同，去 pump_nop 死符号）
  + buildVoiceProbe（0x400 假T） + armVoiceForceLegacy + triggerUploadVoice 回调对分支
- 签名注意：**本机(M4-work/Sequoia) 临时钥匙串免弹窗法失效**（set-key-partition-list
  过但 codesign 仍 errSecInternalComponent）；改走 login.keychain 导入 p12 +
  弹窗输本机密码一次（已"始终允许"，后续免弹）。

**生产部署后语音首测 = 必崩**（两次复现，mac-m1 bot 号 wxid_4erh8rirquu921）：

| # | 时刻 | 目标 | 崩溃指纹 |
|---|---|---|---|
| 1 | 16:41 | filehelper | SIGBUS KERN_PROTECTION_FAILURE @0x109cafaf8, PC=**0x429e540**(GetCallbackWrapper 真身 0x429e4fc+0x44 `ldadd x9,x8,[x8]`), 线程75 |
| 2 | 16:48 | ludaohe | EXC_ARM_DA_ALIGN **PA failure** @ASCII"frid...", PC=**0x429f0c0**(同区另一函数, 首指令同是 `ldadd`), 线程78, 寄存器全0 |

两次栈一致：`0x429exxx/0x429fxxx ← 0x570a0fc(shared_ptr调用器) ← 0x57d2220 ←
0x58e95a8 ← 0x58f1c60 ← 0x58ef0dc`——与 rig 成功会话 GetCallbackWrapper 的
bt 完全同链（完成回调分发路径）。

**第二次完整时间线（16:48）**：
voice任务(16:48:20) → probe built T=0x1128c7e08 CB=0x13f3db960 → UPSTRUCTDBG
tag=ours（+0x0/+0x8 回调对写入正确✅）→ 混合式上传成功 duration_ms=13814 →
VOICEDUMP + cndOnComplete(V3) **cdnKey 抓到** → 16:48:22 **崩** → Go 16:48:23
收到 send_voice 但 session 已断放弃。**语音消息未送出**。

**已排除**：
- ❌ 不是函数漂移：两端真 dylib（Resources/wechat.dylib，注意 Frameworks 下 84KB
  是 stub）`0x429e4fc` 起 128 字节 md5 一致（slice 偏移 0x0a9dc000）
- ❌ 不是 force-legacy 未生效/上传失败：两次上传均成功+钥匙全返回
- ✅ 基础功能无损：文本 result=1、图片 result=1、微信存活（force-legacy 只挂 voice）

**崩因分析（当前最强假设）**：崩点都是完成链对"二级控制块 CB2"的 `ldadd` 引用计数
（x8 取自 GetCallbackWrapper(this=T'-8) 的 `[this+0x18]`，反汇编实证：
`ldp x24,x19,[x0,#0x10]; cbz x19; add x8,x19,#0x10; ldadd x9,x8,[x8]`）。
T' = 引擎 binder(0x31df8ac) 从我们假任务重建的对象。rig 里 T'+0x10 槽=freshCB
（frida 堆，可写）→ ldadd 成功；生产 T'+0x10 读出垃圾/只读指针 → 崩。
**疑点：假 T 的 T+0x18（原生主虚表 0x99CBE08）/T+0x20（堆ptr）我们是全零**——
rig 的完成链没调到、生产调到了（本地/生产 dylib md5 不同，完成链 0x58exxx 系列
未做同址验证；生产 bot 原生流量并发也更多）。

**当前动作（16:5x）**：script.js 加了 VPDBG 只读观察点已部署——
binder(0x31df8ac) onLeave dump freshT[0x28]/freshCB + GetCallbackWrapper(0x429e4fc)
onEnter dump this/+8/+10/+18。看门狗全链拉起后（约 16:55 稳定）再发一次语音，
崩前即有 freshT 全貌 → 决定修复方向：
- 候选A：T+0x18 填自建 12 槽 stub vtable2（主虚表槽不落原生函数也不落零）
- 候选B：T+0x20 补合法堆指针
- 候选C：若 VPDBG 显示 freshT 完全垃圾 → 引擎重建读的字段超出我们认知，回 rig 对照

**回滚开关**：删 JSON 的 tryMultiphaseAddr 键 + 重启 = 语音回 3600B 截断版
（文本/图不受影响）。生产当前带崩溃版在跑，**语音勿用，文本/图正常**。

**生产试验循环成本**：每发一次语音崩一次 → 看门狗全链恢复 ~2-3 分钟
（微信启动+回车登录+TCC+onebot），试验节奏以此为准；试验期间 watchdog 勿长期挂起。

## 10. 2026-10-07 晚：17:04 崩溃破译 + v3.9 修复捆绑包（待本地验证）

**VPDBG 首战告捷，崩因定性**（四个 .ips + 反汇编 + GCW dump 三方印证）：

| # | 崩点 | 指纹 |
|---|---|---|
| 16:41 | GCW+0x44 `ldadd` | KERN_PROTECTION(只读页) → ldadd 目标是 vtable 指针 |
| 16:48 | 0x429f0c0 `ldadd` | 寄存器全零 |
| 16:53:56 | FridaGadget 内部 | gum JS 线程, 另族 = 堆污染随机引爆 |
| 17:04 | 0x429f0c0 `ldadd` | 目标 = ASCII"/re/frid"(0x646972662f65722f) = 字符串字节被当 CB |

- `0x429f0c0`(cndOnComplete+0xCC) 与 GCW+0x44 同构：读第二层 shared_ptr
  `[this+0x10]/{x21,[this+0x18]}`，非零则 `ldadd 1,[cb+0x10]`——崩 = 该槽是垃圾。
- **GCW dispatch dump 实锤：this=Treal 但 [+8]/[+0x10]/[+0x18] 全非我们写入值**
  → 引擎把 Treal 原地重建了。binder(0x31df8ac) 观察点全程未开火 → 重建在别处。
  异步分发链（线程77）：0x5a4fxxx → 0x58ea300 → 0x57d2528 → 0x57d2ad8
  （`x8=[mgr+0x2a8]`, `x2=x8+0x5b8`, `bl 0x570a44c`）。
- **探针跨发送缓存**（`voiceProbe`）= 第二发把第一发已重建态的对象再喂给构造器；
  16:58 成功 vs 17:04 崩 = 概率竞态（异步完成链读到的槽位时序不同）。
- 假 T 结构性缺口（文档§9候选A/B坐实）：主虚表位 T+0x18 全零、堆指针位 T+0x20 全零、
  vtable 仅 10 槽（原生二级虚表 0x99CBD00 实为 16 槽，+0x50..+0x78 落零=潜在跳零）。

**v3.9 捆绑包（commit ca5eeb8，script.js + rigcapture.js 同构）**：
1. 探针每发新建，历史探针永生保留（引擎异步完成链可能仍持引用，释放=UAF）
2. vtable 扩 16 槽；新增 vtable2 补 T+0x18（全 rstub 桩）；T+0x20 补合法堆指针
3. CB+0x10 弱计数 canary 777（引擎加减永不归零 → 永不触发析构释放）
4. 观察：VOICERING（gcw/cnd/v3 三点回读 rput 槽位记录）、GCW body dump（0x40）、
   cndOnComplete 入口崩点现场 dump（语音后 90s 窗口，含 this/第二层槽/0x30 body）
5. 验证：cmodtest 编译过、rendercheck 4.1.13/4.1.11 双版本过（4.1.11 无键不激活）

**判读指引**：再崩 → 看 `[VPDBG] cndOnComplete this=... [+18]=... body=...`：
body 头 8 字节 = vptr（0x13d680f00 族=我们的桩表；0x99cbd00 族=原生表=引擎重建体）；
[+18] 的值直接揭示垃圾来源。VOICERING 的 s200+ 段 = 引擎调过主虚表位桩。
若 16 槽/主虚表桩破坏上传流（rig 里 keys 不返回）→ 回退项=仅保留#1（每发新建）。

## 11. 2026-10-07 深夜：生产三轮试验 — 完成链崩已修，崩点推进至 worker 泵嵌套队列

**v3.9 部署与验证（18:10-18:14）**：rsync script.js → pkill WeChat → 看门狗全链恢复
（~2.5min）→ 本地 rig 先行一发回归通过（result=1、keys 全返回、零崩溃）。

**18:14 生产崩（第二层进展）**：
- **完成链 ldadd 崩确认修复**：GCW dispatch this=Treal 且 [+8]=我们 vtable、
  [+10]=Treal 自引用、[+18]=我们 CB —— 与原生布局同构，canary 吸收 ldadd，
  keys 照常返回。v3.9 每发新建探针起效（引擎原地重建/脏内存问题消失）。
- **VOICERING head=0 全程**：引擎**从不经我们 vtable 槽调用**（它用 bind 时捕获的
  原生函数指针直调，x0=我们的对象）→ 假 T 的字段内容才是决定性的，虚表内容几乎无关。
- **崩点 = worker 泵复活**：`0x248ab0c ← 0x42a1d98 ← 0x62c9ee0`，
  recursive_mutex::lock(0x40) SEGV —— [T+0x188]=null，accessor 0xdb84d8=P+0x40 字面加法。

**泵契约反汇编全解（本轮最重要的静态成果）**：
```
0x248aaac(T+0x180, x1, x2=need, x3=have):
  P = [T+0x188]; bl 0xdb84d8        // 字面 add x0,#0x40 → P+0x40
  bl 0x6d963ac                      // std::recursive_mutex::lock(P+0x40)  ← 18:14 崩点
  bl 0x62d0f9c                      // P+0x90 vs tick(0x6d97e4c)，不同→继续
  bl 0x62d11e4                      // 出队: lock(P+0x00)@0x6d9658c; node=[P+0x80]
                                    //   空(null)→0x62d12c0 干净退出
  空队列出口 0x248aef4: 0x62d0fd8(通知) + 0x6d963b8 unlock(P+0x40) → 返回
```
- **v3.4 时代假 P 崩因平反**：当年把 MUTX 魔数(0x4d555458)放在 P+0x40 当互斥量 ——
  pthread sig 必须是 0x32AAABA7 族 → lock EINVAL → std::system_error → terminate。
  "队列状态字段不满足"的旧假设不成立。
- **rig 不崩/生产崩的根源**（⚠ 2026-10-07 深夜修正：负载假设被推翻）——
  原假设「rig worker 无并发流量」**不成立**：rig 登录的 ludaohe 是用户主号，
  **比生产 bot 号更繁忙**（接入即大量订阅号/群消息）。忙号反而不触发泵。
  真差异待查，候选：①两端 dylib 构建不同（606e5e34 vs 74c5f6ac，已验证的
  14 个函数段一致但任务调度/重建策略区未验证）；②16:41 生产 GCW dispatch
  显示引擎**原地重建** Treal（rig v3.8 时代 binder 观察到的是新分配 freshT）——
  两端引擎走了不同代码路径；③生产 bot 的 CdnManager 历史任务状态累积更深。
  **结论不变且更强**：环境差异无法消除（同版本不同构建），根治 = 假对象
  满足最深消费路径（P2/P3 全嵌套队列补齐），使引擎走哪条分支都安全。
  教训入册：异步消费型伪造对象，本地验证≠生产验证，生产是唯一考场。

**v3.9.1（commit 778b4eb）**：buildVoiceProbe 新建空 P(0x100)，
pthread_mutex_init ×2（P+0x00 默认锁=出队路径；P+0x40 递归锁=Darwin type **2**，
非 Linux 的 1），P+0x80=0，写 [T+0x188]。

**18:28 生产崩（第三层进展）**：泵一通过（P+0x40 锁上、tick 检查、空表出队全走通），
**keys 返回 + cndOnComplete(V3) 完成**，崩点再后移：
```
__throw_system_error ← recursive_mutex::lock ← 0x42a32ac ← 0x42a317c ← 0x42a3140
  ← 0x62c9ee0(worker) — 线程21
```
- **0x42a3254 = 泵的克隆体**（同构：accessor+recursive lock+0x62d0f9c+0x62d11e4），
  但它操作**嵌套队列**：调用参数 x0 = **P+0x20**，读 `[(P+0x20)+8] = [P+0x28]`
  为下一个队列指针，锁 `[P+0x28]+0x40` —— 我们 P 里该槽为零 → 锁 0x40 → throw。
- 0x42a3140（调用者）先查 `[wrapper+0x10]`（=T+0x190）非空才调第二段泵；
  wrapper 是引擎重建的 freshT（+0x190 引擎自填非空），**T+0x190 是 we 无法经
  假 T 控制的开关**（第六轮已标注 +0x188/+0x190 = mutex/condvar/future 族）。

**下一步候选（按成本排序）**：
1. **P+0x28 补嵌套队列 P2**（P2+0x00 mutex、P2+0x40 recursive、P2+0x80=0，同 P 形态）。
   风险：0x42a3254 的 pop 走 wrapper=P+0x20，其 [+0x10]=[P+0x30] 可能再嵌套/再查字段
   —— 需先把 0x42a3254 剩余体（0x42a3330 之后）与 0x6d964c0/[T+0x190] 语义解完再动手。
2. **原生 ground truth 重采**：10-06 的原生 T[0x3F8]/P[0x100] dump 随 /tmp 轮转丢失
   （本地日志只余今日）。本地 rig 用户原生录一条语音重采 T+0x180..0x1a8 真值
   + P 体结构，按原生字节构造假 P（指针槽换自建）。
3. 若嵌套深度失控 → 回到 0x42a1d98（worker F）找"任务不需要泵"的豁免条件
   （原生旧路任务如何让 worker 跳过它）。

**生产当前状态**：v3.9.1 在跑，语音必崩（链推进到第三层），文本/图正常，
看门狗每次 ~2.5min 自动恢复。回滚开关不变：删 JSON tryMultiphaseAddr 键+重启。

## 12. 2026-10-07 深夜续：环境差异盘点 + 决定性对照实验（进行中）

**用户决断**：停止"崩一层修一层"的洋葱循环，先系统比对两端环境。盘点结果：

| 维度 | 本地 rig | 生产 mac-m1 | 状态 |
|---|---|---|---|
| 微信版本 | 4.1.13.63 | 4.1.13.63 | 同版 |
| wechat.dylib | md5 606e5e34 | md5 **74c5f6ac** | ⚠️ 同版不同构建；14 函数段字节一致但**数据段未比** |
| **FridaGadget.dylib** | md5 **9656f0f1** | md5 **f9983077** | ⚠️ **版本不同**——假T/CB/P全在 frida 堆，分配器差异直接影响引擎消费路径 |
| macOS | 15.6.1 Sequoia | **26.2 Tahoe** | ⚠️ libc++/dyld cache 不同（泵的 0x6d963ac 系统函数） |
| 账号 | ludaohe(主号,更忙) | bot | 负载假设已推翻(§11修正) |

**v3.9.2 生产第四层崩（21:31，P2/P3 补齐后仍崩）**：
`ilink_wrapper+0x4cfc → FridaGadget+0x59fcc`（KERN_INVALID_ADDRESS 0x0/0x1，
线程20）——**崩进 gadget 代码页**，第五种崩法（疑引擎把我们的函数指针当
线程回调/ilink 通知用）。VPDBG 日志零输出（崩得太早）。

**决定性实验①（进行中）**：本地 rig 的 FridaGadget.dylib 已替换为生产版
（f9983077，原件备份 /tmp/FridaGadget.local.bak）→ 重启微信登录 → 发语音：
- **本机复现崩溃** = gadget 版本差异实锤 → 修复 = 统一两端 gadget（把验证过的
  9656f0f1 推到生产），且本机从此可复现调试
- 不崩 → 继续实验②换生产 wechat.dylib（606e5e34→74c5f6ac）
- 再不崩 → 系统（Tahoe libc++）为唯一剩余变量

**rig v3.9.2 双发回归（21:24）**：probe#1/#2 每发新建生效、result=1×2、
零崩溃、binder 观察点开火（freshT=新分配 0x14cf6d060，与生产的"原地重建"不同）。
P2/P3 保活修复（严格模式声明+挂探针对象，78c85c0）后 rig 成功路径保持。

## 13. 2026-10-08 晨：v3.9.4 — 生产崩根拔除 🏁🏁

**用户决断**：跳过环境差异比较，直接攻生产 crash。

### 13.1 昨晚三份 .ips 重判（第四层崩是假象）

21:29/21:38 两份报告逐帧解读 = **第三层崩原样复发**，并非新崩法：
```
worker(0x62c9ee0) → 0x42a317c → 0x42a32ac → recursive_mutex::lock
  → __throw_system_error → __cxa_throw → terminate → abort
  → #1 FridaGadget+0x59fcc(frida 的 abort 处理) ← #0 ilink ForceCrashOnSigAbort(微信的)
```
两个信号处理器抢同一个 abort，.ips 抓的是战场残骸——"崩进 gadget 代码页"是表象。
（21:48 那份才是真·gadget 内部崩：gdbus 线程、登录同步期、与 voice 无关。）

### 13.2 反汇编 + 观察点实证（本轮两个决定性证据）

**反汇编**（生产 dylib 74c5f6ac）：
```
0x42a3138(W): [W+0x10]==0 → cbz 干净返回（原生非流式任务的天然豁免态）
              否则 Q=[W+8] → 0x42a3254(Q+0x20, W+0x18)
0x42a3254:    P2=[(Q+0x20)+8]=[Q+0x28]; lock(P2+0x40)   ← 崩点
worker 侧:    x0=[[ctx+0x118]+0x18], 虚调用 [x0的vtable+0x30] → 0x42a3138
```

**v3.9.3 观察点（07:04 那次崩）输出**：
```
st1pump W=T+0x180 ✓ Q=我们的P ✓ need/have 收敛 → 阶段1一直没问题是
st2disp W=0x9c71bd000（引擎 0x9c 只读闭包区对象，不是 T+0x180！）
        [W+8]=Treal  [W+0x10]=我们的CB
        → wrapper=Treal+0x20=T+0x18 → 队列=[T+0x20] → lock([T+0x20]+0x40)
```
**崩因一句话**：T+0x20 槽（v3.9 当"堆指针"补的 heapSlot 全零块）实际是
**阶段2嵌套队列指针**，引擎闭包 `{[+8]=Treal,[+10]=CB}` 直接拿它当队列锁 →
零块 sig 无效 → EINVAL → throw → abort。

### 13.3 v3.9.4 修复（一处对象 + 一处观察点）

1. `buildVoiceProbe`：T+0x20 改挂 **Q2 队列对象**（0x200、pthread init ×2、+0x80=0），
   heapSlot 退役
2. 0x42a3138 观察点改为匹配 Treal/CB（v3.9.3 按 P 匹配是错的——W 根本不含 P）；
   **绝不写 W**（0x9c 只读闭包区，铁律#1；且 [W+0x10]=CB 清零会破坏引用计数经济）

### 13.4 生产验证（2026-10-08 07:10，bot 号）

| 时刻 | 事件 |
|---|---|
| 07:10:52 | probe built(#1)，上传 result=0 |
| 07:10:53 | GCW/st1pump/cndOnComplete 全我们对象；st2disp mine=true；**st2 wrapper=T+0x18 [T+0x20]=Q2 生效** |
| 07:10:54 | send_voice → `{"status":"ok"}`，微信存活零崩溃 |
| 07:1x | voice#2 同物料重发 ok；text→ludaohe ok；image→ludaohe ok；全程零 .ips |

**意外发现**：`Q2+0x40sig=0x4d555458`（mars MUTX 标记）——引擎/泵把 Q2 的锁
**重打成自家 tag 锁**后才锁的；pthread init 的作用是让这块内存"非零可重打"。
另 07:10:07 一条原生任务走同分发器 `[W+8]=0 [W+10]=0` 干净跳过——空槽豁免态原生存在。

### 13.5 终局语义（生产语音链完整版）

```
force-legacy(TryMultiphase→0) → 旧路 CGI 直传 → keys 返回 → locator 命中
→ 完成分发链(GCW/cndOnComplete 走我们 16槽vtable+CB canary) 
→ worker 泵: 阶段1 [T+0x188]=P(空队列干净退出)
            阶段2 闭包W{[8]=Treal,[10]=CB} → wrapper=T+0x18 → 队列[T+0x20]=Q2 ✓
→ send_voice → 手机完整播放(待用户确认)
```

**遗留**：21:48 gdbus/gadget 内部崩（登录同步期偶发）另案观察；
本地 rig app 保持生产等价文件（原 dylib/gadget 备份在 `~/Prog/wechat-local-orig/`）。

## 15. 2026-10-08 午：音质战役终局 — 根因 = 生产无 pilk 静默回退 go-silk 🏁🏁🏁

**判决链（全部当天闭环）**：

| 实验 | 变量 | 结果 |
|---|---|---|
| 12:31 原生桌面 silk 字节 → 本地旧路管道 → bot | 字节来源 | **正常播放** → 管道/voiceurl/XML/下载道全无罪 |
| 12:35 V1/V2/V3（pilk 三种参数）→ 本地管道 → bot | pilk 参数 | **三条全部正常** → 编码参数也不是问题 |
| 12:39 go-silk 编码同素材 → 本地管道 → bot | **仅编码器** | **滋啦** ← 症状完美复现，铁案 |

**用户点破的分布规律**："本地发从来没问题，出问题的全是远端发的" —— 本地有 pilk（homebrew），
生产 mac-m1 只有 /usr/bin/python3（无 pilk）→ `encodeSilkExternal` 静默失败 → 回退 go-silk →
**go-silk 码流腾讯解码器不认** → Mac 滋啦全程 / 手机语音道永远等不到可解码数据转圈。

**为什么拖了两天**：所有 silk 验证都用 go-silk 解码 go-silk 产物 —— 自证清白永远绿。
教训：**验证器与被验物同源 = 假验证**。

**修复（2026-10-08 12:44 生产已部署验证）**：
1. mac-m1 `/opt/homebrew/bin/python3.11 -m pip install pilk`
2. `encodeSilkExternal`：候选解释器序列（python3 → /opt/homebrew/bin/python3 → python3.11）
   显式覆盖 launchd PATH；`pilk.encode(..., pcm_rate=16000, max_rate=16000, tencent=True)`
   （max_rate 补一致，旧调用 16k API 配默认 24k 内部带宽属非法组合）
3. go-silk 回退从静默改为 **Warn 大字告警**（"接收端会滋啦"）
4. 附带修复：silk 透传 voicelength=0 → SilkDurationMs 按块数估算（20ms/块）
5. 附带平反：mixNoiseFloor（10-06 加的微型帧噪声地板）确认**过度治疗**——原生 silk 本来
   就有 11B 微型静音块；保留无害，后续可摘

**生产验证 12:44**：bot→ludaohe 13.8s TTS 语音，pilk md5=29f7d7eb（新产物）、result=1、
回退告警 0 次、微信存活。（手机端最终验收：待用户确认）

**仍在册的附带发现**（不阻塞）：
- record 推送 2 字节 stub 在接收端 onebot 走 SilkToMp3 失败致整条转发中止（历史 64 次）
- 10-06 "微型帧断流" 结论作废（真根因当时已在别处）

### 旧 §14 标题存档

## 14. 2026-10-08 晨：音质战役 — 崩溃已终结，接收端播放全灭（进行中）

### 14.1 症状矩阵（用户耳朵实测）

| 端 | 症状 |
|---|---|
| 手机（ludaohe）播 bot→ludaohe 语音 | **动画一直转、完全无声**（= 截断时代原始症状） |
| 本机 Mac（ludaohe 登录）播同消息 | **滋啦滋啦噪音**（时长能撑满） |
| 早期 bot→filehelper（07:10） | 0.5s 噪音即停 |

**两个客户端、两种死法** → 指向消息/文件在 receiver 侧的解释错误，而非单纯文件问题。

### 14.2 已洗清的嫌疑（全部铁证）

| 环节 | 证据 |
|---|---|
| silk 编码器 | 同二进制同 wav；解码回来=纯净语音（动态范围 43、过零率 0.15）；四份各时代 silk 帧链全 OK（690 帧=13.8s 整） |
| 引擎入口字节 | `[VPDBG] legacy task` 观察：ptr/len/head/tail 全对（07:22/07:27 两轮） |
| CDN 文件内容 | **接收端 parasitic 解密**（Download 钩子截分片 + 消息 XML 里的 aesKey）→ 与发送 silk **前 26785 字节零差异**，尾部仅 15 字节 PKCS#7 补齐 |
| aesKey | 解密成功本身就是证明（错 key 解不出合法 silk 魔数） |
| 消息 XML 参数 | voiceformat="4"/voicelength=13814/length≈silkLen/aeskey/voiceurl 全对，与 rig 成功时代同构（voice_builder.go 自 fb716ff 未改） |
| 服务端校验 | 完成结构 md5Key == md5(我们的 silk)；+0x110 == silk 字节数 |

**接收端拿到的 voicemsg XML**（RX-XML 观察，07:47 轮）：
```xml
<msg><voicemsg endflag="1" cancelflag="0" forwardflag="0" voiceformat="4"
  voicelength="13814" length="26644" bufid="0" aeskey="..."
  voiceurl="7f0c0000..." voicemd5="" clientmsgid="..."
  fromusername="wxid_4erh8rirquu921" silklength="0" /></msg>
```
可疑空字段：`bufid="0"`、`voicemd5=""`、`silklength="0"`（rig 成功时代同为空——但见 14.3）。

### 14.3 关键认知修正：rig 时代从未验证过 receiver 侧

rig 全部成功回放 = **sender 自己 filehelper 里的副本**（ludaohe 多端同步，
手机播的是 sender 侧同步消息，可能走 sender 本地状态而非 receiver 下载链）。
bot→ludaohe = 首次真 receiver 侧回放 = 破。**旧路语音的 receiver 侧回放从未被证明过。**

### 14.4 排障工具链（本轮新增，本地 onebot-debug）

- `msg.go`：语音族 CDN(7f0c) 分片落盘 `/tmp/voice_rx.bin`
- `utils.go SaveAudioFile`：接收音频原始字节落盘 `/tmp/voice_rx_raw.bin`
- `worker.go record case`：RX-DBG（XML 提 aeskey→解密已捕获分片→md5 对比）+ RX-XML（全 XML dump）
- `silktest/decode`：silk→wav+语音/噪音统计判定（RMS 动态范围/过零率）
- 生产 script.js v3.9.5：0x58c3b44 入口字节核对观察点

### 14.5 下一步

1. **取原生 receiver 侧 voicemsg XML**（ludaohe 收到任意真人语音 → RX-XML hook 自动抓）
   → 与我们的逐字段 diff（重点：bufid/voicemd5/silklength/endflag/clientmsgid 结构）
2. 按 diff 修 BuildVoiceMsgProto 或上传 task 字段 → 生产复测
3. 副线：本机 GUI 点播 bot 语音（Mac 与手机症状已由用户分别确认，此步可跳过）
4. 用户听 07:26 本地发 filehelper 那条（sender 侧回放验证，区分 sender/receiver 路径假设）

### 14.6 2026-10-08 午间：原生样本三连 + 下载道分离实锤（进行中）

**样本链（今日全部拿到 XML+钥匙）**：

| 样本 | 路径 | voicelength | voiceurl 类型字 | 状态 |
|---|---|---|---|---|
| 我们 07:46 | bot→ludaohe 旧路 CGI | 13814ms | **7f0c0000** | Mac 滋啦 / 手机转圈 |
| 原生#1 08:41 | ludaohe 手机→bot | 6780ms | 7f0c0004 | **发送失败⚠️**（bot 当时离线，未送达，气泡点不播） |
| 原生#2 11:39 | ludaohe 手机→bot 重发 | 6860ms | **7f0c0006** | 已送达 bot（生产日志实锤），但未同步到本地 Mac |
| 原生#3 12:13 | **bot 桌面录制→ludaohe** | 7840ms | **7f0c0004** | **本地 Mac 正常播放 ✓**（用户耳测） |

**字段级排除（原生#3 vs 我们，桌面对桌面最干净）**：
- TLV 字段 `0a`：01=手机端 / **02=桌面端**（原生#3 与我们同为 02）→ 平台标记，与故障无关
- clientmsgid：桌面原生 = `ASCII前缀+UUID`，与我们**同格式** → 无嫌疑
- bufid="0" / voicemd5="" / silklength="0"：原生同样为空 → 无嫌疑
- **唯一持续显著差异：voiceurl[2:4] —— 我们恒 0000（旧路 CGI），原生恒 0003/0004/0006（multiphase 族）**

**下载道分离实锤（本轮最重要发现）**：
- 我们 07:46 的 0000 blob：**push 同秒自动下载**（07:46:21 分片即达，非点击触发），走的是
  CdnManager 通用道（downloadFileAddr 钩子捕获）→ 客户端"拿到了完整密文"却仍播放失败
- 原生#3 12:13 的 0004 blob：用户点播正常，但**通用道钩子零分片** → 走语音专用下载道
  （script.js 只挂了 image/file/video 三条回调，语音道是第四条未挂）
- **推论**：4.1.13 客户端语音播放的消费路径按 voiceurl 族选择；旧路 0000 blob 被通用道
  自动拉取后，播放器不读它 → Mac 按 voicelength 生成噪声填充(滋啦全程)、手机语音道
  永远等不到数据(转圈)。文件/密钥/XML 全对但播放器根本不消费 = 与 §14.2 全部铁证相容。

**Mac 静态噪声的残余竞争假设**：(B) silk 码流变体不兼容（原生可能 24kHz，我们 pilk 16kHz）
—— 尚未排除。**判决实验进行中**：用户在本地录原生语音 → 抓桌面原生 silk 临时文件 →
把**原生字节**灌进生产 bot 旧路管道重发 ludaohe：
- 原生字节也滋啦 → (A) 管道判死刑（旧路对 4.1.13 接收端不可修，需换上传路）
- 原生字节正常 → (B) 编码器参数问题（改 24kHz 编码即可，便宜得多）

### 14.7 原生桌面 silk 抓取成功 + 判决实验发出（12:29-12:31）

**工具**：UPSTRUCTDBG 观察点扩展（uploadImageAddr 入口对 native voice 任务读 0x100/0x108
silk 缓冲全量 hex 回传 Go 落盘 /tmp/voicecmp/native_desktop_*.silk）—— 10-06 已证原生语音
同样走内存缓冲式，观察点只读零行为改动。

**结构对比（原生桌面 7.9s/13049B vs 我们 13.8s/26785B）**：

| 维度 | 原生桌面 | 我们(pilk+噪声地板) |
|---|---|---|
| magic | 02 #!SILK_V3 ✓ | 同 |
| 块结构 | 393 块×20ms 整 ✓ | 690 块×20ms 整 ✓ |
| 码率 | 13.3 kbps | 15.5 kbps |
| **微型静音块(<20B)** | **48 个，min 11B** | **0 个（噪声地板抬到 ≥24B）** |

→ **原生 silk 本来就带微型静音块**。10-06 "微型帧致 CDN 断流" 的结论被推翻
（真根因是后来的 fileId/alita 归属 + T+0x20 队列对象），mixNoiseFloor 属于过度治疗
（无害但无必要）。两族结构同源，无天然格式不兼容迹象。

**判决实验（12:31 发出）**：对抓到的原生 silk 做单字节异变（防 CDN 秒传返回原生族 URL，
异变点=首个 18B 静音微块 payload 尾字节，结构/听感不变，go-silk 解码验证纯净语音）
→ 本地 rig 旧路管道发 bot（voicelength=7860，SilkDurationMs 修复首次实战）→
result=1 + 服务端 ack。等用户在远端 Mac 播放判决。

**附带发现**：record 推送 2 字节 stub（08 00）在生产 onebot 走 SilkToMp3 失败
（"not a silk" 64 次历史）导致整条转发中止 —— 转发健壮性 bug 另案待修
（stub 应跳过转换直接转发）。

**若 (A) 成立的候选路线**：
1. 虚拟麦克风方案（BlackHole + GUI 按住录音）：客户端全程原生，无协议伪造
2. 直连 multiphase CGI（upload_init/part/finish 经 SubmitCgi，仿 send_file_simple 模式）
3. 维持 record→file 降级（现状保底）

**排障工具链补充**：日志 grep 注意结构化日志键值间有 ANSI 色码（`cdn_url=` 后跟 `\x1b[0m`），
`grep "cdn_url=7f0c"` 永远不命中，要 grep 裸值；`/tmp/voicecmp/silkstat.py` 块结构分析。
