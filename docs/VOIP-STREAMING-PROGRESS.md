# VoIP 实时流式 — 进展文档

设计：`docs/VOIP-STREAMING-DESIGN.md`　需求：`wxgate-streaming-voice-requirements.md`（2026-11-15）
本文跟踪实施与真机冒烟进展；实现细节看设计稿，通话底层标定看 `docs/VOIP-CALL-STATUS.md`。

## 1. 阶段状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| 设计 | 接口契约/协议/边界（§19 六个契约点） | ✅ 2026-11-15 |
| 1 | onebot JS 实时媒体引擎（script.js 流式分区） | ✅ 代码完成，语法+重采样单测过 |
| 2 | onebot Go 会话/WS/背压/清理 | ✅ 假底层 11 用例全绿（含 -race） |
| 3 | wxgate 代理+鉴权 | ✅ 代理 5 用例全绿 |
| 0 | 能力补证（接通探测/自声回灌/clear 残留/拒接忙线） | 🔶 本轮冒烟覆盖前两项 |
| 4 | 真机验收 + mac-m1 部署 | ⬜ 未开始，**勿投产** |

## 2. 已实现清单（2026-11-15）

- onebot：`voice_stream{,_ws,_protocol,_bridge}.go`、`script.js`「VoIP 实时流式分区」、
  `/voice_calls*` 五路由、`-stream_token`（空=fail-closed）/`-stream_origins`、
  旧 `/hangup_voice_call` 实时期间 409 守卫、消息回调升级二进制双参（`main.go`）。
- wxgate：`handler_call_stream.go`（`registerStreamRoutes`）、config 增
  `voice_api_token` / `onebot_stream_token` / `voice_ws_allowed_origins`、gorilla v1.5.3。
- 联调客户端：`tools/voip/stream_client.py`（`--start` 才拨号；token 走 `VOICE_STREAM_TOKEN`）。
- 测试证据：onebot 全量 `-race` ✅；wxgate 全量 ✅；JS node 语法 ✅；
  重采样 node 单测 ✅（16k→48k 频率/长度正确、20kHz 抗混叠残留 402）。
- 修过的真 bug：JS `frameBuf` 须在 `triggerVoipCall` **之后**入 `voipKeep`（否则 UAF）；
  溢出判定改 2s 滑动窗口（"连续丢帧"会被 writer 交替成功重置）；attach 超时在 attach 后
  让位给 start 超时；WS pong 处理器内刷新读 deadline（否则空闲保活连接被误杀）。

## 3. 本地冒烟环境（2026-11-15）

- 副本：`~/Applications/WeChat-4.1.15.app`（build 270135，**已注入 FridaGadget**，adhoc）。
  ⚠️ script.js VoIP 常量是 4.1.15.55 标定（等待码 -405885/-405909、CE 0x9e0），必须用这份，
  不能用 rig-setup.sh 的 4.1.13 老 rig。SIP 开启 ⇒ 只能 gadget 模式。
- 地址 JSON：`wechat_version/4_1_15_55_mac.json`。
- 开发号：`wxid_d0w7a7cme75n22`（容器 `_084a`）；互拨目标见 §5 待定。
- onebot 启动（gadget、单实例不反复重启——会话预算约 9 次/微信生命周期）：
  ```bash
  cd ~/Prog/weixin-macos/onebot && nohup ./onebot \
    -type=gadget -gadget_addr=127.0.0.1:27042 \
    -wechat_conf=../wechat_version/4_1_15_55_mac.json -conn_type=http \
    -image_path=<dev 容器 Img 路径> -wechat_id=wxid_d0w7a7cme75n22 \
    -stream_token=dev-smoke \
    > /tmp/onebot-stream-smoke.log 2>&1 &
  ```
- 改 script.js/二进制后的规程：**改好 → 重启微信 → 登录 → 起新 onebot**，一次到位。

## 4. 冒烟轮次记录

### 轮 A：协议栈冒烟（不拨号）—— 2026-11-15 ✅ 10/10

环境：`WeChat-4.1.15.app`（gadget, 27042）+ 新编译 onebot（-stream_token=dev-smoke）。
onebot 启动干净：脚本全量加载、hook 全就位、无 ERROR/panic。

| 步骤 | 预期 | 结果 |
|---|---|---|
| capabilities（带 token） | 200 + 全量能力 | ✅ |
| capabilities（无 token） | 401 | ✅ |
| 创建会话 | 201 reserved + stream_path | ✅ |
| 同 Idempotency-Key 重放 | 返回原 call_id | ✅ |
| 同 key 不同参数 | 409 idempotency_conflict | ✅ |
| 不支持格式(mp3) | 422 unsupported_format | ✅ |
| 创建不连接（10s） | attach_timeout 释放 | ✅ |
| WS attach | hello(v1, progress_scope=submitted_to_wechat) | ✅ |
| 第二控制连接 | 409 control_conflict | ✅ |
| attach 后不 start（10s） | start_timeout 释放 | ✅ |
| 释放后再创建 | 201（锁已还） | ✅ |
| 旧 ID hangup | 幂等返回结束记录 | ✅ |
| 实时会话在场调旧 /hangup_voice_call | 409 call_id_required（设计 §4.4 守卫） | ✅ |
| 清理后旧挂断恢复 | 200 ret=0 | ✅ |
| 旧 /voice_call_status | 200 | ✅ |

（表格 15 行含复测；判定口径 10 项全过。期间日志无 ERROR/panic。）

遗留观察：无。

### 轮 B：真实通话双向流 —— 2026-11-15 ✅（经 4 轮迭代，发现并修复 5 个真 bug）

对端：ludaohe 手机 ×3 轮 + hundun(mac-m1 入站自动接听) ×1 轮。引擎每通协商不同
（16k/48k 都出现），重采样均正确工作。

| 验证项 | 结果 |
|---|---|
| 拨号→接通（put_ready_inferred） | ✅ 三通均命中，人工接听 ~5s / 自动接听 ~3s |
| 引擎格式现读 | ✅ 16k(960B/640B) 与 48k(1920B/1920B) 两种协商都正确 |
| 上行实时提交 | ✅ consumed 平滑爬升无倒退；90s 流 consumed=137.8 万样本=86.1s，与墙钟吻合 |
| 下行采集 | ✅ 三通累计 ~5900 帧 gap=0，0 丢帧 |
| 打断 clear→cleared→新代 | ✅ dropped=352 如实上报，旧代无泄漏，segment#2 从 seq=0 重启 |
| commit→segment_done | ✅ 真机首通（scope=submitted_to_wechat） |
| 本地挂断 local_hangup | ✅ hangup_ret=0, released=true |
| 远端挂断 remote_hangup | ✅ startTalk<1 → remote_end_hint → 正确判因 |
| 断连清理 | ✅ WS 断→挂断→释放（首轮实测 client_disconnected） |
| 未初始化拨号 | ✅ 微信重启 25s 内拨号：Go 侧重试 ~20s 后成功 |
| 进度口径 | ✅ progress/done 全程 `submitted_to_wechat`；submitted==src（在途 <20ms 如实披露） |

**冒烟发现并修复（全部回归验证）：**
1. Go 序号验证无在途窗口 → ack 延迟 > 发送间隔时级联 invalid_seq 且不可恢复。
   修复：每个 in-flight pending 允许一个后继 seq；真跳号仍拒绝并回 expected_seq；
   同 seq 在途重发拒为 temporarily_unavailable（防 JS 双播）。
2. JS `vsSrcSubmitted` checkpoint 耗尽后归零（consumed 288→0 倒退）。修复：基值持久化。
3. JS `stopped` 事件在会话置空后发出 → 丢 callId → released=false → manager 误标
   unhealthy。修复：显式携带 callId。
4. 微信重启后 VoIP 客户端延迟初始化（[+0x28]≠1）→ 立即拨号必败。修复：Go 对
   "未初始化" 1s×20 重试。
5. 联调客户端三处：日志格式串、websockets 17 参数名、recv_loop 垄断主循环导致
   clear/定时挂断成死代码 → 重构为后台 recv + ack 驱动序号 + expected_seq 重同步。

### 轮 C：端到端音质分析（mac-m1 入站录音）—— 2026-11-15 ✅

方法：本地拨 hundun，mac-m1 生产链路 `/voice_call_inbound record:true` 自动接听并录
下行（= 本地注入的 440Hz 纯音；本地 mic 已 mute，录音即注入内容本身），WAV 拉回本地
分析（`call_inbound_1794751691.wav`，19.68s @16k mono s16le）。

| 指标 | 结果 | 判定 |
|---|---|---|
| 占空比（20ms 帧） | **99.9%**（984 帧仅 1 洞） | ✅ 远超旧文件播放路线（59% 病灶口径） |
| 音调 | 440Hz 显著占优（谐波比 0.08~0.36） | ✅ 频率经 16k→48k→空口→16k 保真 |
| 幅度 | peak=8961（源 8000）、-21 dBFS，无削波 | ✅ |
| clear 断点 | 6-10s 唯一跳变 t≈7.1s（裁头对齐后即 clear 点），Δ一帧 | ✅ 单点干净断开，无重复中断 |
| 实时性 | 录音 19.68s ≈ hold 20s | ✅ 空口全程实时，无慢放/快放 |
| 双向同时 | 播放全程下行采集 953 帧 gap=0 | ✅ 无互斥、无自声回灌迹象（录音无杂音成分） |

**已知非阻塞问题**：48k 通话时 JS 重采样 CPU 使 ack 延迟偶发 → 在途守卫
`temporarily_unavailable` 重试（全部自动恢复，吞吐守住实时）。后续优化：sinc 查表。

### 轮 C2：真实对话场景（TTS 流式播报 + 对端停顿说话）—— 2026-11-15 ✅

场景：本地 TTS（say/ffmpeg, 16.1s 中文段）流式播给 ludaohe，播完 commit → 停 5s →
从头重播，共 3 遍整段 + 第 4 遍 4s 后本地挂断；对端约定只在停顿期念文字。
本地 `--record` 录对端下行（/tmp/user_voice_test.wav, 70.4s @24k）。

| 验证项 | 结果 |
|---|---|
| TTS 流式播报 | ✅ 3 遍整段逐字流出（16.1s@16k → 引擎 16k, consumed=258240/遍精确） |
| 播报→停顿节奏 | ✅ 播完 commit→segment_done(16.1s 精确)→5s 静默→重播 |
| 对端语音落在停顿窗 | ✅ 3 个停顿窗全部检出语音块；播报窗回传近乎纯静音（对端 AEC 无自声回灌） |
| 录音 | ✅ 70.4s 全程 gap=0；对端语音可回放 |
| 收尾 | ✅ local_hangup, hangup_ret=0, released=true |
| 已知噪音 | 客户端重复 commit → 服务端 empty_segment 精确拒绝（无数据影响）；待清理 |

结论：流式接口可承载真实 ASR→TTS 对话形态；停顿期采集对端语音质量足够回放辨认。
**用户侧验收（2026-11-15）：三遍播报均清晰，无断续、无杂音 —— 真实对话形态通过。**

### 轮 D（待做）：验收矩阵剩余项

- 连续快速打断 20 次（协议自动化已覆盖，真机未做）
- 拒接/忙线事件标定（气泡解析，capabilities 仍标 false）
- 5 分钟硬时限真机验证 + 多通后 goroutine/内存增长
- media_overflow 真机注入、未授权/第二连接真机复测（协议自动化已过）

## 5. 待定事项

- 部署 mac-m1：本地冒烟已全过；上线须固定证书重签 + "重启微信→登录→起新 onebot"
  一次到位；`-stream_token` 与 wxgate `onebot_stream_token` 配对；轮 D 剩余项可在
  生产环境补测。
- 拒接/忙线识别未实现（capabilities 如实标 false）——气泡解析标定后才能承诺。
- 优化备选：JS sinc 查表降 CPU（48k 通话 ack 抖动根因）；clear 后 acceptedChunks
  统计未按代清零（仅口径美化）。
- git 提交：两个仓库改动均未提交（weixin-macos 主改动 + wxgate 代理 + go.mod/go.sum）。
