# 微信实时语音流 API — mumble 接入文档（协议 v1）

日期：2026-11-17。对象：mumble（或任何调用方）。
底层原理与设计取舍见 `docs/VOIP-STREAMING-DESIGN.md`，实施进度见 `docs/VOIP-STREAMING-PROGRESS.md`。
参考实现（可直接跑的联调客户端）：`tools/voip/stream_client.py`。

## 0. 一句话总览

一通微信 VoIP 里，调用方通过**一条 WebSocket** 持续收对方声音（`audio.input`，喂 ASR）、
持续发我方声音（`audio.append`，接 TTS）、可随时**打断**（`audio.clear`）、能看到播放进度、
正常挂断。呼出（`mode:"stream"`）与呼入自动接听（`mode:"incoming_stream"`）协议完全一致。

## 1. 接入要素

| 项 | 值 |
|---|---|
| 基址 | wxgate `http://127.0.0.1:36060`（与 wxgate 同机；跨机走部署方反代） |
| 鉴权 | `Authorization: Bearer <voice_api_token>`（= `~/Prog/wxgate/.stream_token` = config.yaml `voice_api_token`） |
| 协议版本 | 1（hello 与 capabilities 都会回带） |
| 音频格式 | 裸 PCM `s16le` mono，base64 编码，无 WAV 头；上行/下行采样率各自在创建时协商（16k/24k/48k） |
| 全局限制 | 同一时刻全系统一通电话（与旧文件通话/旧入站接听互斥，占线返回 409 `call_busy`）；**呼出优先**（2026-11-18）：占槽者是待机布防窗口（未接过任何来电）时，呼出会自动解除布防并放行，只有真通话（拨号/接通/响铃/结束中）才 409 |
| 硬时限 | 通话 ≤300s（从拨号/接通计）；服务端心跳 ping 10s、pong 30s 未响应判死 |

所有路由（capabilities/创建/WS/状态/挂断）都要带 token；无 token 时路由整体 fail-closed（503）。

## 2. HTTP 接口（经 wxgate，路径带 `/api` 前缀）

### 2.1 GET /api/voice_calls/capabilities

能力自述。**调用方应按它编程，不要按本文档硬编码**。关键字段：
`modes`（`["outbound_stream","incoming_stream"]`）、`input_formats/output_formats`
（pcm_s16le mono，16000/24000/48000）、`queue`（目标 200ms/硬上限 1000ms）、
`max_duration_s: 300`、`heartbeat`、`progress_scope: "submitted_to_wechat"`、
`rejected_event/busy_event: false`（未实现，见 §7）、`backend_healthy`。

### 2.2 POST /api/voice_calls —— 创建会话（不拨号/不等待，只预留）

```json
{
  "user_id": "wxid_xxx",            // 呼出=对方 wxid; 呼入=占位符(真实主叫看 ringing 事件 caller_wxid)
  "source": "mumble",               // 必填, 调用方标识, 审计用
  "mode": "stream",                 // "stream"=呼出 | "incoming_stream"=呼入布防
  "ring_timeout_s": 60,             // 呼出: 等接听上限(≤60)
  "max_duration_s": 300,            // 通话上限(≤300)
  "input_format":  {"codec":"pcm_s16le","sample_rate":16000,"channels":1},  // 我方发出去的
  "output_format": {"codec":"pcm_s16le","sample_rate":24000,"channels":1},  // 对方进来收到的
  // ↓ 仅 incoming_stream
  "window_s": 300,                  // 布防窗口(≤600): 无来电自动释放
  "answer_delay_ms": 1200,          // 来电后延迟接听
  "mute_mic": true,                 // 接听后静音本机麦克风(默认 true)
  "mic_gate": true                  // 门控麦克风生产源(默认 true, 必开否则对方听到断续)
}
```

- 成功 **201**：`data.call_id`、`data.stream_path`（WS 地址）、`data.attach_deadline_ms`。
- 建议带 `Idempotency-Key` 头（≤128 字符）：同 key 同参数重放返回原会话，不同参数 409。
- 错误：`422 unsupported_format`（格式/参数越界）、`409 call_busy`（全局占线；message 带
  占用者描述与预计释放时间，2026-11-18 起）、
  `409 idempotency_conflict`、`503 backend_unhealthy`（上一通清理未确认，需重启 onebot）。
  调用方（如 mumble）呼出被 409 拒绝只发生在真通话占槽——待机布防窗口会被服务端自动解除，
  **无需先解除布防再呼出**；呼出期间布防调用得到 409 属预期，循环重试即可。
- **预留超时**：呼出创建后 10s 内必须连 WS，连上后 10s 内必须 `call.start`，否则自动释放；
  呼入（incoming_stream）按 `window_s` 计，无来电自动释放（结束原因 `window_expired`）。

### 2.3 WS /api/voice_calls/{call_id}/stream —— 唯一控制连接

升级时同样带 Authorization 头。**第二个连接 → 409 `control_conflict`**。
连接建立即收到 `hello`（携带 direction/in_formats/queue 上限/心跳参数等，
呼入还会一直活到 `window_s` 到期）。

### 2.4 GET /api/voice_calls/{id} —— 状态/结束记录

活跃会话返回实时快照（state/queued_ms/计数/`caller_wxid`/engine_format 等）；
已结束的会话在 **10 分钟保留期**内返回结束记录（end_reason/stats/resources_released），
之后 404。

### 2.5 POST /api/voice_calls/{id}/hangup —— 挂断（幂等）

活跃会话 → 触发挂断；已结束 → 原样返回结束记录；不存在/过期 → 404。
呼出响铃中挂断=取消拨叫；呼入布防中挂断=解除布防（不拒接当前来电）。

## 3. WS 消息协议

通用：客户端命令带 `request_id`（回显用）；服务端事件带 `call_id/event_seq/t_ms`。
所有音频 `seq` 在 generation 内从 0 连续递增（跨 segment 不归零）；`generation` 从 1 起，
每 clear +1。

### 3.1 客户端 → 服务端

```jsonc
// ① 呼出: 开始拨号(呼入模式发它=幂等确认, 不拨号)
{"type":"call.start","request_id":"s1"}

// ② 上行音频(20ms 一块, 640B@16k; ≤9600B 解码后)
{"type":"audio.append","request_id":"a-1","generation":1,
 "segment_id":"seg-1","seq":0,"audio_b64":"…"}
// 规则: seq 必须 == 下一期望(乱序/跳号 → invalid_seq+expected_seq);
// 同 seq 同数据重发 → 幂等 accepted; 同 seq 不同数据 → seq_conflict;
// 队列满 → buffer_full(retryable, 不消耗 seq, 原 seq 重发);
// 同 seq 在途确认中 → temporarily_unavailable(retryable)

// ③ 段提交(不挂断、不代表播放完): last_seq 必须等于该段最后一块
{"type":"audio.commit","request_id":"c-1","generation":1,
 "segment_id":"seg-1","last_seq":806}

// ④ 打断: 停止旧代播放+清队列; new generation 必须是当前+1
{"type":"audio.clear","request_id":"x1","generation":2}

// ⑤ 挂断(任何状态)
{"type":"call.hangup","request_id":"bye"}
```

### 3.2 服务端 → 客户端

```jsonc
// 连接后第一条
{"type":"hello","protocol_version":1,"state":"reserved","direction":"outbound|incoming",
 "input_format":{…},"output_format":{…},"input_source":"remote_downlink",
 "progress_scope":"submitted_to_wechat","segment_done_scope":"submitted_to_wechat",
 "remote_heard":false,"queue":{"target_ms":200,"hard_ms":1000,"input_max_frames":128},
 "heartbeat":{"ping_s":10,"pong_timeout_s":30},
 "clear":{"onebot_queue_clear":true,"native_buffer_clear":false,"sdk_residual_upper_ms":null},
 "limits":{"max_chunk_bytes":9600,"control_rate_per_s":20,"inflight_appends":8}}

// 状态迁移(呼出: dialing→connected; 呼入: ringing→connected)
{"type":"call.state","event_seq":2,"t_ms":123,"state":"dialing","request_id":"s1"}
{"type":"call.state","state":"ringing","caller_wxid":"wxid_主叫","room_known":true}
{"type":"call.state","state":"connected","answer_detection":"put_ready_inferred|accept_inferred",
 "engine_format":{"engRate":16000,"engCh":1,"frameMs":20,"frameBytes":960,
                 "payloadBytes":640,"payloadSamples":320,"capRate":16000,"pullBytes":640}}

// 上行入队确认(=accepted; request_id 回显你的 append)
{"type":"audio.accepted","request_id":"a-1","generation":1,"segment_id":"seg-1",
 "seq":0,"queued_ms":20,"scope":"queued_in_onebot"}

// 播放进度(每 100ms, 有变化才发) —— 口径=已成功提交给微信引擎, 不是对方已听到
{"type":"audio.progress","generation":1,"segment_id":"seg-1",
 "consumed_samples":1600,"submitted_native_samples":1600,"queued_ms":20,
 "scope":"submitted_to_wechat"}

// 段提交完成(该段全部形成引擎帧且最后一帧 ret==0; 被 clear 的段不发)
{"type":"audio.segment_done","generation":1,"segment_id":"seg-1",
 "consumed_samples":257920,"submitted_native_samples":257920,
 "scope":"submitted_to_wechat"}

// 对方声音(50 帧/s @20ms; rate=你创建时选的 output_format.sample_rate)
{"type":"audio.input","seq":1,"sample_offset":0,"rate":24000,"samples":480,
 "gap":{"frames":0,"missing_samples":0},"audio_b64":"…"}
// gap 为累计值(与上一帧做差得本次丢失); 播放/打断期间采集不停

// 打断完成(此后旧 generation 的任何 append 一律 stale_generation 拒绝)
{"type":"audio.cleared","request_id":"x1","old_generation":1,"new_generation":2,
 "final_progress":{"segment_id":"seg-1","consumed_samples":7200},
 "dropped_samples":18400,"onebot_queue_empty":true,
 "old_generation_future_submissions":false,
 "native_submitted_reclaimable":false,"sdk_residual_upper_ms":null}

// commit 的同步回执
{"type":"result","request_id":"c-1","ok":true,"op":"commit"}

// 非致命错误(会话继续; 按 code/retryable 处理, 见 §5)
{"type":"error","request_id":"a-2","fatal":false,
 "error":{"code":"buffer_full","message":"播放队列已满","retryable":true,"queued_ms":995}}

// 终局(之后服务端关闭 WS)
{"type":"call.ended","reason":"local_hangup","resources_released":true,
 "stats":{"duration_ms":75389,"caller_wxid":"…","room_id":"…",
          "input":{"frames":3518,"gap_frames":0,"gap_missing_samples":0,"dropped_frames":0},
          "output":{"submitted_native_samples":850240,"consumed_samples":850240,
                    "accepted_chunks":2661,"queued_ms_final":23},
          "generation":2,"next_seq":2661,"hangup_ret":"0"}}
```

### 3.3 心跳

服务端每 10s 发 WS ping；客户端**必须回 pong**（任何标准 WS 库都自动回）。
30s 没有任何收到 → 服务端判半开 → 挂断（`client_disconnected`）。**P0 无断线恢复**：
WS 断开 = 立即停止播放并挂断，需要继续就重新创建新 call_id。

## 4. 标准接入姿势

### 4.1 呼出（AI 主动打给用户）

```
1. POST /api/voice_calls  {mode:"stream", user_id:目标, formats…}      → 201
2. 连 stream_path 的 WS（10s 内），收到 hello
3. 发 call.start；等 call.state(connected) —— engine_format 里带引擎采样率
4. 双向循环:
   · TTS 出一段 → 切 20ms 块 audio.append（按 accepted/queued_ms 限速,
     队列控制在 100~200ms）→ 段尾 commit → (可选)等 segment_done
   · audio.input → 喂 ASR
   · 用户插话(VAD) → audio.clear(generation+1) → 等 audio.cleared → 发新内容
5. 结束: audio.commit 最后一段 → call.hangup → 收 call.ended
```

### 4.2 呼入（用户打进来，AI 接听）

```
1. POST /api/voice_calls  {mode:"incoming_stream", window_s:300, …}    → 201
2. 连 WS 收 hello(direction=incoming)，然后什么都不用发，等:
3. call.state(ringing) → 记下 caller_wxid（这是真实主叫，用它关联用户上下文）
4. call.state(connected)（服务端已自动接听）→ 进入与 4.1 第 4 步相同的双向循环
5. 挂断/超时/对方挂断 → call.ended（reason=remote_hangup 表示对方先挂）
```

要点：布防会话在 `window_s` 内长期存在（WS 心跳保活）；一个布防只接一通电话，
接完即结束——连续接听请重新创建。mumble 现网部署请在收到 `window_expired`/
`client_disconnected` 后自动重建布防。

### 4.3 打断（barge-in）时序

```
检测到用户说话 → 立即停止向旧 generation append
→ 发 audio.clear{generation: N+1} → 收 audio.cleared(dropped_samples=丢弃量)
→ 新内容从 generation N+1 的 seq=0 开始 append
```

clear 只保证：onebot 队列清空 + 旧代不再提交。**已提交给微信引擎的那一帧（≤20ms）
不可撤回**；对端从听到到停声还有引擎/网络侧残留，`sdk_residual_upper_ms` 为 null
（上界未知，如实披露）。mumble 截断 ASR 上下文用 `final_progress.consumed_samples`
（该代实际播出去的位置）。

## 5. 错误码与处理

| code | 时机 | 处理 |
|---|---|---|
| `buffer_full` | 队列超 1000ms/在途窗满 | **同 seq 原样重发**（等 queued_ms 回落） |
| `temporarily_unavailable` | 同 seq 在途/clear 清理中 | 稍后重试（clear 场景等 cleared 后原 seq 重发） |
| `invalid_seq` | 跳号/超在途窗 | 带 `expected_seq` → **跳到该 seq 重发** |
| `seq_conflict` | 同 seq 不同数据 | 客户端 bug, 检查分块一致性 |
| `stale_generation` / `invalid_generation` | 旧代/未来代 | 丢弃该块（被打断的旧内容） |
| `segment_not_committed` / `empty_segment` | 段顺序错/重复 commit | 修正段管理 |
| `invalid_state` | 未 connected 就 append 等 | 等状态事件 |
| `rate_limited` | 控制命令 >20/s | 退避 |
| `invalid_message` | JSON/格式错 | 修正编码 |
| `backend_error` | 引擎异常/拨号失败/ack 超时 | 致命, 等 call.ended |

HTTP 错误：401 `unauthorized` / 403 `forbidden`(Origin) / 404 `not_found` /
409 `call_busy`+`idempotency_conflict`+`control_conflict` / 422 `unsupported_format` /
500 `backend_error` / 503 `backend_unhealthy`。错误响应形如
`{"status":"failed","error":{"code":"…","message":"…","retryable":…}}`。

## 6. 结束原因（call.ended.reason）

`local_hangup`（我方/客户端挂）· `remote_hangup`（对方先挂）· `ring_timeout`（呼出没人接）
· `window_expired`（呼入布防到期无来电）· `duration_limit`（300s 到）·
`client_disconnected`（WS 断开）· `dial_failed`（拨号失败）· `attach_timeout`/`start_timeout`
（预留后未及时连接/启动）· `media_overflow`（下行持续积压）· `backend_error`（引擎异常）
· `remote_end_unknown`（引擎侧消失但无法确认是对方挂断）。
**rejected/busy 未实现**（主叫拒接/忙线目前只能等到 ring_timeout）。

## 7. 与旧接口的关系

- 旧 `/api/send_voice_call`（整段文件播放）与实时流并存，全局锁互斥。
- **实时会话存活期间，旧 `/api/hangup_voice_call` 返回 409 `call_id_required`**——
  呼入布防挂在实时会话上，取消布防请用 scoped hangup。
- 旧 `/api/voice_call_inbound`（录音式自动接听）与流式布防互斥，同一时刻只能布一个。

## 8. 语义边界（务必读）

1. `progress/segment_done` 的口径是 **submitted_to_wechat**（已成功提交给微信引擎），
   不是"对方设备已播放"。mumble 做上下文截断够用，别当播放完成承诺。
2. `audio.cleared` 只保证 onebot 队列清空与旧代不再提交；已提交帧（≤20ms）与
   SDK/网络残留不可撤回，`sdk_residual_upper_ms=null`（未知）。
3. 引擎真实采样率（engRate/engCh/frameMs）**只能在 connected 事件的 engine_format 里拿到**，
   创建响应里的 engine_format 恒为 null。上行/下行重采样由服务端完成，客户端按
   自己创建时声明的采样率收发即可。
4. 接通与呼入接听都是 **inferred**（出站=静音探测帧被引擎消费；入站=Accept 后引擎就绪），
   非原生信令。
5. 不录音、不落盘、日志不含音频内容；`stats` 只有计数。
6. 全局一通电话；创建/布防即占锁，结束（含布防解除）即释放。
