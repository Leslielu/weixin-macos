# 4.1.13 语音上传 >3600B 截断问题 — 完整调查记录（2026-10-06，未结案）

## 问题现象

onebot 发语音（CDN 上传路径）在微信 4.1.13.63 上：
- **≤3600B silk（约 1.5 秒）：完全正常**（气泡/时长/音质全对）
- **>3600B：接收端只播前 ~1.5 秒**（音频在 3600 字节处截断）
- 部分组合下更差：完全无声、播放动画永远空转（连开始都不开始）
- 上传侧全程"成功"：result=0、完成回调钥匙齐全、发送 result=1

生产兜底：**wxgate 已降级 record→file**（`transportRecordAsFile`，接收方拿可播放的音频附件）。

## 已排除（全部实证，别再查）

| 环节 | 排除依据 |
|---|---|
| SILK 编码器（go-silk / pilk） | 两者输出帧结构逐帧一致；pilk 交叉解码往返完好；帧头 VAD/LBRR 位全同 |
| Go→JS hex 传输（frida RPC） | VOICEDBG 实测 hexLen 分毫不差（54920=2×27460） |
| 消息 proto（voice_msg） | 气泡时长正确（Duration 语义对）；key 格式正确 |
| key 读取/完成结构定位 | 与真实收到语音的 voiceurl（`7f0c...`）同族同格式；v3 偏移全命中 |
| CDN key 类型隔离 | 伪装 img 类型上传的对象接收端完全播放不了（key 按类型强绑定） |
| 分块账本 fileId 格式 | **已修**：必须 `alita_1_<32hex>_15_0_<递增序号>`，32hex=**md5(发送者自己的wxid)**（三次原生录音恒等 md5(wxid_4erh8rirquu921)；用错会导致 0.5-2s 不稳定截断——此修复已入库，是必要非充分条件） |
| 上传结构模板 | **已对齐原生**（见下"原生校准成果"），逐字节 diff 仅剩指针/长度类值差 |
| ffmpeg / PCM | mac-m1 与开发机 PCM 电平一致（volumedetect 双向验证） |
| 微型 silk 帧理论 | 数字静音产生 11-12B 帧；混 -52dB 底噪后全部 ≥21B，但 3600 截断依旧（底噪修复保留在代码里，可能仍有二阶价值） |

## 原生校准成果（已入库，61104c9 及后续）

通过让真人在**桌面微信录语音** + `UPSTRUCTDBG tag=native` 钩子 dump 原生上传任务结构，对照修正：

- fileId：`alita_1_<md5(自己wxid)>_15_0_<seq>`（JS 递增计数器 voiceUploadSeq）
- payload 模板（BuildVoiceUploadPayload）延伸到 0x2A0：[0x7F]=receiver字节长度(动态)、
  [0x1BC]=01、[0x1D8]=01、[0x1E1]=01、[0x262]=01、[0x266]=01
- 0x110 容量=len 向上取整16 | 高位
- `v3LocateCndOffsets`：alita id 不含 receiver，定位校验走 `tgt 非空` 特判（否则发送 91s 超时）
- 原生 0x298 槽有恒定值 `0035d72a01000003`（疑堆尾/带指针，未复制——剩余唯一静态差异）

## 核心未解之谜：数据回调上限

上传任务结构 0x0/0x8 槽是**数据供给回调**。实验矩阵（5 秒 bee = ~11KB silk 作基准）：

| 回调对 | 来源 | 结果 |
|---|---|---|
| uploadFunc1/2（图片回调） | 图片上传 hook 捕获的静态函数 | **3600B 截断**（≈1.5s）。注意：图片用同一对回调+路径槽可传 100KB+，**图片任务从来没坏过** |
| 原生语音回调对 | 原生 dump：会话内恒为 `0x819a75420`/`0x819a75400`（0x8_1xxxxxxx mmap 区，模块未定） | **~1200B 截断**（≈0.5s，更短！） |
| （原生自己） | 同一对回调 | 8.5KB/12.5KB 全量上传成功 |

结论：**回调从任务注册态/闭包上下文取数据，纯伪造任务喂不饱**。我们伪造的结构字节全对，
但 WeChat 内部有任务注册表（或回调闭包）持有真正的数据源，natives 注册过、我们没有。

## 全部实验轮次（按时间）

1. **内存式·原始模板**（receiver_ts_rand_1 id）：≤4.5K 好、大文件截 2s/无声（不稳定）
2. **文件式·img模板+0x9C=0x0F**：TTS 无声（此实验早于 alita 修正，id/模板都错，不能否定文件式本身）
3. **img 类型伪装**（0x9C=01）：接收端死转圈——CDN key 按类型隔离，死路
4. **alita id·内容md5**（每次变）：0.5s
5. **alita id·账号md5 + 模板补齐**：截断稳定为 3600B≈1.5s（重要基线）
6. **0xD8 动态长度**（模板恒 3600/1800 → 写实际 silkLen）：仍 1.5s
7. **原生回调对硬编码**：0.5s（更短）
8. **混合式**（语音类型+alita+全字段+路径槽+图片回调，triggerUploadVoiceFile2）：**死转圈**（比截断更糟——路径数据源与语音类型组合被 CDN 拒绝）
9. **底噪修复**（mixNoiseFloor σ80）：不解决 3600 截断（保留，静音帧 ≥21B）

## 后续线索（按性价比排序）

1. **反汇编原生回调对**：`0x819a75400/0x819a75420`（12:25 启动的微信会话内稳定；钩子已在
   attachUploadStructDbg 里自动刷新+记录模块）。看它从 x1 的哪些偏移/哪个全局注册表取数据
   → 照着伪造注册表项。工具：frida Instruction.parse dump + 模块基址换算。
2. **原生录音全链路追踪**：在原生录语音时 hook 更大范围（CdnManager 周边所有调用），
   找 startUploadMedia **之前**的"任务注册"调用（natives 必有一步把数据挂进注册表）。
3. **短链 CGI 路线**：移动端协议（wechatpad 系）语音走 `senddata` CGI type=15 分片直传，
   完全绕开 CdnManager——工作量大但是正路。
4. **对照 Windows 微信 4.x**：桌面端语音协议同源，若有 Windows 抓包条件可交叉验证注册表机制。
5. 0x298 槽恒定值 `0035d72a01000003` 的含义（低 4 字节疑指针——谨慎，伪造可能崩微信）。

## 生产状态（2026-10-06 21:40）

- wxgate：**record→file 降级已部署并入库**（接收方拿音频附件，永远可播）
- onebot：线上二进制 = 混合式实验（triggerUploadVoiceFile2，死转圈版）+ 底噪修复；
  wxgate 降级后无生产流量走语音路径，属休眠状态。回滚到"3600 截断版"无意义，等结案一并清理
- 诊断钩子常驻：UPSTRUCTDBG（上传结构 ours+native 双抓，native 语音自动刷新回调对）、
  VOICEDUMP（完成结构）、/download_cdn（CDN 对象拉回，目前仅图片 key 可用）
- 微信 Mac 4.1.13 **桌面版能录语音**——这是本次最大的方法论收获：任何时候需要原生参照，
  让真人录一条（静音都行），钩子自动抓全量结构

---

## 2026-10-07 第二轮：本地实验台大战果（语音截断根因大幅收窄）

### 环境勘误（重要，推翻旧假设）

- **本地 app 实为 4.1.13 build 269631**（Info.plist），与生产同版本——但 dylib md5 与生产**不同**
  （本地 345MB fat dylib `606e5e34…`，mac-m1 `74c5f6ac…` 344MB）。version_bin 两个 168MB 文件
  都不是运行镜像。**"本地=269628"是旧误判**；candidate-269628.json 全部地址对本地无效。
- 生产 `4_1_13_63_mac.json` 的偏移在本地**字节级验证可用**（GetService 0x5594330 序言吻合、
  getter/startDownloadMedia 同）。上传入口 0x575bf3c 是**分支岛**（`ldr x16,[pc,#8]; br x16`），
  岛链第二级再跳，真函数在 dylib 外的匿名区（会话 A: 0x102e94000）。
- 服务定位器三跳（GetService→getter→[ctx+0x40]）本地走通，mgr 与**原生下载**的 x0 完全一致；
  但**原生语音上传的 x0=0x1**（不是 CdnManager）——上传入口第一参是标志/别的语义。

### 引擎内部任务布局（生产 VOICEDUMP 破译，与提交任务的布局不同）

引擎会重建任务：alita id 在 0x28、receiver 在 0x48、cdnKey(204B)@0x68、aesKey@0x80、
md5Key@0x98/0xb0/0xc8（引擎回填）、silk 总长@0x110。提交侧 id@0x48/receiver@0x68 只是入口格式。

### 关键实验结论（本地）

1. **生产模板/补丁/克隆任务/原生 desc 对/微信线程发起点——合成调用全部 AV 在 [0xa]**；
   甚至**用刚注册好的原生任务指针在 onEnter 里重放也 AV**，而紧接着的原生调用本身成功。
   ⇒ 缺的不是任务字节、不是 desc、不是线程，是**调用者上下文**（x2-x5 隐藏参数或栈帧链）。
2. **原生调用的扩展寄存器（2026-10-07 10:51 捕获）**：`x0=1, x1=task, x2=0x13fd54000(页对齐),
   x3=0x31453da30(堆), x4=0, x5=<wechat.dylib内址>, lr=dylib+0x575bf34`。
   **x2/x3 是会话句柄头号候选**——我们 2 参签名调用时它们是垃圾 → 引擎空解引用：
   本地构建硬崩 [0xa]，mac-m1 构建降级成"单发 3600B"——**这正是截断的最强统一解释**。
3. 原生 desc 对 = 0x15753c820/0x15753c800 家族（会话内 9h 稳定，d8 即 CndOnComplete 的 x0 对象）。
   但文档第 7 轮"原生回调对"实验证明 desc 正确≠修复（1200B 更短）——desc 是果不是因。
4. 0xD8=(3600,1800) 在原生任意长度任务里恒定 → 不是字节上限；动态 0xD8 也无效（第 6 轮）。
5. mac-m1 完成回调里 done=total=全量（引擎自认为传完）但 CDN 对象实测 3600B（历史接收端
   量测）——完成回调不可信；**hybrid（线上部署版）实测死转圈**（接收端反复重试下载，2026-10-07
   07:56 实测确认）。
6. GetService 在**登录未完成**时从 frida 线程调用会死锁/毒化 gadget（本地两次事故）；
   生产脚本的登录门禁注释是真警告。

### 教训（本地实验台）

- 岛上 hook 的 onLeave 永不触发（尾跳无返回）；要 onLeave 须挂真函数。
- 对正在执行的流程做"扫函数头自动挂 hook"会崩微信（帧函数盲挂事故）。
- 反复 pkill 带 hook 的 rig 会毒化 gadget（假死）；重启微信+重新登录才能恢复。
- 本地会话的捕获已持久化 `/tmp/native_task_capture.json`（任务模板+alita+desc 对）。

### 下一步（按性价比）

1. **x2/x3 会话参数验证（零风险，纯被动）**：rig 只加日志，用户自然录音 2-3 条，
   看 x2/x3 稳定性/与 ctx 或 holder 的关系。稳定后→ mac-m1 上用 6 参签名重试上传
   （mac-m1 构建不 AV，最坏就是再截断，**无崩溃风险**）。
2. x2 若是录音缓冲 mmap：找它的分配点（录音开始时 mmap——hook mmap/大页分配即可定位），
   伪造一个内容指向我们 silk 的等价缓冲。
3. 短链 CGI senddata type=15 分片直传（文档前述线索3，工作量大但是正路）。

### 2026-10-07 终章：本地五次崩溃全部溯因——config 地址是函数中段

- **本地 partial JSON 的 uploadImageAddr=0x575bf3c 是错的**：本地 fat dylib 里该地址是
  `start c2cupload` 真函数（入口 **0x575bef4**，序言 `stp x28,x27,[sp,#-0x50]!`）的 **+0x48 中段**。
  之前一切"能跑"全靠 frida hook 自写的中段蹦床兜底；合成调用无序言进入 → x19/x20 垃圾
  → [0xa]/[0xe] AV；所谓"岛链/x2/x3 隐藏参数/x0=1"全部是中段伪象（真入口首指令即读
  [x19+8]，x0 必须=CdnManager——与生产完全一致）。已修正 JSON 为 0x575bef4。
- 顺带发现 mac-m1 生产 0x575c75c 在其 dylib 里是**真函数入口**（干净序言）——生产地址没错，
  **生产截断与地址无关**，根因仍回到"任务注册态/回调闭包"（文档开头结论维持）。
- 真入口干净调用（零描述符任务）本地实测：**返回 rv=0 后引擎异步段崩溃**（后台线程消化
  零 desc 任务时）——与生产"完成但只发 3600B"同源（desc/注册缺失，本地构建崩、mac-m1 降级）。
- **教训追加**：本地 partial JSON 从未与运行镜像做过入口序言校验；以后任何版本 JSON 落地
  前必须校验目标地址指令是函数序言（stp x29/x28/pacibsp 之一）。

### 修复路线终评（2026-10-07）

1. 生产现状（wxgate record→file 降级）可用、稳定——继续保底。
2. CDN 语音全量上传的根治仍需"注册态复刻"（真入口反汇编 0x575bef4 起的 c2c 流程 +
   desc 对闭包来源）或移动端 senddata CGI 直传——均为大工程，单开战役。
3. 本地实验台已就绪且校准（真入口+安全版 rig+持久化捕获），下一战役可直接开工。

---

## 2026-10-07 第三轮：闭包池机制全面破译（一次崩溃换来）

### 崩溃事故与教训

- 本地 rig 抓原生录音回调对时，给槽指向的裸 mmap 区挂了 Interceptor → frida 把该页
  mprotect 成 r-x → 引擎 copy/binder `0x31df8ac` 对控制块 +8 做原子引用计数
  `ldadd #1,[x8]` → **SIGBUS 写保护**（WeChat-2026-10-07-131329.ips，崩溃帧
  0x31df8d4 ← 0x575c1d0 = start_c2c_upload 内 `bl 0x31df8ac` 返回址）。
- **铁律追加：引擎的 mmap veneer/闭包池只可读不可 hook**——它是运行时数据+代码混合页，
  每任务由 0x31df8ac 重写（引用计数、闭包字段、veneer 跳板）。
  旧文档"岛链/x0=1/x2/x3 伪象"的终极解释：那些实验 hook 的就是这个池子。
- hook 前后 dump 的"veneer 字节"(adrp x16+br x16) 实为 **frida 自己的 inline 跳板**，
  不是引擎数据——对照 dump 时序可识别。

### 机制定论（全部静态实证，本地 arm64 slice 379af337 + capstone）

1. **task+0x0/+0x8 = std::shared_ptr<回调接口>{T*, 控制块*}**：
   - 控制块 = {析构虚表@0x9962540(文件态 chained-fixup 编码，运行时解析), 引用计数@+8,
     字段=7@+0x10, destroying-deleter fn@+0x18(0x99CB18)}；
   - `0x31df8ac` = task copy 构造：拷 {T*,cb*} 后 `ldadd #1,[cb+8]`；
   - `0x570a0e8` 区 = shared_ptr 调用器：`x3->0x40` 取 T → 调 `vt+0x10(T,x1,x2,x3)`，
     用完 `ldaddal -1,[cb+8]`，归零调析构虚槽（→0x37afef4→[x0+0x18]→0x99CB18）。
2. **T 的二级基类虚表 @0x99CBD00**（offset-to-top=-8，多继承 thunk `sub x0,#8`）：
   vt+0x10=`0x429e890`→0x429e4fc (GetCallbackWrapper)、vt+0x30=`0x429fa14`→**0x429eff4
   (cndOnComplete 本尊)**、vt+0x18→0x429ec3c、vt+0x20→0x42a01b8、vt+0x28→0x429ffd0、
   vt+0x38→0x429e898、vt+0x40→0x429fa1c、vt+0x48=ret。
   **upstream 的 fake uploadCallback(Memory.alloc(128)) 就是此接口的残缺复刻**
   （只填 +0x10/+0x30 两槽；img/video 靠路径槽喂数据够用；语音没有路径槽——原生语音任务
   0xe8/0x118/0x148 全零——数据必须从接口闭包链流出，缺槽=3600B 截断的最强候选根因）。
3. T+0x10 里还有**第二层 shared_ptr**（真录音会话闭包）；GetCallbackWrapper(0x429e4fc)
   对它 ++计数后包装。录音会话对象经此链挂进 CDN 任务。
4. **上传协议 = mars::cdn c2c multiphase**（cdn_core.cc / upload_embed_delegate.cc /
   multiphase_upload_task.h）：`c2c/upload_init` → `c2c/upload_part`(小片
   `upload_part/small_fragment`) → `c2c/upload_part/finish` → `c2c/upload_complete`，
   HTTP/Cronet 传输（非 CGI 短链）；`TryMultiphase`(appconfig.cc 0x574c0c4) 读
   task+0x44 (apptype) 定路，模板 0x40/0x44={1,1} 与原生一致 → 我们已在 multiphase 路。
   `cdntask %_ must serial upload.` = 分片串行约束。
5. 入口双函数：本地 0x575bef4=`start_c2c_upload`(包装器: 校验路径/类型+图片25MB限制+
   0x178向量非空时清空路径槽) → 尾调 0x575c75c=`_startUploadMedia`(=生产 uploadImageAddr)。
6. 本地 partial JSON 无法渲染模板（13 处 <no value>）；本地 rig JSON = 生产
   4_1_13_63_mac.json + uploadImageAddr→0x575bef4，全部键已在本地 slice 序言校验
   （candidate-269628 全灭，生产函数头全过：req2bufEnter/onPush/autoBufferWrite/
   cndOnComplete/startDownloadMedia/uploadImageAddr(=0x575c75c 本地是内层，也是函数头)）。

### 下一步（rigcapture v2 已备好 /tmp/onebot-run/script.js，渲染+语法过）

- 会话流程：重启微信(rig app)+登录 → 挂 rig → 用户录 ≥10s 原生语音一条。
- v2 三路观察（零池子接触）：A) 0x31df8ac onLeave 重读新鲜 {T*,cb*} 并只读 dump
  T[0x60]/CB[0x28]；B) hook 静态虚表成员 6 个（0x429e4fc/0x429e898/0x429ec3c/
  0x42a01b8/0x429ffd0/0x429fa1c），x0==freshT 时记 x0-x3+rv+bt；C) cndOnComplete 沿用生产 hook。
- 拿到数据拉取虚槽签名后：frida Memory.alloc 自建 T 对象（自建 vtable=CModule
  函数指针，铁律4）服务自己的 silk 缓冲 → 合成任务全量上传。

---

## 2026-10-07 第四轮：probe 实战（对象被引擎真实消费，到同步原语处止步）

### probe 设计与预验证

- `onebot/rigcapture.js` v3：CModule probe 数据源对象（12→10 槽 vtable 全部接环形日志
  stub + serve 契约 A/B 模式位），接管 `triggerUploadVoice`（worker.go 同步改为传 silk hex
  的内存式签名）。会话内参数控制 = JS 每次发送前读 /tmp/rig_probe_cmd.json。
- `onebot/cmodtest/main.go`：本地 CModule 编译验证器（frida spawn /tmp/dummy_target，
  从 rigcapture.js 实时提取 C 源）。**验证结果：C 编译过、serve 拷贝语义正确
  （rv=16/writtenLen=16/dst 内容逐字节正确）、ring 记账正常、rdtor 析构自证正常**。
  教训：frida CModule(TCC 系)不认 `__sync_fetch_and_add`（implicit declaration）；本地
  frida-go 运行时对 'uint64' 参数严格（NativeFunction 传指针需声明 'pointer'）——但引擎
  原生调用不走 JS 编组，无影响。

### probe 会话战果（2026-10-07 14:14，崩前 20 秒抓全）

1. 引擎**真实消费**了假 pair：binder(0x31df8ac) 拷贝 {T=0x14edd9748, CB=0x14edc2410}，
   startUploadMedia rv=0。
2. **GetCallbackWrapper(vt+0x10) 被调且成功**：经 0x570a0e8 慢路径 → 对象 vtable 分发 →
   原生 0x429e4fc(this=T-8) 读 [T+8]/[T+0x10]（自引用结构仿对了）→ **返回我们的 CB**
   （rv=0x14edc2410）。参数 x3=0x4bd0=ceil16(silkLen)=19408 —— 引擎已按我们 silk 的
   总长规划分片。
3. 崩因（WeChat-2026-10-07-141424.ips，SIGSEGV→abort 链）：上传 worker 线程
   （#16 0x62c9ee0）→ F 函数（0x42a1d60 区域）→ `0x248aaac(T+0x188, ...)` → 对
   **T+0x190 的同步原语**操作失败 → `std::__throw_system_error` → 无捕获 → terminate。
   0x6d963ac = __cxa_throw PLT；0xdb84d8 = 原语 getter。
4. **定性**：task+0x0 指向的不是普通接口对象，而是**录音会话的上传侧状态机**
   （原生对象 0x3F8 字节，dtor 常量 0x3f8 实证；+0x188/+0x190 = mutex/condvar/future 族）。
   只仿 vtable+指针不够，需复刻同步状态机 = Route A 的正体。

### 本轮新增结构知识

- 元素 T 的 vtable 实有 **12 槽**（0x99CBD00，+0x50..+0x78 =
  0x42a1264/0x42a0c84/0x42a1270/0x42a1278/0x42a1820/0x42a1824）。
- **wrapper 类**：{vptr=0x99CBF88, T@+8, CB@+0x10}（引用计数在 cb+0x10，见 0x42a1c40
  区域的构造代码）；F 的 x20 即此 wrapper；x2/x3 取自 wrapper+0x30/0x38。
- F 函数体 0x42a1d60 区域：`0x248aaac(T+0x188, wrapper+0x18, [wrapper+0x30], [wrapper+0x38])`。
- 原生 T[0x60] 布局（第二会话新鲜值）：{vt=0x99CBD00, T-8, CB, vt2=0x99CBE08, 堆ptr,
  0x32aaaba7 常量}；CB={析构vt=0x9962540, refcount, counter, deleter=0x99CBC18, T*}。
  deleter 0x99CBC18（此前文档笔误 0x99CB18）。
- 类名混淆：typeinfo name = '_661ed966'（哈希后缀，无语义）。
- rig 启动参数坑：缺 `-wechat_id` → selfIdMd5=md5("")=d41d8cd9...（probe fileId 错误但不致命）；
  缺 `-image_path` → 图片保存相对路径 → 微信进程找不到文件 → 上传入口返回 -16355
  (0xFFFFBFDD)（**生产配了此参数不受影响**； rig 补 -image_path=/tmp/onebot-run/img/）。

### 下一战役的三条路（按今日地图重估）

1. **会话状态机复刻**（原 Route A 的精确化）：从 F 全函数读出 T 的全部字段消费点
   （+0x188/+0x190 之后还有多少未知），找到状态机构造器（可循 typeinfo/vtable 邻接
   或 F 的调用链反推），在 JS 侧构造 0x3F8 布局：vtable 换 ours、同步原语用合法
   零值（libc++ 无锁态 mutex/condvar = 全零）、数据指针指我们的 silk。地图已细到
   字段级，但仍是多会话工程。
2. **small_fragment 单分片路径**：URI 全局构造于 0xa00d3b8（init 段 0x574f950），
   找它的消费者即"整文件单分片"的阈值判定；若阈值来自 clicfg 本地默认值，一次
   Memory 写入（非 hook）即可让语音全量走单分片 —— **绕过流式状态机，性价比最高**。
3. 生产维持 C（record→file 降级），不受本战役影响。

### 今日会话消耗

4 次 rig 会话（1 次池子 hook SIGBUS、1 次原生录音捕获、1 次编译失败、1 次 probe）。
probe 会话崩于同步原语缺失，属预期内迭代代价。cmodtest 已能把 C 编译问题挡在
会话外，后续迭代不再浪费会话在编译错误上。
