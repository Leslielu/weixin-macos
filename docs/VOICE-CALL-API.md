# 语音通话 API

OneBot 服务（默认 `http://127.0.0.1:58080`，`-receive_host` 可改）提供的微信语音通话接口：
主动拨号并给对方放音、接通后采集对方下行录音；以及被叫自动接听（入站）。

实现：`onebot/voice_call.go`（出站）、`onebot/voice_call_inbound.go`（入站）、
`onebot/script.js` 的 VoIP 分区。链路标定见 [VOIP-CALL-STATUS.md](VOIP-CALL-STATUS.md)。

**全局约束**：同一时刻只允许一通电话，出站与入站互斥（ConfSDK 音频引擎独占）。

---

## 1. POST /send_voice_call —— 主动拨号

拨通后播放音频/TTS，可选采集对方声音，结束挂断。

### 请求体

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `user_id` | string | — | **必填**，被叫 wxid |
| `voice` | string | — | 本地音频路径（wav/mp3/aiff…），内部 ffmpeg 转 16bit mono PCM |
| `text` | string | — | 无 `voice` 时用 macOS `say` 合成 TTS |
| `tts_voice` | string | `Tingting` | `say` 音色 |
| `record` | bool | `false` | 采集对方下行音频，结束时封 WAV |
| `record_seconds` | int | `60` | 采集上限（自真正开始拉流起算，非自接通） |
| `max_seconds` | int | `120` | 单次播放上限 |
| `timeout` | int | `60` | 等接听上限，超时自动挂断 |
| `hangup` | bool | `true` | 结束是否挂断 |
| `async` | bool | `false` | `true` = 立即返回，通话在后台跑完 |

`voice` / `text` / `record` 至少填一个。四种模式：只播、只录、边播边录、纯采集。
`voice` 与 `text` 同时给时以 `voice` 为准。

### 示例

```bash
# 播放本地音频 + 录音
curl -X POST http://127.0.0.1:58080/send_voice_call \
  -H 'Content-Type: application/json' \
  -d '{"user_id":"wxid_xxx","voice":"/tmp/hello.wav","record":true,"record_seconds":30}'

# TTS 播报
curl -X POST http://127.0.0.1:58080/send_voice_call \
  -H 'Content-Type: application/json' \
  -d '{"user_id":"wxid_xxx","text":"你好，这是一通语音播报"}'

# 纯采集：不说话，接通后听对方 20 秒
curl -X POST http://127.0.0.1:58080/send_voice_call \
  -H 'Content-Type: application/json' \
  -d '{"user_id":"wxid_xxx","record":true,"record_seconds":20,"max_seconds":20}'

# 异步：长语音不占 HTTP 连接，立即返回
curl -X POST http://127.0.0.1:58080/send_voice_call \
  -H 'Content-Type: application/json' \
  -d '{"user_id":"wxid_xxx","text":"喂，我是机器人","async":true}'
```

### 响应

成功：

```json
{
  "status": "ok",
  "retcode": 0,
  "data": {
    "user_id": "wxid_xxx",
    "answered": true,
    "duration_ms": 48213,
    "reason": "done",
    "frames": 1200,
    "bytes_sent": 1152000,
    "pcm_bytes": 1152000,
    "played_seconds": 24.0,
    "record": {
      "ok": true,
      "path": "/abs/path/voice_records/call_wxid_xxx_1793889921.wav",
      "rate": 48000,
      "bytes": 960000,
      "seconds": 10.0,
      "raw_bytes": 2400000,
      "trim_note": "已裁首尾静音帧(响铃期+挂断尾)"
    }
  }
}
```

`async:true` 时立即返回：

```json
{"status":"ok","retcode":0,"data":{"async":true,"user_id":"wxid_xxx"}}
```

失败：

```json
{"status":"failed","error":"对方未接听(超时)","waited_ms":60123}
```

常见错误：`已有通话进行中`、`拨号未成功: <code>`、`注入启动失败: <msg>`、
`对方未接听(超时)`、`音频过短或为空(N 字节)`、`user_id 必填`、
`voice/text/record 至少填一个`。

### 录音产物

- 落 `voice_records/call_<wxid>_<unix>.wav`（相对 onebot 工作目录），16bit mono。
- 采样率取这通电话引擎实际协商值（16000 / 48000 均实测出现过）。
- 自动裁掉首尾的整帧数字静音（响铃期与挂断尾）；中间静音保留。
- 全程静音时返回 `{"ok":true,"note":"全程数字静音(对方未出声)","raw_seconds":…}`，不写文件。
- 无采集数据时返回 `{"ok":false,"note":"无采集数据(未接通或引擎未就绪)"}`。

---

## 2. GET /voice_call_status —— 当前通话状态

```bash
curl http://127.0.0.1:58080/voice_call_status
```

```json
{
  "status": "ok",
  "busy": true,
  "data": {
    "active": true,
    "answered": true,
    "calls": 1200,
    "bytesSent": 1152000,
    "totalBytes": 1152000,
    "contentRate": 48000,
    "channels": 1,
    "frameMs": 20,
    "frameBytes": 1920,
    "maxLateMs": 3,
    "lateOver3ms": 0,
    "last": {"reason": "eof", "answered": true, "frameMs": 20, "calls": 1200, "bytesSent": 1152000, "totalBytes": 1152000, "error": ""}
  }
}
```

`busy` 表示 OneBot 侧通话锁是否被占；`data` 是 Frida 侧引擎状态，`last` 为上一通摘要。

---

## 3. POST /hangup_voice_call —— 手动挂断

打断长语音。请求体可为空。

```bash
curl -X POST http://127.0.0.1:58080/hangup_voice_call
```

响应：`{"status":"ok","ret":"0"}`。

---

## 4. POST /voice_call_inbound —— 布防被叫自动接听

布防后来电自动接听 → 可采集对方（录音）/ 播放给定音频或 TTS → 挂断。
一次布防默认只接一通，窗口期内无来电自动解除。

> 接听方播放的周期性空洞已于 2026-11-07 修复（`mic_gate`，根因与标定见
> `docs/VOIP-CALL-STATUS.md` §17.9）：原生麦克风 20ms 数字静音帧会与注入帧交替,
> 门控后同一录音器 0 洞 / 100% 占空比。

### 请求体

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | bool | `false` | `false` = 解除布防 |
| `voice` / `text` / `tts_voice` | string | — | 接听后播放，同出站（音符帧按协商格式现算） |
| `record` | bool | `false` | 接听后采集对方音频并落 WAV |
| `max_seconds` | int | `120` | 单通上限，到点自动挂断 |
| `answer_delay_ms` | int | `1200` | 来电到接听的延时 |
| `window_seconds` | int | `300` | 布防窗口，超时无来电自动解除 |
| `multi` | bool | `false` | 窗口内连续来电都接 |
| `mute_mic` | bool | `true` | 接听后静音本机麦克风 |
| `mic_gate` | bool | `true` | 播放时阻断原生麦克风生产源（§17.9）。**传 `false` 只用于对照实验**：空洞会回来（~59% 占空比） |
| `hangup` | bool | `true` | 播完是否自动挂断 |
| `record_seconds` | int | — | 兼容字段，实际随通话时长 |

`mic_gate` 开启时，播放期间本机麦克风完全不进混音（与 `mute_mic` 语义一致：播报即静音）；
需要"边播边传麦克风"目前不支持（mixer 层无混音口）。纯录音（不带 voice/text）不受影响。

实验参数（一般不用动）：`callee40`、`start_delay_ms`、`content_rate_div`、
`no_pad`、`load_rate`、`feed_interval_ms`、`full_frame`、`declared_rate`。
语义见 `docs/VOIP-CALL-STATUS.md` §17。

### 示例

```bash
# 布防：来电自动接听并录音（不听不播）
curl -X POST http://127.0.0.1:58080/voice_call_inbound \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true,"record":true,"window_seconds":600,"mute_mic":true}'

# 解除布防
curl -X POST http://127.0.0.1:58080/voice_call_inbound \
  -H 'Content-Type: application/json' -d '{"enabled":false}'
```

响应：

```json
{"status":"ok","armed":true,"record":true,"play":false,
 "max_seconds":120,"window_seconds":600,
 "note":"接听方播放已按 §17.9 修复(麦克风生产源门控, mic_gate 可关), 录音不受影响"}
```

出站通话进行中布防会被拒绝：`{"status":"failed","message":"出站通话进行中, 无法布防入站接听"}`。

---

## 5. GET /voice_call_inbound_status —— 入站状态与录音收尾

```bash
curl http://127.0.0.1:58080/voice_call_inbound_status
```

```json
{
  "status": "ok",
  "data": {
    "armed": true,
    "phase": "armed",
    "record": true,
    "play": false,
    "maxSeconds": 120,
    "notifyCount": 0,
    "answerRet": 0,
    "inCallSeconds": 0,
    "deadline": 1793890000,
    "last": null
  }
}
```

通话结束后本接口会**自动**把采集 PCM 封装成
`voice_records/call_inbound_<unix>.wav`，路径在该次响应的 `record` 字段里
（每次通话只封一次，重复轮询不会重复封装）。轮询到 `last` 变化且返回了
`record.path` 即为完成。

`phase` 取值：`armed`（布防等待来电）→ `incall`（通话中）。通话结束或窗口超时后
`armed` 变 `false`，`last` 给出 `reason` 与时长。通话中调用
`/voice_call_inbound {"enabled":false}` 会被拒绝（`disarm: "busy:incall"`）。

---

## 6. 使用注意

1. **录音是接听方下行**。采集自接通起武装，但引擎就绪可能比接通晚几秒，
   `record_seconds` 计的是真正开始拉流之后的时间——短录音要给余量。
2. **入站接听里给对方放音已可用**（2026-11-07 修复 §17.9：`mic_gate` 默认开，
   录音验收 0 洞 / 100% 占空比；门控期间本机麦克风不进混音）。出站放音仍是最稳的路径。
   注意它依赖版本 JSON 的 `voipMicGateAddr`/`voipMicGateModeOff`，缺键会**静默**退回旧行为。
3. **运行依赖**：`ffmpeg`（音频转 PCM）、macOS `say`（TTS）、`python3 + pilk`（语音消息编码，
   onebot 启动即自检）。缺 ffmpeg 时 `voice`/`text` 路径直接报错。
4. 拨号会拉起微信自带的通话状态机与音频引擎；被对方拒接/未接会走 `timeout` 分支并挂断。
