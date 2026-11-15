# 微信 VoIP 实时双向流式 API 详细设计

日期：2026-11-15  
状态：P0 代码已实现（阶段 1–3，自动化测试全绿含 -race）；阶段 0 能力补证与阶段 4 真机验收**未做，勿投产**  
范围：`weixin-macos/onebot` 底层能力 + `wxgate` 对外代理契约  
需求来源：`wxgate-streaming-voice-requirements.md`  
实现落地：`onebot/voice_stream.go` / `voice_stream_ws.go` / `voice_stream_protocol.go` /
`voice_stream_bridge.go` / `voice_stream_test.go`、`onebot/script.js`「VoIP 实时流式分区」、
`onebot/main.go`（路由 + voip_stream 消息分发 + `-stream_token`/`-stream_origins`）、
`onebot/voice_call.go`（旧 hangup 409 守卫）、`tools/voip/stream_client.py`、
wxgate `handler_call_stream.go` + `config.go`（voice_api_token/onebot_stream_token/Origin）

## 0. 结论先行

现有原生媒体通路可以复用：主动拨号、挂断、按引擎格式逐帧注入、持续拉取下行动态 PCM、同通播放与采集都已打通。实时模式应当**新增一套流式会话与媒体调度层**，而不是逐块调用 `/send_voice_call`，也不是把旧文件播放接口简单包成 WebSocket。

但“路都是通的”只适用于原生媒体原语，以下能力目前并不具备或不能被现有计数证明：

1. JS→Go 没有 VoIP 音频流和结构化事件回调；下行目前直接写文件。
2. 播放源是整段 PCM，现有 `bytesSent/calls/eof` 是喂入侧计数，不是设备消费或对端播放进度。
3. 没有 `audio.clear`；可以清空尚未提交的 JS 数据，但不能撤回已经进入微信原生链路的帧。
4. 接通主要靠注入错误码消失推断；`startTalk` 在响铃期就可能大于零，不能直接当接听。
5. 拒接、忙线没有完整结构化事件；旧文档明确存在拒接/未接最终都走超时的限制。
6. 旧播放和采集 tick 都有忙等自旋，双向流时可能挡住 `clear`、RPC 和音频消息，新路径必须去掉。
7. wxgate 当前 `/api/*` 没有统一调用方鉴权；“复用现有鉴权”应改为“为新实时 API 新增鉴权”。

因此建议按“**保留原生入口，重写其上的流式层**”实施。P0 可以对外提供实时双向 PCM 流，但必须真实披露进度和 clear 的边界；拒接/忙线识别是 P0 完整验收前的专项补齐项，不能伪造。

---

## 1. 目标与边界

### 1.1 P0

- 一对一主动拨出。
- 全局同一时刻一通电话；实时、旧文件出站、入站接听共用底层互斥。
- 单通一个控制 WebSocket，不做断线恢复。
- 持续接收远端下行 PCM，同时持续提交上行 PCM。
- 支持 segment、generation、顺序校验、幂等重传、commit、clear、hangup。
- 有界队列、显式背压、输入丢帧 gap、心跳、5 分钟硬时限。
- 不识别、不合成、不做 VAD，不依赖 ASR/LLM/TTS。
- 默认不录音、不落盘、不记录 PCM/base64。

### 1.2 P1

- 来电接听复用同一会话、队列和协议层，增加 `incoming` 创建/布防入口。
- 二进制 WebSocket 音频帧。
- 更长的通话时限、断线恢复、多客户端。
- 词级时间戳、远端真实可闻位置、原生队列精确 drain。

### 1.3 明确不做

- 不逐块调用旧 `/send_voice_call`。
- 不在每帧启动 ffmpeg，不写每帧临时文件。
- 不把整段文件 EOF 当实时播放进度。
- 不在生产微信上挂额外探针；事件和格式核查先在开发副本完成。
- 不把“提交给微信”命名为“对方已经听到”。

---

## 2. 当前能力核对

| 能力 | 当前事实 | 证据/限制 |
|---|---|---|
| 原生拨号/挂断 | 已有 | `onebot/script.js:2509-2534`；拨号 ret 只表示请求成功，不代表振铃或接听 |
| 持续上行注入 | 已有原生逐帧路径 | `onebot/script.js:2852-2859`；每次 `PutExternalRecordData` 只吃一个引擎帧 |
| 持续下行采集 | 已有 | `onebot/script.js:2944-3059`；当前 PCM 写文件，不是流回调 |
| 同通播放与采集 | 已有通话级并行 | 两套会话和定时器可并存；尚未证明实时桥接延迟和自声回灌 |
| 下行格式 | mono、16-bit，最终转 little-endian | 采样率、帧长、每拉字节数按每通引擎字段读取；16k/48k 都出现过 |
| 下行来源 | `GetAudioData` 解码下行，供“听对方” | 代码没有主动混入上行；是否绝对无侧音/混音仍需真实回环验收 |
| JS→Go 流式回调 | 通用 `send()` 机制有，VoIP 未接 | `onebot/main.go:221-251`；VoIP 分区当前只改内存状态/写文件 |
| 上行软件队列 | 整段 `playU8` + 单帧 staging | 不是有界流式队列 |
| 播放位置 | 只有喂入侧 offset/calls | 某些非零返回也推进旧计数，不能当成功提交或消费位置 |
| clear | 没有 | 可停止后续提交；原生已提交帧不可撤回，SDK/网络残留上限未知 |
| 接通 | 注入等待码消失后推断 | `startTalk` 不能独立判断；纯聆听模式不能依赖客户端先发声 |
| 振铃 | 无可靠判据 | 本机音频 beacon 不能证明对端振铃 |
| 拒接 | 可从 VoIP 气泡观察到文本 | 尚未形成 onebot 结构化、与 call_id 关联的事件 |
| 忙线 | 无可靠识别 | 拨号 ret 仍可能为 1 |
| 远端结束 | `startTalk<1`、engine-lost 等间接推断 | 需与本地主动挂断和引擎异常区分 |
| wxgate API 鉴权 | 新实时路由所需能力不存在 | 现有 Secret 用于 onebot 回调验签，不是 `/api/*` 调用方鉴权 |

补充事实：frida-go 已支持 `Script.Post(json, data)` 二进制附件，也支持 `script.On("message", func(message string, data []byte))`。外部协议可以继续使用 JSON+base64，Go↔JS 内部不必再做 base64 或 JSON 数字数组。

---

## 3. 总体架构与职责

```text
mumble / Python 联调客户端
        │  对外 JSON WebSocket，PCM base64
        ▼
wxgate
  - 新增调用方 Bearer 鉴权、Origin 校验
  - HTTP 路径映射与 WS 反向代理
  - 不解码/重编码 PCM，不增加无界缓冲
  - 对外 stream_path、访问日志、审计
        │  本机内部 WS，独立 internal token
        ▼
onebot / Go：实时会话权威层
  - call_id、幂等、预留锁、状态机、硬时限
  - 单 WS、request_id、generation/segment/seq 去重
  - 有界入站队列、事件序号、统计、清理
  - Go actor 串行化同一 call 的命令
        │  Frida Post/recv：控制 JSON + PCM 二进制附件
        ▼
onebot / script.js：实时媒体引擎
  - 原生拨号、接听推断、格式读取、mute、挂断
  - 有界上行队列、连续重采样、逐帧 Put
  - GetAudioData、字节序归一、连续下行重采样
  - accepted/progress/done/cleared/input/state 事件
        ▼
微信 ConfSDK / 原生音频引擎
```

### 3.1 为什么 onebot Go 是权威层

- 只有底层知道旧文件通话、入站接听和 Frida session 的真实占用，全局锁必须在 onebot。
- `call_id`、创建幂等和 scoped hangup 在 onebot 实现，直连底层联调也具有相同安全语义。
- wxgate 不再另建一套可能漂移的通话状态；它只做鉴权、代理和对外审计。
- onebot 的 5 分钟计时是权威保险；wxgate 可选增加 305 秒的 scoped 兜底，不允许再调用无 ID 的旧 hangup 杀新通话。

### 3.2 为什么媒体队列放在 JS，协议去重放在 Go

- JS 最靠近引擎格式、20ms tick 和原生返回值，能给出真实的“已入 JS 队列”和 `ret==0` 的提交事件。
- Go 在解码外部 base64 后先做消息大小、序号和 SHA-256 去重，避免重复 PCM 进入 JS。
- 每个 append 在 JS 明确 accepted 前是 Go 的单个 pending 命令，不推进 next seq；因此 `buffer_full` 可以安全地用同 seq 重试。
- 同一 call 的 Go actor 和 JS 消息处理都按顺序执行，不在两条通道上混排 append/clear。

---

## 4. 对外与内部 HTTP 契约

onebot 使用不带 `/api` 的同名路径；wxgate 做一一映射。

| 对外 wxgate | onebot 内部 | 说明 |
|---|---|---|
| `GET /api/voice_calls/capabilities` | `GET /voice_calls/capabilities` | 实时能力和健康状态，不做静态假广告 |
| `POST /api/voice_calls` | `POST /voice_calls` | 预留全局锁，不拨号 |
| `WS /api/voice_calls/{call_id}/stream` | `WS /voice_calls/{call_id}/stream` | 单控制连接 |
| `GET /api/voice_calls/{call_id}` | `GET /voice_calls/{call_id}` | 当前或保留的结束记录 |
| `POST /api/voice_calls/{call_id}/hangup` | `POST /voice_calls/{call_id}/hangup` | 幂等、scoped hangup |

协议版本固定为 `1`。响应沿用 `status/retcode/data`，错误另外带稳定的 `error.code`，调用方不得解析中文 message。

### 4.1 创建会话

请求保持需求文档的 `user_id/source/mode/ring_timeout_s/max_duration_s/input_format/output_format`。

约束：

- `mode` 只接受 `stream`。
- `source` 必填，1～64 字符，仅用于审计。
- `ring_timeout_s` 默认 60，允许 1～60。
- `max_duration_s` 默认 300，允许 1～300，从开始拨号计时；预留时间另算。
- 外部格式 P0 只接受 `pcm_s16le`、mono、16000/24000/48000Hz。
- 输入、输出外部采样率可以不同；创建时固定，不在通话中变更。
- `Idempotency-Key` 可选；调用方一旦携带，onebot/wxgate 必须实现下述幂等语义。建议 mumble 总是携带，key 最长 128 字符。
- 相同 key + 相同规范化参数返回原 call_id 和原响应，即使原会话已结束也不重新拨号。
- 相同 key + 不同参数返回 409 `idempotency_conflict`。
- 幂等记录保留 10 分钟，最多 128 条，超出容量时拒绝新 key 而不是悄悄提前失效；通话结束记录同样保留 10 分钟。

成功返回 201，例如：

```json
{
  "status": "ok",
  "retcode": 0,
  "data": {
    "protocol_version": 1,
    "call_id": "7a8b8f0d-6b7d-4f0f-9e3d-4b0f0d1ac001",
    "state": "reserved",
    "stream_path": "/api/voice_calls/7a8b8f0d-6b7d-4f0f-9e3d-4b0f0d1ac001/stream",
    "input_format": {"codec":"pcm_s16le","sample_rate":16000,"channels":1},
    "output_format": {"codec":"pcm_s16le","sample_rate":24000,"channels":1},
    "engine_format": null,
    "format_status": "pending_dial",
    "attach_deadline_ms": 1763200000000
  }
}
```

`attach_deadline_ms` 是 Unix epoch 毫秒；WebSocket 内的 `t_ms` 是另一套单调相对时钟。

**格式差异说明**：引擎格式只有拨号后、接通附近才可读取，创建和 hello 不可能提前给出“实际原生协商格式”。创建/hello 返回的是已固定的外部格式，`engine_format:null`；`connected` 事件再填真实引擎格式。若引擎出现不支持的新格式，明确报 `backend_error/unsupported_engine_format`，不静默假定 16k。

### 4.2 锁与预留超时

- 创建成功即持有全局通话 owner，状态 `reserved`，但不调用任何原生拨号函数。
- 10 秒内未 attach：自动释放预留，记录结束原因 `attach_timeout`。
- attach 后 10 秒内未收到 `call.start`：结束为 `start_timeout`，避免客户端连上后永久占锁。
- 第二个控制连接：409/WS `control_conflict`，不能抢走第一个连接。
- 创建但从未 start 的会话不拨号，也不需要调用原生挂断。

### 4.3 状态查询与保留

状态至少包括：

- `state/end_reason/end_detection/resources_released/backend_healthy`。
- 外部格式、真实引擎格式。
- 当前 generation/segment。
- `queued_ms`、`received_samples`、`consumed_samples`。
- `submitted_native_samples`、`dropped_output_samples`。
- 输入 `received/dropped_samples/gap_count`。
- `last_event_seq`、各阶段时间、错误码。

### 4.4 scoped hangup

- 仅操作 URL 中的 call_id；不存在返回 404，已结束返回原结束结果。
- 旧 call_id 不可能挂断新通话。
- 实时通话期间，旧 `/hangup_voice_call` 返回 409 `call_id_required`，避免旧硬时限定时器误杀新实时通话。
- 旧文件通话仍走原逻辑，保持兼容。

---

## 5. WebSocket 协议

### 5.1 通用规则

- P0 仅 JSON 文本帧；PCM 是 base64 编码的裸 `pcm_s16le`，无 WAV 头。
- 客户端命令：`type/request_id` 必填；`request_id` 最长 128 字符。
- 服务端事件：`type/call_id/event_seq/t_ms` 必填。
- `event_seq` 从 1 单调递增；状态查询返回最后值。
- `t_ms` 从会话预留成功起算，使用本机单调时钟，不使用 wall clock，不在 start 时重置。
- 所有响应命令回显同一 `request_id`。
- 非致命错误通过 `error` 返回，会话继续；致命错误先 `error(fatal:true)`，再 `call.ended`。
- 服务端单 writer goroutine 写 WS，禁止事件回调和 read loop 并发写。

### 5.2 客户端命令

#### `call.start`

- 仅在 `reserved` 有效；收到后进入 `dialing` 并真正拨号。
- 同 request_id 重放返回缓存结果；重复 start 在 dialing/connected 返回当前状态，不重复拨号。
- start 之前 append 返回 `invalid_state`。

#### `audio.append`

```json
{
  "type":"audio.append",
  "request_id":"a-42",
  "generation":1,
  "segment_id":"reply-1",
  "seq":42,
  "audio_b64":"..."
}
```

- 仅 `connected` 接受。
- generation 从 1 开始；每次 clear 加 1。
- seq 在 generation 内从 0 开始，跨 segment 连续，不重新从 0。
- segment_id 在 generation 内唯一，1～64 字符。
- 同 seq + 同 PCM：幂等返回 accepted，不再次播放。
- 同 seq + 不同 PCM：`seq_conflict`。
- 缺号/乱序：`invalid_seq`，并返回 `expected_seq`；不猜补、不自动插静音。
- `buffer_full` 整块不接受、不消耗 seq；客户端看到队列下降后用同 seq 重试。
- 旧 generation：`stale_generation`；未来 generation：`invalid_generation`。
- clear 清理中的新 generation：`temporarily_unavailable`，收到 cleared 后用原 seq 重发。
- commit 后的新数据：`segment_committed`，重复最后一个已接受 seq 仍可按幂等处理。

Go 保存每个已接受 chunk 的 `(generation,seq) → sha256(pcm)`，相同数据重传才幂等；generation 内保留全部 hash（5 分钟约一万五千块，内存有界），clear 后删除旧代 hash，只保留旧代拒绝标记，不保留 PCM 全文。

#### `audio.commit`

```json
{
  "type":"audio.commit",
  "request_id":"c-42",
  "generation":1,
  "segment_id":"reply-1",
  "last_seq":42
}
```

- 标记该段最后一块，不挂断，也不表示已经提交到微信。
- `last_seq` 必须等于该段当前最后一个已接受 seq；用于暴露客户端漏发。
- 空 segment 返回 `empty_segment`。
- 开始下一 segment 前，上一 segment 必须 commit。
- 同 request_id 或相同段尾重复 commit 幂等。

#### `audio.clear`

```json
{
  "type":"audio.clear",
  "request_id":"clear-7",
  "generation":2
}
```

- 新 generation 必须恰好是旧 generation+1。
- 停止旧代后续提交，清空 onebot 内旧代队列、重采样器和半帧。
- 不打断下行采集，不挂断通话。
- ack 之前新代数据可拒绝为 `temporarily_unavailable`。
- ack 之后旧代迟到数据永远拒绝。
- 同 request_id 重放返回缓存结果；同目标 generation 的重复 clear 返回 `duplicate:true`，不得再次清空已经开始的新代音频。

#### `call.hangup`

与 HTTP scoped hangup 等效，幂等。任何 segment 是否 commit 都不影响挂断。

### 5.3 服务端事件

#### `hello`

包含：

- 协议版本、call_id、state、外部输入/输出格式。
- `input_source:"remote_downlink"`。
- `engine_format:null`（dial 前）。
- `progress_scope:"submitted_to_wechat"`。
- `segment_done_scope:"submitted_to_wechat"`。
- `remote_heard:false`。
- 队列上限、心跳参数、进度周期、clear 能力对象。

#### `call.state`

状态变化立即发送。`connected` 必须带真实引擎格式和接通检测来源：

```json
{
  "type":"call.state",
  "call_id":"...",
  "event_seq":8,
  "t_ms":2350,
  "state":"connected",
  "answer_detection":"put_ready_inferred",
  "engine_format":{"codec":"pcm_s16le","sample_rate":48000,"channels":1,"frame_ms":20}
}
```

#### `audio.input`

```json
{
  "type":"audio.input",
  "call_id":"...",
  "event_seq":19,
  "t_ms":3020,
  "seq":41,
  "sample_offset":19680,
  "audio_b64":"...",
  "gap":{"frames":2,"missing_samples":960}
}
```

- seq、sample_offset 都基于协商后的外部输出格式。
- sample_offset 从 connected 后的流起点计算，包含被丢弃的采样，因此接收方可重建真实时间轴。
- 正常每帧建议 20ms；允许实现按重采样输出边界聚合成固定 20ms。
- gap 只在该帧之前有丢失时出现，包含丢帧数和缺失采样数。
- 播放、clear、无上行数据都不得暂停下行。
- 拉取错误不能伪装成数字静音；真实静音帧仍正常发送。

#### `audio.accepted`

只表示进入 onebot JS 软件队列：

```json
{
  "type":"audio.accepted",
  "request_id":"a-42",
  "call_id":"...",
  "event_seq":20,
  "t_ms":3030,
  "generation":1,
  "segment_id":"reply-1",
  "seq":42,
  "queued_ms":140,
  "scope":"queued_in_onebot"
}
```

#### `audio.progress`

```json
{
  "type":"audio.progress",
  "call_id":"...",
  "event_seq":24,
  "t_ms":3120,
  "generation":1,
  "segment_id":"reply-1",
  "consumed_samples":1440,
  "submitted_native_samples":4320,
  "queued_ms":100,
  "scope":"submitted_to_wechat"
}
```

- 每 100ms 一次，有活动段且位置变化时发送；done/clear 前再发最终值。
- `consumed_samples` 使用客户端 input_format 的采样率，保守、单调、不超过已提交样本。
- `submitted_native_samples` 使用真实引擎采样率，只累计 `PutExternalRecordData ret==0` 的帧。
- 非零返回不得推进位置；重试同一帧，不得静默跳过。
- 进度是“成功提交给微信”，不是设备已消费，也不是远端已听到。

#### `audio.segment_done`

段内所有 commit 数据及重采样尾状态均已形成原生帧，并且最后一帧 `ret==0` 后发送。事件必须包含 `scope:"submitted_to_wechat"`。

这对应“onebot 喂入完成”，不是硬件播放完成。若 wxgate 坚持需求中严格的“本机输出链路播放完成”定义，当前底层应返回 `segment_done_supported:false`，而不是把提交完成改名冒充。建议 wxgate 接受显式 scope 作为 P0 契约。

被 clear 的段不发送正常 done，最终位置只在 cleared 中报告。

#### `audio.cleared`

```json
{
  "type":"audio.cleared",
  "request_id":"clear-7",
  "call_id":"...",
  "event_seq":40,
  "t_ms":4100,
  "old_generation":1,
  "new_generation":2,
  "final_progress":{"segment_id":"reply-1","consumed_samples":7200},
  "dropped_samples":16800,
  "onebot_queue_empty":true,
  "old_generation_future_submissions":false,
  "native_submitted_reclaimable":false,
  "sdk_residual_upper_ms":null
}
```

ack 的真实保证是：onebot 软件队列已空，ack 后不会再对旧 generation 调用原生注入。已经进入 SDK/网络的数据不可撤回，不能写成“远端已立即停声”。

#### `call.ended`

包含标准 reason、detection、统计、`resources_released`。写完后刷新发送队列，再正常关闭 WS。

---

## 6. 生命周期与事件识别

### 6.1 状态机

```text
reserved → dialing → connected → ending → ended
    │          │          │          │
    │          │          │          └─ 资源未确认释放时 backend_healthy=false，全局仍 busy
    │          │          └─ remote end / timeout / disconnect / backend error
    │          └─ ring_timeout / rejected / busy / dial failure
    └─ attach_timeout / start_timeout / local cancel
```

`ringing` 只有取得可靠正信号后才独立上报，否则保持 dialing。

标准结束原因：

- 需求要求：`local_hangup`、`remote_hangup`、`rejected`、`busy`、`ring_timeout`、`duration_limit`、`client_disconnected`、`backend_error`、`media_overflow`。
- 新增：`attach_timeout`、`start_timeout`、`dial_failed`、`remote_end_unknown`。

未知远端结束不能硬映射成 rejected 或 remote_hangup；使用 `remote_end_unknown` 并保留底层观测详情。

### 6.2 接通检测的 P0 方案

纯双向 AI 通话通常先听对方，不能等客户端首个音频 append 才判断接听。建议采用**仅出站模式的静音就绪探测**：

1. call.start 后启动原生拨号与格式/引擎监控。
2. 不提交客户端音频；以现有等待码重试逻辑，每 200ms 尝试一个无内容的数字静音探测帧。
3. 等待码期间不发送 connected，不推进任何客户端进度。
4. 首次 `ret==0` 后重读引擎格式、执行 mute，标记 `connected(answer_detection=put_ready_inferred)`。
5. 从此刻才开始对外下行 sample_offset，允许 append。

这是对现有出站播放等待机制的复用，不是新的原生接听事件；必须在 capabilities/hello 标为 inferred。禁止把该方案搬到接听方，文档已明确接听前试探帧有副作用。

长期可替换成真正的原生接听回调，协议不变。

### 6.3 拒接、忙线与远端挂断

P0 完整验收前增加一个独立 event adapter：

- 复用现有 VoIPBubbleMsg 接收链，解析“已拒绝/对方已拒绝/忙线”等明确文本。
- 以 `(被叫 user_id, active call_id, dial 时间窗)` 关联，不把其他通话或历史气泡并入。
- 只有明确文本/原生信号才报 `rejected` 或 `busy`。
- connected 后、非本地 ending 的 `startTalk<1` 可报 `remote_hangup`，同时带 `detection:"start_talk_down_inferred"`。
- 未接通且无明确原因时，到期报 ring_timeout；提前结束报 remote_end_unknown。

若阶段 0 无法可靠识别忙线/拒接，则 capabilities 必须返回 `rejected_event:false,busy_event:false`，实测报告明确“不满足需求完整 P0”，不能用超时冒充已区分。

---

## 7. 上行媒体流水线

```text
WS JSON
  → 长度预检/有界 base64 解码
  → Go actor 状态、generation、segment、seq、SHA-256 去重
  → Frida Post(JSON metadata + binary PCM)
  → JS 有界源采样队列（accepted 在此处产生）
  → 连续流式重采样（客户端率 → 本通引擎率）
  → 按本通 frameMs/frameBytes/内容长度/零尾规则组帧
  → PutExternalRecordData（每次仅一个引擎帧）
  → 仅 ret==0 推进 submitted/progress/done
```

### 7.1 格式与重采样

- 内容格式始终 mono s16le；声明采样率沿用已验证的 24000。
- 帧参数每通现读，禁止写死 960B/1920B，也禁止假设所有通话同采样率。
- 保持当前引擎所需的内容字节与零尾规则；零尾不计入客户端 consumed_samples。
- 外部支持 16k/24k/48k，引擎支持经实测的 16k/48k；44.1k 和其他格式返回 422。
- 使用带状态的流式重采样器，跨 append 保留相位、滤波历史和半帧。
- 16↔48、24↔48 使用有理数多相实现；降采样必须有抗混叠低通，不能只做每帧线性抽点。
- 每个原生帧携带 `(generation,segment_id,source_end_offset)` 元数据，成功后据此更新外部采样位置。
- connected 后格式重读不能重置队列、seq 或 source offset；若通话中变成不支持的新格式，显式失败。

### 7.2 tick 与错误

- 新流式路径保留绝对时间线，但使用 `setTimeout(max(0,deadline-now))`，删除忙等自旋。
- 每个事件循环回合最多提交一帧，不为追赶时间线 burst 注入多帧。
- 播放音频不因调度迟到而静默丢弃；记录 lateness，持续超过阈值则 backend_error/media_overflow。
- 等待接听、临时引擎未就绪与真正负返回分开处理。
- 普通非零返回不推进 offset，不发送 accepted 之后的成功 progress；达到连续错误阈值后结束会话。
- 不在新路径使用 `voipApplyFormat` 的“重新加载整段、offset=0、t0=now”逻辑。

### 7.3 队列与进度口径

- accepted 时数据只在 JS 队列；Go 最多有一个等待 JS ack 的 pending append，不算 accepted。
- `queued_ms` 包括 JS 源队列、重采样器内部延迟和未提交半帧，按客户端输入采样域折算。
- `consumed_samples` 是“已被成功提交原生帧覆盖的源采样位置”，采用保守下界，不能因滤波器预读而超前。
- commit 后为重采样器执行有限 flush；最后的滤波尾帧提交成功才 done。
- clear 的 dropped_samples 包含队列、重采样器和半帧中已接受但未成功提交的源采样。

---

## 8. 下行媒体流水线

```text
GetAudioData（x2 必须取引擎登记 pullBytes）
  → 检查返回值和实际输出长度
  → 必要时 16-bit 字节交换，统一 s16le
  → 连续重采样（引擎率 → 客户端输出率）
  → send(metadata + binary PCM) 到 Go
  → Go 有界输入队列
  → base64 一次编码，WS audio.input
```

规则：

1. 采集定时器同样删除忙等自旋。
2. `GetAudioData` 返回错误或输出长度异常时报告 gap/backend error，不能把预清零缓冲当真实静音。
3. 合法零 PCM 保留，维持时间轴。
4. connected 前的响铃期数据不对外发送，也不占对外 sample_offset。
5. JS 已按外部 output_format 重采样，Go 的 seq/sample_offset 和丢帧统计都在输出采样域计算。
6. Go 的 Frida message callback 直接做有界入队，不为每帧 `go func()`，不经过普通消息 HTTP 转发。
7. 将当前单参数 message callback 改为 `(rawMsg string, data []byte)`，其他消息类型行为保持不变。
8. 默认不写 WAV；只有后续显式 record 设计才能增加旁路落盘。

---

## 9. clear 的精确实现与停止边界

### 9.1 串行顺序

Go actor 收到 clear 后：

1. 标记 `clearing`，暂停接受所有新 append。
2. 通过与 append 相同的 Frida Post 有序通道发送 clear，不能另发 RPC 插队。
3. JS 先使旧 generation 失效，再停止播放 timer、清队列、清重采样器与半帧。
4. 正在执行的 NativeFunction 调用会先返回；JS 单线程随后才处理 clear。
5. 统计旧代最终成功提交位置和丢弃采样，发送 cleared。
6. Go 更新 generation、清空旧去重索引，恢复新代 append。
7. 下行采集全程继续。

### 9.2 能承诺与不能承诺

能承诺：

- onebot 内旧代未提交数据全部丢弃。
- cleared 后不会再发生旧代原生提交。
- 旧代迟到包、重复包不会进入新代。
- clear 不打断输入流和通话。

不能承诺：

- 撤回已经 `PutExternalRecordData` 的帧。
- 清空 SDK 内部、编码器、网络或对端设备缓冲。
- 精确停到某个远端可闻采样点。
- 总残留等于 20ms；20ms 只是已知单帧提交粒度，不是端到端上界。

capabilities 必须包含：

```json
{
  "onebot_queue_clear": true,
  "native_submitted_frame_reclaimable": false,
  "native_buffer_clear": false,
  "onebot_submission_quantum_ms": 20,
  "sdk_residual_upper_ms": null,
  "remote_stop_position_available": false
}
```

真实验收分别测“clear→onebot 停止提交”和“clear→远端实际停声”，不能只用本机录音占空比替代远端听感。

---

## 10. 背压、资源与安全

### 10.1 上行

- 客户端目标队列：100～200ms。
- 硬上限：1000ms；预计超过即整块 `buffer_full`。
- 不静默丢上行音频，不消耗失败 chunk 的 seq。
- 客户端依据 accepted/progress 的 queued_ms 限速，不按网络发送速度无限灌入。

### 10.2 下行

- Go 输入队列软目标 500ms，硬容量 2000ms。
- 满了丢弃最旧的完整帧，优先保持实时性；下一成功发送的 audio.input 带累计 gap。
- 队列持续满载 2 秒或 writer 持续阻塞 2 秒，结束 `media_overflow`，不无限占内存。
- event_seq 用于事件流排障；输入 seq/sample_offset/gap 用于音频连续性，二者不混用。

### 10.3 消息与频率限制

- WS `ReadLimit` 32KiB。
- 解码前检查 base64 长度和解码后上限，禁止先对超大字符串 DecodeString。
- 单帧解码后最大 9600B（100ms × 48k × mono × s16le），且必须为完整 16-bit 采样。
- 外部音频时长 20～100ms；空 PCM 拒绝。
- 控制命令 token bucket 20/s、burst 40；音频另受采样时长、队列和总消息率限制。
- 超限非致命命令返回 `rate_limited`；超大 WS 帧以 1009 关闭并触发会话清理。

### 10.4 心跳与断连

- ping 10 秒一次；pong 后延长 read deadline，30 秒无 pong 判半开。
- 写 deadline 建议 2 秒；任何读写错误都进入统一 cleanup。
- P0 无重连：WS 断开立即停上行、清队列并挂断。
- HTTP 状态查询不能替代心跳。

### 10.5 鉴权

当前没有可复用的 wxgate `/api/*` 鉴权，新增两层：

1. mumble→wxgate：`Authorization: Bearer <voice_api_token>`。
2. wxgate→onebot：独立 `onebot_stream_token`，不与 onebot 回调 HMAC secret 混用。

规则：

- 创建、状态、capabilities、WS、hangup 全部保护。
- 非浏览器联调客户端在 WS handshake 使用 Authorization；长期 token 不放 URL。
- 浏览器场景校验 Origin allowlist；P0 不为了浏览器增加 URL token 变通。
- 仅知道 call_id 没有控制权限。
- 新 token 不写日志、不打印启动参数、不出现在错误响应。
- 默认仍只绑定本机/可信网段；跨公网由部署方提供 WSS 和可信代理。

### 10.6 配置项

onebot 新增启动参数：

- `-stream_token`：内部 WS/HTTP Bearer token；为空时实时路由 fail-closed，不影响旧接口。
- `-stream_max_duration=300`：服务端硬上限，客户端只能请求更小值。
- `-stream_output_queue_ms=1000`、`-stream_input_queue_ms=2000`。
- `-stream_attach_timeout=10s`、`-stream_start_timeout=10s`。
- `-stream_ping_interval=10s`、`-stream_pong_timeout=30s`。
- `-stream_record_retention=10m`：状态与幂等记录保留时间，不是音频录音。

wxgate 新增 `voice_api_token`、`onebot_stream_token`、`voice_ws_allowed_origins`。对外 token 为空时新实时路由同样 fail-closed；不得回退到硬编码 `MuseBot`。配置只允许缩短队列/时限等安全上限，放宽 5 分钟总硬时限需要后续显式版本变更。

---

## 11. 清理、互斥与异常

### 11.1 统一 cleanup 顺序

所有结束入口只调用一次 cleanup：

1. CAS 进入 ending，停止接受新命令和 append。
2. 使 generation 失效，停止播放生产和定时器。
3. 停止采集和 Frida 流回调。
4. dialing/connected 时执行原生 hangup；reserved 未拨号则跳过。
5. 等待 JS closed/资源释放确认。
6. 取消预留、start、ring、duration、heartbeat 等全部 timer，关闭队列和 writer。
7. 写 call.ended（连接仍在时），关闭 WS。
8. 标记 resources_released，释放全局 owner；会话记录保留 10 分钟。

clear、hangup、release 分别有独立超时。任何一步未确认，会话可进入 ended，但 `resources_released:false`、`backend_healthy:false`，全局 owner 不释放，新创建返回 503 `backend_unhealthy`。禁止为了“解锁”直接假定旧音频引擎已经可用。

需要人工/看门狗恢复时遵循项目既有铁律：不能单独重启存活微信上的 onebot；改 script.js 或二进制后的部署按“重启微信→登录→起新 onebot”一次完成。

### 11.2 与旧路径互斥

- 实时 reserved 起即占用与 `voiceCallMu` 等效的全局 owner，直到资源释放。
- 旧文件通话执行期间，实时创建返回 409 `call_busy`。
- 实时 reserved/dialing/connected/ending 未释放期间，旧文件和入站布防同样拒绝。
- 不只在布防瞬间 TryLock 后释放；新 manager 应把“检查占用”和“持有 owner”变成同一生命周期。
- 旧 `/voice_call_status` 可显示实时 busy 摘要，但不能把 JS 无旧 voipCall 误报为全局空闲。

### 11.3 Frida/微信异常

- `wechatDead` 直接通知实时 actor，结束 backend_error，停止等待后续 ack。
- Frida Post 没有返回错误，所有控制命令都必须有响应超时；无响应不等于成功。
- session detached 后沿用 onebot 现有退出和看门狗恢复，不尝试在旧微信进程内反复重建通话。

---

## 12. wxgate 对接设计

### 12.1 路由与代理

建议新增 `handler_call_stream.go`，旧 `handler_call.go` 不改协议：

- HTTP 创建、状态、capabilities、hangup 转发到 onebot，保留 Idempotency-Key 和 call_id。
- 创建响应中的 onebot `stream_path` 改写成对外 `/api/voice_calls/.../stream`。
- WS 先验证客户端 token/Origin，再建立到 onebot 的内部 WS；两边都配置 read limit、heartbeat 和 write deadline。
- 任一方向关闭都关闭另一方向；不能只留下 onebot 通话继续播放。
- 采用有界/网络背压，不在 wxgate 建无限 channel，不为音频帧额外起 goroutine。
- wxgate 透明转发 JSON/base64，不解码 PCM，不重排命令，不修改 seq/event_seq。
- access log 只记路径、状态、耗时和 call_id，不记 body、Authorization 或音频。

### 12.2 状态与旧硬时限

- onebot 是状态和硬时限权威，wxgate 可缓存最后一次对外事件用于审计。
- 如保留 wxgate 兜底 timer，必须携带 call_id 调 scoped hangup；禁止旧 timer 调 `/hangup_voice_call`。
- 新实时路由与旧 `/api/send_voice_call` 同时可用，由 onebot 全局 owner 保证互斥。
- mumble 的状态回显只发送生命周期文本，不转发 PCM 到普通消息回调。

---

## 13. capabilities 建议模型

能力必须按当前构建和真实校准结果生成，未知项为 false/null，不静默降级。例如：

```json
{
  "status":"ok",
  "retcode":0,
  "data":{
    "protocol_version":1,
    "modes":["outbound_stream"],
    "duplex":true,
    "input_source":"remote_downlink",
    "remote_independent_track":false,
    "remote_independent_track_note":"待真实自声回环验收后置 true",
    "input_formats":[{"codec":"pcm_s16le","sample_rates":[16000,24000,48000],"channels":[1]}],
    "output_formats":[{"codec":"pcm_s16le","sample_rates":[16000,24000,48000],"channels":[1]}],
    "frame_ms":{"preferred":20,"min":20,"max":100},
    "answer_detection":"put_ready_inferred",
    "ringing_event":false,
    "rejected_event":false,
    "busy_event":false,
    "remote_hangup_detection":"start_talk_down_inferred",
    "progress_scope":"submitted_to_wechat",
    "progress_interval_ms":100,
    "progress_granularity":"one_engine_frame",
    "progress_precision_ms":null,
    "progress_precision_note":"connected 后由 engine frame_ms 决定；不包含 SDK/网络播放位置",
    "segment_done_scope":"submitted_to_wechat",
    "remote_heard_progress":false,
    "onebot_queue_clear":true,
    "native_buffer_clear":false,
    "sdk_residual_upper_ms":null,
    "queue":{"target_ms":200,"hard_ms":1000,"input_hard_ms":2000},
    "max_duration_s":300,
    "attach_timeout_s":10,
    "heartbeat":{"ping_s":10,"pong_timeout_s":30},
    "recording":false,
    "backend_healthy":true
  }
}
```

阶段 0 校准完成后，`remote_independent_track/rejected_event/busy_event` 才能按结果改为 true；示例不是当前能力承诺。

---

## 14. 错误码

HTTP：

- `invalid_request`、`unauthorized`、`forbidden`、`not_found`。
- `call_busy`、`control_conflict`、`idempotency_conflict`。
- `unsupported_format`、`backend_unhealthy`、`backend_error`。

WS：

- `invalid_message`、`invalid_state`、`rate_limited`。
- `invalid_seq`、`seq_conflict`。
- `stale_generation`、`invalid_generation`。
- `segment_committed`、`empty_segment`。
- `buffer_full`、`temporarily_unavailable`。
- `control_conflict`、`backend_error`、`media_overflow`。

错误响应统一：

```json
{
  "type":"error",
  "request_id":"a-43",
  "call_id":"...",
  "event_seq":25,
  "t_ms":3200,
  "fatal":false,
  "error":{
    "code":"buffer_full",
    "message":"output queue is full",
    "retryable":true,
    "expected_seq":43,
    "queued_ms":1000
  }
}
```

---

## 15. 代码组织建议

### weixin-macos

- `onebot/voice_stream.go`：session manager、owner、创建/状态/hangup、cleanup。
- `onebot/voice_stream_ws.go`：单连接、读写循环、心跳、事件 writer。
- `onebot/voice_stream_protocol.go`：命令/事件、序号与去重、错误码、限制。
- `onebot/voice_stream_bridge.go`：Frida Post/send 二进制桥、backend interface、ack 关联。
- `onebot/script.js`：新增独立 VoIP Stream 分区，不改旧 voipPlay 语义；新 tick 无忙等。
- `onebot/main.go`：新路由和 VoIP stream message case；message callback 接二进制 data。
- `onebot/voice_stream_*_test.go`：假 backend、协议和竞态测试。
- `tools/voip/stream_client.py`：无 AI 的 Python 联调客户端。
- `docs/VOIP-STREAMING-API.md`：实现后固定 v1 契约和完整样例。
- 实施行为变化落地时同步更新 `CLAUDE.md`/`AGENTS.md` 与既有 VoIP 文档；本设计稿本身不改变运行行为。

### wxgate

- `handler_call_stream.go`：新 HTTP/WS 路由、鉴权、反向代理。
- `handler_call_stream_test.go`：假 onebot WS、鉴权、断连、scoped hangup、旧接口回归。
- `config.go`：`voice_api_token`、`onebot_stream_token`、Origin allowlist、可选限制。
- 新增 gorilla/websocket 直接依赖，不自己实现 WS 帧。

---

## 16. 联调客户端

`tools/voip/stream_client.py`：

- 使用 asyncio + websockets，无 ASR/LLM/TTS 依赖。
- `--url`、`--user-id` 必填；token 从环境变量读取，避免出现在进程参数和 shell 历史。
- 没有显式 `--start` 不拨号，禁止默认 wxid、禁止默认自动拨号。
- 支持创建、attach、start、接收并校验 input seq/sample_offset/gap。
- 生成固定测试音，20ms append，按 queued_ms 将队列维持在 100～200ms。
- 支持多 segment、commit、定时 clear、快速 generation 切换和 hangup。
- 默认不保存远端音频；显式 `--record` 才落盘，并打印安全提示。
- 日志只打 call_id、seq、队列、进度、事件和错误，不打印 base64/token。
- 可直接连 onebot，也可连 wxgate；两者使用相同消息样例。

---

## 17. 测试与验收

### 17.1 假 backend 自动化

- 创建不 attach 不拨号，10 秒释放；attach 不 start 也释放。
- 创建幂等：同 key 同参数返回原会话，不同参数冲突，不重复拨号。
- 第二控制连接冲突，旧 ID hangup 不影响新 call。
- start/append/commit/clear/hangup 重放和乱序矩阵。
- accepted 不等于 progress，commit 不等于 done，progress 不超过已提交样本。
- buffer_full 不消耗 seq，同 seq 重试成功；同 seq 不同数据冲突。
- clear 后旧代拒绝，清理中新代 temporarily_unavailable，ack 后重发成功。
- 连续 20 次 clear 不串代、不重复 done、不泄漏队列。
- 下行慢客户端：drop oldest、sample_offset 连续、gap 数准确、持续溢出 media_overflow。
- heartbeat、断连、远端结束、超时、backend 异常全部 cleanup。
- 5 分钟后资源释放并立即下一通；未确认释放时保持 unhealthy。
- WS writer 无并发写；`go test -race`，多通后 goroutine/内存无持续增长。

### 17.2 重采样测试

- 16/24/48k 全组合，随机 chunk 边界与一次性输入结果一致。
- 正弦频率/时长正确，降采样无混叠，segment 边界无爆音。
- consumed_samples 不超前、不倒退；clear 后无旧滤波尾进入新 generation。
- 输入 gap 后 offset 正确，不错误重置整通时间轴。

### 17.3 真实微信验收

先在开发副本，再按生产部署规程验证：

1. 60 秒同时收发，确认播放时采集不中断。
2. 对端播放固定测试音，本机注入另一测试音，检查下行是否有 AI 自声回灌；通过后才把 remote_independent_track 置 true。
3. 用递增采样序号/测试音验证顺序、采样率、格式和 gap。
4. 多段 append/commit，核对 accepted/progress/done 的 scope 和样本数。
5. 长段播放 clear，分别记录 onebot 停止提交与远端实际停声；连续快速打断 20 次。
6. 拒接、忙线、未接、远端挂断、本机挂断、断连、5 分钟、backend 异常。
7. 背压、超大帧、未授权、第二连接、旧 ID hangup。
8. 旧文件通话与实时互斥，旧文件/消息/媒体接口冒烟。
9. 多通后资源、goroutine、内存无持续增长。

真实通话音质沿用 `tools/voip/verify_recording.py`，但注意 M1 录音器可能制造洞伪影；0 洞还需 env_corr≥0.7，clear 远端停声需另做环回/对端测量。

### 17.4 性能记录

本机单调时钟分别记录：

- append 收到→accepted。
- GetAudioData 帧→Go 收到→WS 写完成。
- clear 收到→onebot 停止提交→cleared。
- progress 事件周期与队列高低水位。

目标是本机桥接附加延迟 P95<100ms、clear 到本机停止提交 P95<200ms；这些是验收目标，不是当前已实现承诺。远端停声和微信网络延迟另测，不对未同步时钟直接相减。

---

## 18. 实施顺序与发布门禁

### 阶段 0：能力补证（开发副本）

- 验证二进制 Frida 双向消息在 50 帧/s 双向下的延迟与稳定性。
- 验证静音就绪探测可在无客户端上行时检测接通，不误把响铃当 connected。
- 完成拒接/忙线气泡关联；不能完成则记录明确协议差距。
- 验证同通双流的自声回灌、clear 实际残留、真实格式。

### 阶段 1：onebot JS 实时媒体引擎

- 新会话 ID、队列、连续重采样、无忙等 tick。
- 二进制 append/input、成功提交计数、generation clear、结构化状态。
- 保留旧文件播放路径，避免旧功能回归。

### 阶段 2：onebot Go 会话与 WS

- manager、全局 owner、幂等、状态机、单 writer、背压、心跳、cleanup。
- 假 backend 自动化和 race 测试全过后再接真实 JS。

### 阶段 3：wxgate 代理与鉴权

- 对外路由、token、Origin、透明 WS 代理、scoped hangup。
- 固定 v1 文档和完整样例后再让 mumble 接入。

### 阶段 4：真实验收与部署

- 开发副本全链路 → 自动化 → 真实微信矩阵 → 实测报告。
- onebot 编译后必须按项目固定证书重签。
- script.js 与二进制一次部署，按“重启微信→登录→起新 onebot”执行，不反复单独重启 onebot。
- 生产验收后更新 VOIP-CALL-STATUS、VOICE-CALL-API、CLAUDE/AGENTS，并随代码一起提交。

---

## 19. 需要 wxgate/mumble 明确接受的契约点

1. **进度与 done 的 P0 口径是 `submitted_to_wechat`，不是对方已听到。** 若要求硬件/远端播放完成，当前底层不支持。
2. **clear 保证清 onebot 队列和阻止旧代后续提交，不保证撤回原生产物。** SDK/网络残留上界当前未知，capabilities 明确 false/null。
3. **引擎实际格式只能在拨号后返回。** 创建和 hello 固定的是外部格式，connected 带真实引擎格式。
4. **接通在 P0 可能是 inferred；拒接/忙线必须校准后才能广告。** 未通过就不能声称完整满足原需求。
5. **鉴权是新增能力，不是复用现有 `/api/*` 鉴权。**
6. **P0 不支持断线恢复。** 任意控制 WS 断开都挂断，客户端必须重新创建新 call_id。

除以上明确差异外，需求中的单通锁、预留后 start 才拨号、JSON+base64、generation/segment/seq、commit、背压、gap、5 分钟、scoped hangup、联调客户端和验收矩阵均可按本文直接实施。
