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
| 通话状态 beacon(可上生产) | ✅ 引擎起停 4+次验证 | §5 `0x5470688/0x547070c` |
| 工具链 | ✅ 入库 `tools/voip/` | §7 |
| UI侧入队函数(带被叫wxid) | ❌ 唯一缺口 | §9 下一步一钩可破 |
| triggerVoipCall 实现 | ⏳ 等上一项 | §9 |

## 1. 通话信令架构(结论)

```
UI点击「语音通话」 ──→ 入队事件(含被叫wxid)【缺口:入队函数未定位】
                          │
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

1. **probe16(一钩破缺口)**: hook `0x1fdc604` 入口, dump 事件对象([x19]队列项+x0字段)
   — 被叫wxid 应在其中; 同时从队列唤醒/信号函数 backtrace 抓**UI侧入队函数**。
2. **triggerVoipCall(wxid)**: 照 triggerXXX 范式伪造事件入队(或直调入队函数),
   微信原生 FSM 完整接管(UI/响铃/音频全原生)。挂断 = 同服务 cancel 路径(0x2474)。
3. onebot: `/voip_call` 端点 + 通话事件推送(beacon §5 + resp-dispatch)。
4. 生产部署注意: TCC麦克风弹窗(开发副本全程未弹, 生产首次呼叫需观察/预授权);
   看门狗对通话中崩溃的覆盖; VOIPWindow 在 dummy 主屏环境的表现待验。
5. 回归: 每轮用 probe12 全量时间轴对照(信令序列不变即无回归)。
