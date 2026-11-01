# 4.1.13 语音通话(VoIP)发起 — 逆向战报

> 2026-10-31 一次会话完成侦察阶段(15轮探针)。二进制 = 4.1.13.63 (build 269631),
> 与生产同版; 验证机 = 本机 `~/Applications/WeChat-4.1.13.app`(FridaGadget 17.5.2,
> listen 27042; 唯一保留的开发副本, 4.1.11/4.1.12 已删)。
> **所有地址与生产 4_1_13_63_mac.json 同版本通用, 无需 addrfind 迁移。**

## 0. 状态总览(一眼版)

| 事项 | 状态 | 依据 |
|---|---|---|
| 通话信令全图(mars层) | ✅ 测绘完毕 | §2 时间轴, 4次通话逐毫秒对齐 |
| 请求 protobuf 解码 | ✅ invite/sync/cancel 全解 | §3 |
| VoIP CGI 统一发送函数 + 服务单例 | ✅ 已定位并4次验证 | §4 `0x1fdc80c` |
| 通话状态 beacon(可上生产) | ⚠️ 仅拨号方本机音频, **不能判对方振铃** | §5, §10 |
| 工具链 | ✅ 入库 `tools/voip/` | §7 |
| **程序化拨号(对方响铃)** | ✅ 已打通并参数化 | §10 `0x1fcaf64` selector 34 |
| **程序化拨号 + 接通 + 挂断(原生全流程)** | ✅ **2026-11-01 打通并人工实测** | §11 ConfSDK `vt[6]`/`vt[12]` |
| 本机标识字段(field7) | ✅ 可填 0, 无需常量 | §11.2 实测 |
| **通话音频: 出站注入(给对方放音)** | ✅ **2026-11-01 打通**(16k 载荷终版, 录音测 tempo=1.0) | §13 |
| **通话音频: 入站接收(听对方)** | ⏳ 接口已定位(`GetExternalHybridPlayData`)未接线 | §13 |
| onebot 端点 / 生产部署 | ⏳ 下一步 | §9 |

## 1. 通话信令架构(结论)

```
UI点击「语音通话」 ──→ ConfSDKdyn(通话SDK) 组 invite 报文
                          │  0x1fcaf64(svc, selector=34, 0, payload, len, 0)   ← §10
                          ▼ (worker线程, 非主线程)
   0x1fdc604 FSM事件处理器 → 0x1fdc714(从事件取cmdid+URI)
                          → 0x1fdc80c(服务单例, ctx, cmdid, URI) ←统一发送方法
                          → msg构造 0x1fdd4c4(vt=0x98cbf00)
                          → SubmitCgi 0x42e3450 (现有范式)
                          → 微信原生完成 FSM/UI/音频/接通
```

**关键否定结论(别再查)**:
- **被叫方邀请不走 mars**: voipilinkinvite 请求体(293B)只含自己身份+`voip-2p`,
  无对方wxid。建房后经 ilink 加密通道邀请被叫。⇒ 纯伪造CGI任务无法让对方响铃,
  最终实现必须走原生入口(入队事件)。
- 0x5595 `transfer/bizh5webtransfer` 与通话无关(jsmonitor UI上报, 窗口开/关各一次)。
- ilink2/ilink_stream/cronet 的**导出**API 全程零命中(主程序用编译进 wechat.dylib
  的内部C++路径; 且重签名框架的符号不在导出trie里)。
- 通话UI是自绘的: 不创建 NSWindow/CGSNewWindow 零命中。
- **Stalker 在此进程必崩**(app 带 allow-jit, JIT页), 短窗/armed版全崩, 彻底放弃。

## 2. 信令时间轴(实测, 12/15轮探针)

| 时刻 | cmdid | URI | 请求体 | 语义 |
|---|---|---|---|---|
| 点击+~0s | (无关) 0x5595 | bizh5webtransfer | 770B jsmonitor | UI上报,非通话 |
| 点击+~0s | **0x2866** | `voipilinkinvite` | 293B | **建房间**(自己身份) |
| 同ms | — | —(响应) | 1149B | 房间id `o9cq803..._im.wechat_<uin>_3` + arq中转参数 |
| 建房后 | 0x242e | `voipilinklivesync` | 96/112B | 状态同步, 振铃期间周期发 |
| 挂断ms | **0x2474** | `voipilinkcancel` | 251B | 挂断(带房间通道id) |
| +1ms | 0x2c9d | `mmilinktransfer` | 1139B | cloudvoipmtreport 结束上报 |
| +0.4s | 0x3e4/0x3da | newreportkvcomm/idkey | — | KV上报(非通话专属) |
| +0.9s | — | —(本地) | 1203B | 聊天气泡 `<voipmsg type="VoIPBubbleMsg">` XML |

音频引擎(拨号方)在 voipilinkinvite 发出后 ~100ms 内启动(§5 beacon)。

## 3. 请求 protobuf 结构(已解码, 模板存 tools/voip 会话日志)

三包共享外层: field1 = 设备/会话头(会话id `m31fec81daa76658` 形态, `UnifiedPCMac 15 arm64`);
field2 = 各自业务体。

- **invite(293B) field2**: `{1:自己wxid, 2:varint 2(人数), 3:空, 4:设备信息{deviceId
  0xf2641d3f/arm64/Apple M4/en0}, 5:自己uin, 7:'voip-2p'}`
- **sync(96B) field2**: `{1:房间id(u64), 2:{...时间戳}, 4:'voip-2p', 5:状态varint}`
- **cancel(251B) field2**: `{1:{房间, {wechat, u64房间id, 'voip-2p', 通道串
  'o9cq..._im.wechat_<uin>_3', 1,...}}, uin, 房间id, 自己wxid, 'voip-2p'}`

## 4. VoIP CGI 统一发送函数(本战报核心产出)

```
0x1fdc80c(x0=服务单例, x1=ctx, w2=cmdid, x3=URI字符串(24B libc++按值), x4=out)
```

- **服务单例指针**: 单次会话内恒定(实测 0x106a05228), replay 可捕获后复用。
- **w2 直接就是 cmdid**(0x2866/0x242e/0x2474 实测)。
- **x3 就是 URI**(`/cgi-bin/micromsg-bin/voipilinkinvite` 等, libc++长串:
  ptr=+0, size=+8, 长串旗标=+0x17 bit7)。
- **x1 ctx 布局**(48B 实测): `{+0x00 模块ptr, +0x10 堆上payload对象(每任务新建),
  +0x18 selector=2, +0x1c cmdid, +0x20 URI串指针}`; payload对象 = 各请求的业务数据源。
- 调用链: `0x1fdc604(FSM事件处理) → 0x1fdc714(取事件字段: cmdid=[ev+0x20],
  URI=[ev+0x28], out=[ev+0x40]) → 0x1fdc80c → 0x1fdcf94 → 0x1fdd264 →
  msg构造0x1fdd4c4 → SubmitCgi`。全在 worker 线程(tid≠主线程), Frida 可直调。
- VoIP CGI 服务 vtable = **0x98cbe38**(方法群 0x1fdcc38/0x1fdcd1c/0x1fdcdd0/
  0x1fdce2c/0x1fdce8c/0x1fdcf14/0x1fdcf88); msg 类 vtable = **0x98cbf00**,
  序列化 fn=**0x1fdd64c**, 响应 fn=**0x1fdd70c**。

## 5. 通话状态 beacon(可直接上生产)

| 偏移 | 含义 | 验证 |
|---|---|---|
| wechat.dylib+0x5470688 | 音频引擎 Start(≈呼叫建立/接通) | 6+次通话 |
| wechat.dylib+0x547070c | 音频引擎 Stop(≈通话结束) | 6+次通话 |

音频引擎集群 0x546e000~0x5475000; 引擎Start容器函数 0x5470644, 其 vtable=0x9a657d8,
构造 0x54704e4(调用者 0x546e5e4/0x5470f74, 均虚表分发)。来电/去电同样触发,
可做「通话中」状态上报; 配合 resp-dispatch 可拼完整事件。

## 6. 开发环境(本机)

- 开发副本: `~/Applications/WeChat-4.1.13.app`(gadget注入+adhoc), `open` 后
  `voipprobe -script probeN.js` 即挂。SIP 开启不影响(走gadget)。
- 副本与生产同版本同二进制 ⇒ 探针地址直接对生产有效。
- 旧副本 4.1.11/4.1.12 已删(用户要求, 不再降级旧版本)。
- runner: `onebot/cmd/voipprobe`(frida-go, 复用 onebot 的 gadget 连接逻辑), 构建:
  `cd onebot && CGO_CFLAGS="-I$HOME/Prog/weixin-macos/frida-devkit" CGO_LDFLAGS="-L$HOME/Prog/weixin-macos/frida-devkit" go build -o ../tools/voip/voipprobe ./cmd/voipprobe`

## 7. 工具链(tools/voip/, 全部标准库+capstone)

| 工具 | 用途 |
|---|---|
| `strxref.py` | 字符串/ADRP交叉引用(arm64切片, adrp+add/ldr解码) |
| `voipwalk.py` | 函数边界启发(capstone) + 全量BL调用者扫描 + 反汇编 |
| `voipclimb.py` | BL图 + fixup编码 交替上溯(虚表跳转用编码搜索破) |
| `voipprobe` | frida-go runner(连gadget加载探针脚本, 打印消息) |
| `probe1~15.js` | 15轮探针演进, 关键: probe10(x1才是msg!), probe12(全量cmdid), probe13(backtrace拨号链), probe14/15(参数dump) |
| 会话日志 | `probe-session*.log` 各轮原始数据, protobuf模板在里面 |

索引缓存(重建脚本在 voipclimb 内联历史, 二进制路径硬编码副本):
`/tmp/bl_callers.pkl`(240万BL边), `/tmp/adrp_index.pkl`(27.8万数据引用)。

## 8. 方法论与踩坑(铁律)

1. **SubmitCgi 读 x1 不是 x0**: x0=mgr单例(字节恒定), x1才是msg结构 —
   v1探针因此把通话信令误判成心跳。
2. **Stalker 禁用**(必崩, JIT页); 单函数入口 hook + backtrace 是安全且足够的。
3. wechat.dylib 被加载两份(16KB stub + 真身): 选base必须 `size>100MB` 过滤;
   模块size字段不含尾部数据段, 内存扫描跨度用 0x20000000。
4. **chained-fixup 编码已破**: 文件内数据指针 = `0x0010000000000000 | target_vmaddr`,
   `bytes.find(pack("<Q", ...))` 即可找任意函数的引用槽位(vtable/注册表)。
5. 重签名框架的导出符号不在 trie → frida 找不到时用 `nm` 偏移 + 模块base手动定位。
6. mmui 类名体系是自定义注册表(16字节定宽槽+hash后缀), 无标准RTTI指针链,
   别走 typeinfo 反查的老路。0x9b73xxx 一带是字符串区(含 VoiceInput 误导向,
   `VoiceInputMouseMonitorMac` ≠ VoIP)。
7. 探针 cgi 过滤器别只登记已知 cmdid — 会漏信令(probe11 教训, 1150B房间响应归属
   靠 probe12 全量记录才补上)。
8. 本机(Sequoia, SIP开)不能 attach 原版微信; 开发一律走 ~/Applications 副本。
   本机无 IDA; capstone: `pip3 install --break-system-packages capstone`。

## 9. 下一步(实现路线)

1. ~~挂断~~ ✅ 2026-11-01 打通: ConfSDK `vt[12]`(§11)。
2. ~~svc 指针自取~~ ✅ `GetWXConfService(0x1352707)`(§11)。
3. ~~本机标识(field7)自动获取~~ ✅ 填 0 即可(§11.2), 无需常量。
4. ~~音频链路(当前阻塞项)~~ **出站已打通**(§13): 原生客户端拨号 + ConfSDK
   外部 PCM 注入, 对方可听清 TTS 语音; 剩轻微底噪(NS/DTX/PLC 嫌疑)与入站接收。
5. onebot: `/voip_call` 端点 + 通话事件推送(接听/挂断仍复用 wxgate 气泡或 §11 的 selector 判据)。
6. 生产部署注意: TCC麦克风弹窗(开发副本未弹, 生产首次呼叫需观察/预授权);
   看门狗对通话中崩溃的覆盖; VOIPWindow 在 dummy 主屏环境的表现待验。
7. 回归: 每轮用 probe23/24 全量时间轴对照(信令序列不变即无回归)。

## 10. 拨号入口已打通并参数化(probe16~22)

> ⚠️ **本节是历史路线的中途站**: 这样注入能让对方**响铃**, 但**接不通**——
> 它绕过了 ConfSDK 的会话状态机, 建房间/接听应答/媒体协商没人处理, 对方点接听
> 只会一直转圈。**正确的入口见 §11**(同一版本, 2026-11-01 打通接通)。

**以前的「UI侧入队缺口」是找错了模块**: UI 点击后真正提交邀请的不是 wechat.dylib 的
界面代码, 而是通话 SDK **ConfSDKdyn.framework**(`Contents/Resources/ConfSDKdyn.framework/
ConfSDKdyn`, 真身 `__text: 0x3b58 size 0x8c9ac`; Frameworks/ 下还有一个同名 84KB 桩,
voipwalk 会误判)。它调用 wechat.dylib 服务对象的**虚方法**提交邀请:

```
0x1fcaf64(服务对象, selector, 0, payload, len, 0)   // 服务虚分发器
   w1=34(0x22) → 0x1fcafe8 → bl 0x1fd7bac (invite 工厂)
```

- 调用签名(实测可用): `x0=svc, w1=34, x2=0, x3=payload ptr, w4=len, x5=忽略`
- `svc` 由真实拨号时在 `0x1fcaf64` 入口捕获(单次会话恒定; probe19/20 为 `0x123877ab8`)
- 校验: `[svc] == wechat+0x98cbac8`(服务对象 vtable, 4.1.13.63 实测)
- **payload(273B)结构**(抓包模板, 见 `probe-session20.log`):
  ```
  08 ae44                field1 varint 0x222e (请求类型)
  12 e1 01               field2 len=225
    0a 13 <被叫wxid>       ← 唯一需要替换的字段
    10 02 1a 00
    22 b6 01 <设备信息 182B>
    ... 平台 arm64/Apple M4/en0, uin, 'voip-2p'
  18 e650                field3 = cmdid 0x2866
  22 25 "/cgi-bin/micromsg-bin/voipilinkinvite"
  ```
  **被叫 wxid 在 payload 里**, 不在 mars 请求里 —— 和 §3 的结论一致, 说明 ConfSDK 把
  「给谁打」放在交给 wechat.dylib 的上层报文里。

**实测战绩(2026-10-31 夜)**:

| 时间 | 动作 | 结果 |
|---|---|---|
| 23:22 | probe20 原样重放 invite(273B) | `replayDone ok`, 31s 后 audioStart; 对方响铃 |
| 23:26 | probe21 定点重放(23:26:00 整) | 对方手机响铃(人工确认), **无任何 audio beacon** |
| 23:36 | probe22 换成 `wxid_4erh8rirquu921` | 对方手机响铃; mac-m1 侧微信收到 VoIP 气泡「已拒绝」 |

**修正两条旧结论**:
- §5 的音频 beacon **只反映本机音频引擎**, 23:26 与 23:36 两次成功响铃都没有 beacon
  (分别延迟 31s / 完全没有) ⇒ 不能作为「对方振铃」判据, 只能做本机通话状态参考。
- 被叫侧(登录在同一账号的 mac-m1 微信)会在几秒后收到
  `<voipmsg type="VoIPBubbleMsg">…已拒绝/对方已拒绝…` 并落进 wxgate.db ⇒ 通话事件
  可以直接复用 wxgate 的气泡日志, 不必自己造轮子。

**工具**:
| 文件 | 用途 |
|---|---|
| `invite_payload.py` | 模板拆包/替换 wxid/重算两级 protobuf 长度; `--selftest` 逐字节 round-trip |
| `probe21.js` | 固定 payload 定点重放(文件触发 `/tmp/voip_replay.req`) |
| `probe22.js` | 参数化: 读 `/tmp/voip_target.txt` 的 wxid → 重建 payload → 触发即拨号 |
| `probe16~19.js` | 缺口定位过程(事件结构/任务 vtable/ctx 工厂/服务虚分发器), 结论已并入本节 |

## 11. 里程碑: 接通打通 —— ConfSDK 原生入口 `vt[6]` 拨号 / `vt[12]` 挂断(2026-11-01)

§10 的注入落在 **ConfSDK 下游**(wechat.dylib 的服务分发器), 只发出了 invite 一包,
房间建立/接听应答/媒体协商全部缺席 ⇒ 对方响铃但接不通。正解是**上游一格**: 走通话
SDK 自己的会话命令队列。

### 11.1 入口

```
svc  = GetWXConfService(0x1352707)        // ConfSDKdyn 导出, 入参是魔数不是 0
                                           // 错误魔数 → 打日志返回 0; 正确 → 惰性单例
                                           // 实测 0x6000028d5fe0, 进程内恒定
vt   = [svc]                               // 实测 ConfSDKdyn+0x7b9b0

拨出: vt[6]  = ConfSDKdyn+0x79ab4
      int f(void* svc, void* pb, int len)          // x3/x4 是调用方残留, 函数不读
      // 反汇编: memcpy(pb,len) → std::string → 分配 task{vt,+0x10 填 3} → 投递给
      //         [*(svc+8)+0x2b30] 的队列 → return 0    (pb 空 = -1, 无 impl = -2)

挂断: vt[12] = ConfSDKdyn+0x79dfc
      int f(void* svc, int a1, int a2)             // UI 挂断实测 (1, 0)
      // 投递 type=7 任务 → return 0 / -2
```

两者都是**纯异步投递**, 返回即成功入队; 之后的建房间、接听处理、音频全部由
ConfSDK 自己的 worker 线程驱动 wechat.dylib 完成——这就是能接通的原因。

### 11.2 拨号 pb(50B, 抓自 UI 手动拨号)

```
0a 13 <被叫 wxid>        field1 被叫 wxid (19B)
10 02                    field2 = 2      (音频通话)
18 00                    field3 = 0
20 04                    field4 = 4
38 f3c1a4f302            field7 本机标识 varint (UI 拨号填的是本机值 0x20E6F20F3)
42 06 "wechat"           field8 appid
4a 07 "voip-2p"          field9 domain
```

只有 field1 需要按目标替换(在 buf 最前面, 改长度即可, 无嵌套长度要重算)。

**field7 可以填 0** —— 2026-11-01 09:28 实测: `38 00` 照样响铃、照样接通
(`SEL 21 26B→32B` / `SEL 22` / `SEL 29×4`), 唯一差别是下游报文长度略变
(SEL 39 27B→28B、invite 273B→274B、SEL 5 66B→70B), 不影响通话。
⇒ **生产不需要抓任何本机常量**, 模板固定即用。

### 11.3 实测时间轴(2026-11-01 09:16, 开发副本, 人工接听确认)

```
09:16:08.112  vt6(svc, pb, 50) → ret 0                        ← 程序化投递
09:16:08.119  SEL 39  (27B)   会话建立            ConfSDKdyn+0x1f69c
09:16:08.123  SEL 34  (273B)  invite 发出         ConfSDKdyn+0x241e4
09:16:08.222  ConfSDK 内部又投递一次 vt6                       ← 原生自驱
09:16:08.229  SEL 6   (0B)
09:16:08.937  SEL 5   (66B)   房间 id
09:16:08.938  SEL 20  (241B)
09:16:08.938  SEL 21  (26B)
09:16:08.950  SEL 34  (82B)
09:16:09.363  SEL 34  (115B)  心跳, 每 6s
--- 对方接听 ---
09:16:17.324  SEL 21  (32B)   ← 长度 26→32 就是接听应答
09:16:17.808  SEL 22  (30B)   媒体协商
09:16:17.872  SEL 29  ×4      音频参数 (12/18/16/12B)
09:16:23.381  SEL 34  (115B)  通话中心跳
--- 程序化挂断 vt12(svc,1,0) ---
09:16:57.607  SEL 25  (58B)   告别
09:16:57.608  SEL 26  (30B)   释放
```

对照: 未接超时(~60s)是 `SEL 20 → SEL 25(56B) → SEL 7(0B) → SEL 34(210B cancel) → SEL 26(30B)`。
**判据**: 出现 `SEL 22` + `SEL 29×4` = 真接通; 只有 `SEL 34` 心跳 = 还在响铃。

### 11.4 顺带确认的行为

- 通话中再投递 `vt[6]` **不会**起第二通(ConfSDK 内部单会话保护), 只回一包 `SEL 6/34`。
- `wechat.dylib+0x1fc07f4` 是 UI 侧「拼 50B pb → 调 vt[6]」的原生拨号函数
  (`1fc1240: bl 0x5706804` 序列化到栈上 std::string, 再 `ldr x8,[x0]`/`ldr x8,[x8,#0x30]`
  即 vtable slot 6, `blr x8`)。**入参实测**(probe33, 09:26 手动拨号):
  ```
  x0 = 0x123877ab8            wechat.dylib 服务对象(与 §10 抓的 svc 同一地址)
  x1 = "wxid_3dpoduq17tvc12"  被叫 wxid, 纯 C 字符串
  x2 = std::vector<std::string>* 参与者列表(元素 24B = libc++ string), 1 项
  x3 = 1   x4 = 0   x5 = 0x2e6953e3 (scene)
  ```
  ⇒ 想走「原生入口自填本机标识」的路, 可以直接调它(需自建那个 vector)。
  但既然 field7=0 已够用(11.2), 这条只是备选。
- arm64 切片: `lipo -thin arm64`; 该 dylib `__TEXT vmaddr=0` ⇒ **文件偏移 = VM 地址**。

### 11.5 遗留

~~field7 本机标识~~ **已消解**: field7 填 0 即可正常拨号+接通(11.2 实测),
不需要任何按机器/按账号的常量。若将来要报文与原生逐字节一致, 再走 11.4 的
`0x1fc07f4` 原生入口。

### 11.6 工具(本轮新增)

| 文件 | 用途 |
|---|---|
| `run_probe.py` | **探针驱动**: `python3 run_probe.py probeN.js out.log` → gadget 连接 + 逐行 flush 落盘(替代 frida CLI, CLI 重定向有缓冲)。解释器用 `/Users/leslielu/.venvs/wechat-re/bin/python` |
| `probe23/24.js` | 手动通话全量信令记录 / 各 selector 完整 payload |
| `probe25.js` | 反证: 直接投 SEL39+SEL34 之后没有任何后续(说明必须走 ConfSDK) |
| `probe26~28.js` | ConfSDKdyn 定位三连: 内部帧栈死路 → 导出函数只启动时调用 → **取服务对象挂全 vtable 48 方法** |
| `probe29.js` | 深挖 `vt[6]` 入参 → 得到 50B pb 结构 |
| `probe30.js` | 首次用 `vt[6]` 原生拨号(响铃成功) |
| `probe31.js` | `vt[6]` 拨出 + `vt[12]` 挂断双入口(文件触发, 用于全流程实测) |
| `probe32.js` | 抓 `wechat.dylib+0x1fc07f4` 入参(首次没挂上: `script.load()` RPC 超时) |
| `probe33.js` | 双保险重抓 → 拿到原生拨号函数签名 `(svc, wxid, vector*, 1, 0, scene)` |
| `probe34.js` | 内存扫描: field7 值不在任何模块数据段(运行时取), 无静态来源 |
| `probe35.js` | 想抓序列化入参结构体, 但 `0x1fc1240` 是函数中段, Frida 拒绝 attach |
| `probe36.js` | **field7=0 拨号验证**(09:28 实测可接通) |

`run_probe.py` 注意: `script.load()` 偶发 RPC 超时(探针 32 那次), 驱动已改成
超时不再退出, 否则脚本虽在进程里跑、会话却被拆掉, 后续手动操作全抓不到。

触发约定: `/tmp/voip_replay.req` 写新内容 = 拨号(目标读 `/tmp/voip_target.txt`),
`/tmp/voip_hangup.req` 写新内容 = 挂断。

## 12. 音频阻塞: 接通了但没声音(2026-11-01 下午, probe37~41)

### 12.1 现象

`vt[6]` 拨出 → 对方响铃 → 接听 → 双方建立通话(§11 信令全绿), 但 **双方静音**,
本机也 **没有拉起通话 UI 窗口**。用户判定: 微信本地语音模块没启动。

### 12.2 对照实验(结论性)

| 探针 | 拨号方式 | 信令 | 通话状态机 `0x434dc00` | 音频引擎 `0x546a558…` |
|---|---|---|---|---|
| v38 | 程序化 `vt[6]` | ✅ SEL39/34/5/20/21 全绿 | 未测 | **0 次调用**(4 个入口全安静) |
| v40 | 程序化 `vt[6]` | ✅ 同上 | **0 次调用** | 未挂(避崩溃) |
| v37/v39 | 人工 UI 拨号 | ✅ | 状态 4→5→6 | ✅ 4ms 内建引擎并启动采集 |

⇒ **`vt[6]` 只是 ConfSDK 传输层**。微信自己的 VoIP 客户端层(通话 UI、状态机、
音频引擎、媒体会话)完全没被触发, 所以接到 ConfSDK 的字节流再正确也不会发声。

### 12.3 UI 拨号的真实链路(v39 抓全)

```
按钮处理   0x1c56cec → 0x1fe14a8            (x0=manager, x1=会话对象)
拨号       0x1fc07f4(clientObj, "wxid_xxx", vector<participants>, 1, 0, scene)
            └ 内部: 序列化 pb(0x5706804) → ConfSDK vt[6]
引擎创建   0x546a558(engineWrap, x3=0xac44=44100) → 0x5470f7c(engineCreate)
           → 0x54704e4(ctor) → 0x5470644 → 0x5470688(engineStart)
驱动源     主 runloop 定时任务: 0x4350030 → 0x434dc00(x1=状态 2..6) → 引擎
           (回调栈 … ← 0x3d96208 ← 0x816b0 ← libobjc.A.dylib)
```

`0x1fc07f4` 入参(x0)的 vtable = **wechat.dylib+0x98cbac8**, 槽 0 就是
`0x1fcaf64`(我们一直在用的 selector 分发器) ⇒ 该对象就是微信侧 VoIP 客户端,
不是 ConfSDK 服务(`GetWXConfService` 返回的另一枚)。

### 12.4 回放 `0x1fc07f4` 失败的原因(已定位到代码)

> ⚠️ **本节结论已被 §13 推翻**: probe42/43 证明 `+0x28` 是**初始化完成标志**
> (0x1fbf798 初始化成功后 0x1fc0304 置 1), 不是一次性拨号门禁; 置 1 才进入拨号
> 主体, 清零反而走未初始化返回路径。静态单例配合正确参数构造可无限次回放,
> v41 失败真因是 Frida 内存未保活 + libc++ 短串布局判错(§13.1)。

v41 在 UI 拨号时抄下 `x0=0x12372fab8`, 通话结束后用同一对象回放:
`ret=1`, 只产生一个 `SEL 6 len=0`, 没有拨出。反汇编 0x1fc07f4 找到了门禁:

```
0x1fc083c  add  x28, x0, #0x28
0x1fc0840  ldarb w8, [x28]        ; 取 x0+0x28 的首字节(acquire)
0x1fc0848  tbnz w8, #0, 0x1fc0cd0 ; 置位 → 走清理/中止分支, 不拨号
```

即该客户端对象带 **一次性/在途标志**(+0x28), 通话结束后的实例不能复用。
要做程序化拨号, 必须拿到一个 **新建的** 客户端对象(或把该对象复位到空闲态)。

### 12.5 ⚠️ 音频引擎集群不能挂 Frida(重要, 会崩)

v37、v39 两次 UI 拨号都在 **AudioIOThread** 崩溃:
`EXC_BAD_ACCESS/SIGBUS, EXC_ARM_DA_ALIGN at 0xac4400000002, possible PAC failure`。
高 32 位 `0xac44` 就是 44100 采样率 —— 说明被 Interceptor 改写的入口是被
**PAC 签名间接调用**的, trampoline 破坏了签名。

⇒ **0x546a558 / 0x5470f7c / 0x54704e4 / 0x5470644 / 0x5470688 一律不准挂钩子**
(§5 的"音频 beacon 可上生产"因此作废; 想拿通话状态请只用信令 selector 判据)。
后续探针若必须观测, 只能 **调用** 这些函数, 不能 hook。

### 12.6 下一步候选(按推荐度)

1. **拿新建客户端对象**: 静态找 `0x98cbac8` vtable 的构造/工厂(该类方法集:
   `0x1fcaf64 / 0x1fbb354 / 0x1fbb370 / 0x1fcab44 / 0x1fcab8c / 0x1fca054`),
   或运行时扫描堆里 `[obj] == BASE+0x98cbac8` 且 `*(u8*)(obj+0x28)==0` 的实例。
   拿到后调 `0x1fc07f4` 即等同于 UI 拨号(窗口+状态机+音频一起起来)。
2. **复位门禁**: 若客户端是单例, 找到谁清 `+0x28`(通话结束时), 手动清或调其
   `reset/stop` 方法后再拨。
3. **UI 自动化兜底**(不推荐但可靠): CGEvent/OCR 点聊天窗「语音通话」按钮。
   生产机有 dummy 主屏 + watchdog 的 OCR 点击链路, 但每次拨号都要开窗定位。
4. 先验问题(不论走哪条): ConfSDK 通话里, 本机音频引擎到底是"设备 IO 提供方"
   还是"整条媒体链"——决定拿到客户端对象后是否还需要额外接 PCM。

### 12.7 工具(本轮新增)

| 文件 | 用途 |
|---|---|
| `probe37.js` | 首次对照: UI 拨号 vs 程序化; 含 2 个**猜测地址**钩子(0x5470600/0x5470f74)→ 崩因 |
| `probe38.js` | 最小风险: 只挂 §5 的 4 个音频入口 → 证实程序化拨号 0 次引擎启动 |
| `probe39.js` | 控制器层入口参数全抓(0x1c56cec/0x1fe14a8/0x434dc00/0x4350030 + 引擎层) |
| `probe40.js` | **不碰音频函数**, 只验状态机 → 程序化拨号状态机零调用 |
| `probe41.js` | 抓 `0x1fc07f4` 全参 + 用捕获对象回放(暴露 +0x28 门禁) |

## 13. 里程碑: 出站音频注入打通 —— 给对方「播放语音」(2026-11-01 晚, probe42/43)

### 13.1 原生客户端静态单例拨号(probe42, 推翻 §12.4)

- 客户端是**静态单例**: `CLIENT = BASE+0x9b93ab8`(工厂 0x1fdeac0, 构造 0x1fbb050),
  vtable = BASE+0x98cbac8; `[client+0x20]` = ConfSDK svc, `+0x28` = 初始化完成
  标志(0x1fbf798 初始化成功后 0x1fc0304 置 1)。**不是一次性门禁**(§12.4 作废):
  置 1 才进入拨号主体, 清零反而走未初始化返回路径。单例可无限次回放。
- 入口: `0x1fc07f4(client, 被叫cstr, vector<string>*, x3=1, x4=0, x5=0x2e6981b3)`;
  ret=1 = ConfSDK vt[6] 返回 0 = 发送成功。
- participants vector 元素 = libc++ std::string(24B)。**本进程布局**(以生成代码
  0x1f89514/0x570673c 实际读取为准): 短串文本在 +0、长度直接存 +0x17(不左移);
  长串 ptr@+0、size@+8、+0x17 bit7=1。probe19 的 `len<<1/文本+1` 旧解读不适用。
- **Frida `Memory.alloc` 由 JS GC 管理**: 局部指针退出作用域即被回收复用 —
  拨号全部参数(cstr/string/vector)必须全局 KEEP 保活, 否则 pb 退化为 `0a00`。

### 13.2 外部 PCM 注入(probe43, 20 通电话实测标定)

**接口链**: 公开 API `ConfSDKdyn+0x7a370(svc, pcm, len, sampleRate, channels)`
→ ConfEngine(`[svc+8]+0xa10`) → MVQQ(`[confEngine+8]`) vt[0x300] →
MultiMediaDyn `0x1f9618/0x1f8018` → vt[0x340]。不碰 wechat.dylib PAC 音频禁区。

**标定结论(终版, 2026-11-01 深夜, 22 通电话 + 录音客观测量)**:

| 参数 | 终版(录音测 tempo=1.0000) | 偏差后果(实测) |
|---|---|---|
| 帧结构 | **960B = 640B 16k 内容 + 320B 零尾**(引擎吃前 640B 丢零尾) | 整帧 24k 内容 → 每帧富余 160 样本 → 缓冲积压 → 周期性滋滋杂音 + ×2/3 慢放(女声听成男声) |
| 节拍 | 640B 新数据每 **20ms**(绝对时间线调度) | 10ms = 溢出杂音; 30ms = 欠供杂音 |
| 声明采样率 | **必须 24000**(路径门) | 16000/48000 全杂音(5:1 实测相关) |
| 内容 | **16kHz mono s16 原始 PCM, 零重采样零补偿** | 24k 重采样/atempo 均已废弃 |
| 麦克风 | 接通后调 **MuteMicPhone(confEngine,1)** | 不调 → 音调整体 ×1.5 偏快偏尖 |

- 返回码: `0` 成功; `-405447`(0xFFF9D039) = NoMember is Active = **还没接通**
  (每 200ms 重试、数据指针不前移 → 接通瞬间自动从文件头开播); `-405471`
  (0xFFF9D021) = startTalkFlag==0 = 会话已销毁。
- **MuteMicPhone** = `ConfSDKdyn+0x662e0(confEngine, 1)` → `vt[0x40](0x19c)`;
  0 = 取消(0x19d)。效果: 消除音调 ×1.5 偏快。机理未明——用户确认远端**从没**
  听到过本机麦克风声, 所以不是真静麦克风, 猜测是关闭记录侧的竞争消费者
  (内部采集/重采样路径与外部注入双重消费)。
- **速率失配=底噪根源(用户猜对, 已证实)**: 24k 整帧内容下引擎只吃 320/480
  样本, 每帧富余 160 样本 × 50帧/s = 8000样本/s 积压 → 缓冲周期性清空 =
  滋滋杂音, 同时内容 ×2/3 慢放+音低下沉(婷婷女声听成男声)。改为 640B 载荷
  后消费恰 1:1 → 无积压无杂音。中途的 atempo≈1.071 补偿方案(只修速度不修
  音高)据此**废弃**; 耳测二分数据(1.07 慢/1.0725 快)属判断噪声。
- **客观测量方法**: 通话时用 ffmpeg 录本机内建麦(`-f avfoundation -i ":2"`)
  收手机外放, 与参考文件做包络互相关 → 时长比。终版配置实测 **tempo=1.0000**
  (10.00s→10.00s)。注意: 频谱主峰比在声学二次录音下不可用(喇叭+房间重塑频谱)。
- **同配置结果曾波动**: 12:14 轮(同 640B 模型)用户报杂音很大, 12:19 轮(唯一
  差异 = ffmpeg 正在占用内建麦克风)效果历史最佳。嫌疑: SDK 内部录音器与
  ffmpeg 的设备竞争 / 网络瞬态。复现杂音时优先试「先占住麦克风」; 待下轮验证。
- 探针泵: 预配 stage 缓冲(每帧零分配, 减 GC) + 混合节拍(setTimeout 提前
  5ms 醒 + 临界自旋) + 抖动统计。实测数百帧 `maxLateMs=0, lateOver3ms=0`。
- 入站方向(听对方)接口已定位未接线: `GetExternalHybridPlayData`(wrapper
  `ConfSDKdyn+0x7a388`) / `GetExternalPlayData`(`+0x7a3a8`), 与注入对称。

### 13.3 实测验收(最终形态)

16k PCM(音乐文件完整验证: 录音测量 tempo=1.0000 + 用户确认无杂音、音调速度
正常)。TTS(婷婷)在同配置下待复验(此前 TTS 轮均为已废弃的 24k 配置)。
生产管线: `ffmpeg -ar 16000 -ac 1 -f s16le` → 640B 载荷/960B 帧/20ms → 注入。
**bot「拨通后给对方放一段语音」链路闭环。**

### 13.4 工具(本轮新增)

| 文件 | 用途 |
|---|---|
| `probe42.js` | 原生客户端静态单例直接拨号(修 v41 字符串布局 + 内存保活) |
| `probe43.js` | 拨号 + 接通等待 + PCM 注入全链(标定写死/muteMic/抖动统计) |

**run_probe.py 注意**: 日志是**追加写**——等待循环判「新事件」必须按拨号前的
行号偏移 grep(`tail -n +N`), 全文 grep 会命中上一轮的残留事件(踩过: 误把上轮
mediaReady 当本轮接通, 在响铃期注入, 全部 -405447)。触发文件是**边沿触发**
(内容变化才执行), 每轮重拨必须同时刷新 uidial 和 pcm 两个触发文件(踩过:
只改拨号忘了改 pcm, 对方接通后无注入)。
