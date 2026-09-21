
# 微信 macOS 版本升级适配

上游 WeChat 4.x 真身在 `WeChat.app/Contents/Resources/wechat.dylib`(~150MB arm64),
`MacOS/WeChat` 只是 182K stub。`wechat_version/*.json` 里的地址 = arm64 切片 vmaddr 偏移(从 0 起)。
本项目所有 hook 都基于这些偏移 + 运行时模块基址。

## 文档结构(谁放什么)

| 文档 | 角色 |
|---|---|
| **本文** | 总方法论: 流程/工具用法/跨版本方法/铁律 + 各版存档索引 |
| `docs/4.1.12-adaptation.md` | 4.1.12 细档: 实战全貌(难键攻略/漂移清单/适配期崩溃/验收) |
| `docs/4.1.13-submitcgi-analysis.md` | 4.1.13 细档: 身份换位定案/V3 范式/蹦床铁律/媒体战报 |
| `docs/crash-history.md` | 崩溃档案: 历次崩溃指纹/根因/修复, 排查先读 |
| `.claude/skills/.../SKILL.md` | skill 速查入口(本地, .gitignore 不入库), 指向本文 |

**新版本适配完成时**: 产细档 `docs/4_1_XX_adaptation.md`(或范式级变化时
如 `-submitcgi-analysis.md` 命名), 本文存档节写摘要+指向, crash-history 补
新崩溃指纹, SKILL.md 吸收新铁律。

**涉及生产**: mac-m1 跑着 4.1.11.53 + 看门狗, 任何本地实验不得碰它;
本地实验机用 frida gadget 模式(127.0.0.1:27042, 会话数 ~3 上限)。

## 总流程(每级小步跳版)

```
0. 切片: lipo -thin arm64 wechat.dylib -output version_bin/wechat-<版本>-arm64.dylib
1. addrfind 全量跑(签名+组内delta): 80% 键直接出来
2. string_anchor find-json 补签名失配键(下载三件套等)
3. uploadOnCompleteAddr 类: hexfind 结构匹配
4. 每个候选 callscan 目视确认语义(寄存器/mov+bl 对)
5. 本地 4.1.12 gadget + onebot 全链路验证(见下) —— 用户验收
6. 验收通过才产正式 JSON 提交, 再跳下一版
```

小步跳版(4.1.11→4.1.12→4.1.13)是用户定的策略: 签名匹配率高, 避免 IDA。

## 工具

- `tools/addrfind/addrfind.py 旧.dylib 旧.json 新.dylib -o out.json` — 主力,
  签名搜索+组内 delta。组锚定见其 README(req2buf 组锚 req2bufEnterAddr, upload 组锚 uploadImageAddr)。
- `tools/addrfind/string_anchor.py` — addrfind 失配时的补强(见下"字符串锚定法")
- `tools/addrfind/verify_group.py` — capstone 助记符比对回归
- venv: `~/.venvs/wechat-re/bin/python3`(capstone+frida, 无 numpy)
- 切片库: `version_bin/`(4.1.10/11/12/13)

## 字符串锚定法(2026-09-20 实战结晶)

**适用**: 函数体被重构导致指令签名失配 —— 典型是 mars CDN 下载三件套
(downloadFileAddr/downloadVideoAddr/downloadImagAddr, 4.1.11→4.1.12 addrfind 全灭)。

**原理**: 编译器烧进 __TEXT 的字符串跨版本不变:
- 构建路径 `/Users/bkdevops/.wconan2/mmnet/<hash>/.../c2c_download_task.cc`
  (注意: <hash> 构建目录每次变, 路径串本体跨版本失配, 别当锚)
- 日志格式串 `cdntask %_ write last padding %_ bytes.`
- 方法名 `OnRecvedData` / 断言文本 / base64 表

老版本目标块周边必有 `adrp+add` 引用; 同串在新版本定位后扫引用点,
按「引用点 + 老版本相对偏移」推目标位置, 锚间一致性评分。

**算法要点(string_anchor.py locate 已实现, 踩过的坑)**:
- 种子只用稀有串(全库字节出现 ≤8 次); 热门串(mars::cdn/base64表)引用上千,
  全局引用表必然截断 → 4.1.12 实测 mars::cdn 有 200+ 引用, cap 永远轮不到真值点
- 串在 __cstring **任意对齐**, 别做 %4 检查(曾把 video 的锚全跳光)
- 每个旧拷贝×每个引用点都是独立种子(拷贝错位 → 预测平移)
- 验证用「预测位置局部窗口反汇编」看加载串内容是否吻合, 不建全局引用表
- 簇评分 = Σ 不同锚各自最高分(跨锚互证累加)

**产出语义**: 定位到函数/代码块级; 最终 hook 点必须 `callscan` 目视确认。
4.1.12 实测: file/video 精确到指令, imag 只到函数级(差 0x284, 函数重写幅度大)。

## 结构字节匹配法(uploadOnCompleteAddr 类)

虚调用块附近常只有 "default" 等通用串, 锚定法无效。改搜已知指令序列字节:
```
ldr x8,[x0]; ldr x8,[x8,#0x30]; mov x1,x19; mov x2,x21; blr x8
= hex 080040f9 081940f9 ...(用 capstone 编码或老版本直接抠字节)
```
在已知邻近函数(如 uploadGetCallbackWrapperAddr)±0x4000 窗口内 hexfind,
再 callscan 确认。4.1.12 的 0x551e0e4 就这么来的(7 指令全等唯一点)。

## 4 个难键的本质(别再走弯路)

downloadFile/Imag/Video + uploadOnComplete 是**函数体中段的回调分发点**(非函数入口),
且 trio 在 __DATA 零静态引用(chained-fixup 验证过: rebase 位 bit63==0, 目标在低36位,
trio 无任何静态引用)——回调在运行时注册进堆对象, IDA 静态交叉引用也找不到。
唯一出路 = 字符串锚定/结构匹配 + 语义确认。

## hook 点语义表(下载三件套)

| 版本 | file/imag 数据寄存器 | 说明 |
|------|------|------|
| 4.1.11 | x22 | JSON 地址 = `mov x1,x22` 指令 |
| 4.1.12 | x21 | 同位置编译器分到 x21 —— **寄存器分配漂移** |

- frida **不能在 bl 上 attach**("unable to intercept...file a bug"),
  一律挂 bl 前一条 mov, 从 context 读数据寄存器
- 挂错点异常会中断同 setup 函数里后续所有 hook(异常抛出后剩下的 attach 不执行)
- **fileId/cdnUrl 偏移随任务结构增长整体平移**(task 指针在 x19):
  4.1.11 = +0x2E0/+0x2F8; **4.1.12 = +0x2F8/+0x310**(+0x18, 与 info ptr
  0x2a0→0x2b8 的结构增长一致)。2026-09-20 真实群文件下载 DIAG 实证
  (+0x2f8 读出 `...@chatroom_..._..._1` 即 fileId)。
  每版必须 DIAG dump 验证, 别信静态反汇编里的 `[x8,#0x2e0]`(x8 基址
  可能是别的对象, 4.1.12 实测误导过一次)
- 另 +0x328 = 本地落盘路径(xwechat_files 下), DIAG 时一并可见

## 运行时安全铁律(血泪)

1. **绝不盲挂候选地址**。2026-09-20 事故: discover 驱动对 harvest 出的未知指针
   盲目 Interceptor.attach(改写运行时 __TEXT), 用户 UI 发图即崩。
   判定手法: 崩溃 PC 处静态字节是 `mov x0,x21`(不可能 SIGILL) → 证明运行时被我们改写。
   发现流程必须**静态优先**, 运行时只挂已 callscan 确认的点。
2. 上传/注入复用任务结构前**整块快照恢复**(sendFunc 入口 dump 0x300,
   注入前 writeByteArray 恢复)—— free 残骸里的野回调指针是 4.1.12 文本发送崩溃根因。
3. `MMStartTask` NativeFunction 的 `{ exceptions: 'propagate' }` 只限 discover 排查,
   生产脚本必须去掉。
4. 生产链路(4.1.11/mac-m1)零打扰; 本地验证用 gadget 模式 + 一次性 onebot 实例。
5. **initAddresses 只能异步派发**(setImmediate 或 Memory.scan 回调)。同步提前调用会
   抢在脚本中部 `var fakeVtable = ptr(0)` 等初始化之前执行, var 随后把已赋值全局
   重置回 0 → 注入结构虚表=0 → 发送必崩(2026-09-20 D 类, 详见 crash-history)。
6. **基址解析模块表优先**(唯一 >50MB 的 wechat.dylib); "req2buf" 字符串扫描只能兜底
   且必须校验 range 可执行——堆里 MallocHelperZone(>100MB)也有该串, 竞态命中则
   hook 全挂空且无报错(2026-09-20 E 类: 静默死亡, 登录后零流量)。
7. 发送链路崩溃先**两版同函数逐指令对比反汇编**确认语义是否漂移, 再怀疑地址——
   4.1.11 推出的基础地址(req2buf/sendFunc/blrX8)经实证零漂移, 别推翻方向。
8. **hook 只挂不拆**(2026-09-21 23:07 H 类实锤): `Interceptor.detach` 拆热路径
   (syscall/高频函数)蹦床与运行中线程天然竞态 → detach 后 ~1s 内 SIGSEGV,
   崩溃线程跳进半恢复蹦床。任何 hook 挂上即常驻到进程死亡; 空闲开销用
   onEnter 快路径/tid 门控制, 绝不用 detach 省。
9. **syscall 泵有边界**: hook 挂载前已 park 在阻塞 syscall 里的线程对 entry hook
   不可见, 纯 blackout 场景泵救不了——需长超时保质+长链 push 事件兜底
   (4.1.13 出队泵设计, 见 4.1.13 细档 §8)。

### 验收期媒体链路(2026-09-20 4.1.12 实战)

8. **DIAG 日志必须单行聚合+限量+用完即删**。frida→Go→文件的 console.log 管道
   ~1s/行; 回调洪泛时逐行 dump 会拖垮上传链路超过 HTTP 15s 超时 → 假象
   "send timeout: worker 无响应", 实际 JS 链路已成功。判真伪: 查日志是否到
   buf2resp ack + 让用户目视确认消息到达, 别只信 curl 响应。
9. **cndOnComplete 结构逐字段 DIAG 验证, 别假设整体平移**。4.1.12: fileId/cdnKey/
   aesKey/md5Key/targetId 均 +0x08, 但 **videoId 字段整个消失**(宽扫 0x00–0x260:
   md5×3 拷贝+CDN IP, 没有 4.1.11 +0xf0 那种 32-hex 值)。空 videoId 传 ""
   (proto3 省略空 bytes), 实测服务端 ack、视频可播放。JS 侧必须 `videoId || ""`
   兜底——Go `videoId.(string)` 遇 null 键会 panic, 被 main.go recover 吞掉,
   表现为 HTTP 超时但 onebot 不崩(日志搜 "message panic")。
10. **媒体发送前先过 CdnManager 门禁**: onebot 重启后 ~60s(或无入站流量)内
    uploadGlobalX0 未解析, 媒体任务直接 result=fail("登录尚未稳定, 暂缓 CdnManager
    解析")。重启后等 >60s 再测媒体; 文本链路不经过它, 不受影响。
11. **验收测试媒体每次新哈希**: C 类秒传对内容哈希敏感, onebot 重启后 JS 钥匙缓存
    丢失(若 Go 落盘也没写成, 同一文件再传必 abort)。`ffmpeg -f lavfi -i testsrc=...`
    合成 + 每次重编码改参数 = 可靠测试材料; 视频和图片一样走 SaveBase64Image,
    API 传 `base64://...`, `-image_path` 必须传(否则上传 -20003)。

## 本地验证环境(4.1.12, 本机)

```bash
# onebot(gadget 模式, 用候选 JSON 试跑)
cd /tmp/onebot-run && nohup /tmp/onebot-local -type=gadget -gadget_addr=127.0.0.1:27042 \
  -wechat_conf=/tmp/onebot-run/4_1_12_discover.json -receive_host=127.0.0.1:58080 \
  -send_url=http://127.0.0.1:9999/void > /tmp/onebot-local.log 2>&1 &
# 测发送
curl -X POST -H "Content-Type:application/json" \
  -d '{"user_id":"<wxid>","message":[{"type":"text","data":{"text":"hi"}}]}' \
  http://127.0.0.1:58080/send_private_msg
```

日志 /tmp/onebot-local.log; 9999/void 的报错是预期噪音。
验收顺序: 文本→图片→视频→文件→(收)图/视频/文件→引用回复, 每步看日志无 ERROR/崩溃。

## 版本实战存档

- **4.1.11→4.1.12 (2026-09-20)**: 14 键 addrfind 直出; 4 难键字符串锚定+结构匹配;
  全 18 键产出 `wechat_version/4_1_12_53_mac.json`。寄存器漂移 x22→x21、
  任务结构 +0x18、快照恢复修复。**完整战报见 `docs/4.1.12-adaptation.md`**,
  崩溃指纹见 docs/crash-history.md 4.1.12 节。
  **验收期修复**: D 类(initAddresses 同步调用致 fakeVtable=0)+E 类(基址竞态挂堆)已修;
  uploadGetCallbackWrapperAddr hook1 正确位=0x551da24(addrfind 误配 0x551f644
  不同 consumer, bl-caller 扫描 13-14 调用点+4.1.11 对照实证, 仓库 JSON 已改);
  cndOnComplete 结构 +0x08 但 videoId 字段消失(见铁律 9)。
  **staging 修复已全部合入 `onebot/script.js`**(structVer 版本开关: JSON 加
  `"structVer": "2"`, 旧版 JSON 无此键渲染为 `<no value>` 自动走 4.1.11 原路径,
  生产零变化; 基址模块表优先+setImmediate/快照恢复为通用修复两版共享;
  DIAG 与 exceptions:propagate 未合入), 合入后仓库脚本+JSON 在 4.1.12 实测
  文本/发图全链路通过(2026-09-20 13:13)。
  **用户验收通过(2026-09-20)**: 收图/API发文本/收视频(不崩)/UI手动发图/收文件(不崩)/
  API发图/API发视频 全绿。
  **收视频现状(用户决议搁置)**: hook 读数正确(std::string x20+0x178/0x180)、
  chunk 流入 Go、**不崩**; 但 4.1.12 视频是渐进式下载(不点播放只下预缓冲段),
  Go 60s 凑不齐报"文件下载超时或数据为空"(软错误非崩溃)。正解 = bot 主动模拟
  下载请求(worker "download" 任务→triggerDownload)而非等 UI 点击, 待 bot 需要
  处理视频时再做。
- **4.1.12→4.1.13**: addrfind 一轮 15/18(含 4 难键全中)。随后反汇编定案:
  req2buf 三件套在 4.1.13 **功能身份换位**——旧 enter 点成了完成回调 H 中段,
  真发送入口是 SubmitCgi(0x42e3450, mgr+msg), 发送范式整体改 V3 零伪造。
  完整解码+V3 设计+实战战报见 **docs/4.1.13-submitcgi-analysis.md**。
  候选 /tmp/onebot-run/4_1_13_candidate.json(会丢)。
  **✅ 收消息已解决并经用户确认(2026-09-20)**: 收发统一响应分发点
  `respDispatchAddr`=0x42e5044(H 尾部 blr 前一条 mov x0,x22, read-only hook):
  onEnter 读 x22=msg/x1=AutoBuffer(双重解引用 D=ab[0], data=D[0], len=D+0xc),
  首字节 0x08 → `protobuf_msg` 送 Go, 文本/引用/群聊全通。旧 buf2RespAddr
  (0x430783c)身份换位已死, structVer=3 直接不挂。发送 ack 也走同一点:
  msg+8 taskid 命中 pending 表 → buf2resp 转发 Go。manager 捕获 =
  `mgrCaptureAddr` 0x42e4c2c(H found 路径 ldr x22,[x25,#0x28] 下一条, x19=mgr)。
  **✅ 发送机制端到端打通(2026-09-20 22:53, 用户确认消息送达)**: SubmitCgi
  原生建 Task/insert/StartTask 全链成功, nativeTaskId=345, 消息真实送达。
  **✅ 完成后崩溃已修复并验证(2026-09-21 07:04)**: 根因 = completeCb
  NativeCallback 签名不匹配; 修复 = CModule `complete_stub`(不读参数返回0)。
  两发(taskid 193/375)送达且微信存活。铁律: native 虚调用路径零例外
  禁 NativeCallback。战报/铁律/下一步全在 4.1.13-submitcgi-analysis.md。
  **✅ 媒体五类全通(2026-09-21, 用户确认图/文件/语音, 视频/引用 API 成功)**:
  图 11.1s / 视频 2.9s / 文件 4.7s / 语音 22.3s(含 19s 出队空等) / 引用 6.3s,
  全部拿到服务端 ret=0 真实 verdict。当天两大战果: ① resp-dispatch ack 分支
  裸读修复(0x33 zone 对 findRangeByAddress 不可见, 门控读静默吞 ack —— 与
  cndOnComplete 同根因, 该 zone 唯一正确读法 = 裸读+try/catch);
  ② cndOnCompleteV3 自动定位器(fileId 锚点扫描+全槽验证, delta=0x8 跨会话
  稳定, 4.1.13 槽内是内联 std::string 对象)。Go 超时调优 worker 35s /
  http 36s; 出队泵 v2(7 syscall × 合法tid)纯保险网。
  **✅ 收尾完成(2026-09-21 08:53)**: [D] 探针全删 + protoHexByMsgAddr 删除,
  清理版文本回归 2.1s 全链; 版本 JSON 落 `wechat_version/4_1_13_63_mac.json`
  (structVer "3", 新增 mgrCaptureAddr/respDispatchAddr 两键)。
  **⚠️ 运维铁律(08:48 实锤)**: kill 存活微信上的 onebot = gadget 会话拆除
  竞态, 可崩宿主(崩溃线程 frida-gadget-tcp-27042)。**换脚本必须微信+onebot
  同步重启**; gadget 会话预算实测 ~9 次/微信生命周期。
  **✅ 短链间隙饿死修复(2026-09-21 23:09, 通宵验证)**: 22:50 实锤 45s 全 CGI
  静默 → 三短链出队点零事件 → 30s 保质放弃(测试号有 ambient 流量, 纯间隙
  饿死; 生产号无 ambient = 必死)。修复 = 出队泵 v3c 常驻(7 syscall × 合法tid)
  + OnPush 长链第 4 出队点 + 保质 85s/Go 90s/HTTP 91s; 当夜 round 验证
  32s 深等待存活。两条新铁律: **hook 只挂不拆**(detach 蹦床竞态 23:07 崩,
  crash-history H 类) + **泵边界**(parked 线程不可见)。TLS 线程亲和未根因,
  正解 = UI→网络线程投递原语, 技术债见细档 §8.5。

## 维护约定

- 新版本 JSON 命名 `wechat_version/4_1_XX_YY_mac.json`, 键序与 4.1.11 一致
- 每次适配完成: 更新本 SKILL 的"版本实战存档"、crash-history.md、commit
- 用户全局规则: git reset 须审批; Agents.md 不要改(有变更只提交)
- **gadget 会话预算**: 反复重启 onebot 会耗尽 gadget 内部会话(控制通道整体卡死,
  只能重启微信)。改 script.js 批量改完再重启, 别改一处重启一次
- **bundle ID 单例**: 日常 4.1.13 在跑时 `open` 4.1.12 是空操作(只激活已有实例),
  必须 `open -n`; 登录前先 `ps` 确认进程路径是 WeChat-4.1.12.app
