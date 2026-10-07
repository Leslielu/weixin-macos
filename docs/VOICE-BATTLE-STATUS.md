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
