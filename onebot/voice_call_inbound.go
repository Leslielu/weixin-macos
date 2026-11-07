package main

// 入站语音通话(被叫自动接听) —— docs/VOIP-CALL-STATUS.md §14.5(probe45 配方的生产化)
//
// 链路: JS voipInboundArm 武装(挂 RecvNotify 来话通知 hook) → 来电延时后
//
//	ConfSDK Accept(svc,1,0,0x22) 接听 → 可选: 下行采集(voipCaptureStart, 听对方)
//	+ 接听方注入(voipPlay, ⚠️§14 已知 40ms 节拍问题, 实验性) → 播完/超时挂断。
//
// 一次武装处理一通(one-shot), 窗口期(window_seconds)内无来电自动解除。
// 与出站 /send_voice_call 互斥(ConfSDK 引擎独占), 布防时出站通话进行中则拒绝。
// 4.1.15 标定: RecvNotify=ConfSDKdyn+0x7ced8 / Accept=+0x7cbc0 / 挂断仍走 vt[12]。

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"sync"
	"time"
)

// VoiceCallInboundRequest POST /voice_call_inbound 请求体
type VoiceCallInboundRequest struct {
	Enabled        bool   `json:"enabled"`          // false = 解除武装
	Voice          string `json:"voice"`            // 本地音频文件路径(wav/mp3/...)
	Text           string `json:"text"`             // 或用 TTS 合成(接听后播放, 实验性)
	TTSVoice       string `json:"tts_voice"`        // macOS say 音色, 默认 Tingting
	Record         bool   `json:"record"`           // 接听后采集对方音频(听对方), 存 WAV
	RecordSeconds  int    `json:"record_seconds"`   // 兼容字段, 实际采集随通话时长
	MaxSeconds     int    `json:"max_seconds"`      // 通话上限(秒, 到点自动挂断), 默认 120
	AnswerDelayMs  int    `json:"answer_delay_ms"`  // 来电到接听的延时(毫秒), 默认 1200
	WindowSeconds  int    `json:"window_seconds"`   // 武装窗口(秒, 无来电自动解除), 默认 300
	Multi          bool   `json:"multi"`            // 多通模式: 窗口内连续来电都接(默认一次性)
	Callee40       bool   `json:"callee40"`         // 实验性: 40ms 喂帧模式(对抗接听方 40ms 消费节拍)
	StartDelayMs   int    `json:"start_delay_ms"`   // 实验性: 接通后延迟 N ms 才开播(等协商落定), 默认 0
	ContentRateDiv int    `json:"content_rate_div"` // 实验性: 内容采样率 = 引擎采样率 1/N; 0=默认 1(实测降到 1/2 会音高×2、时长÷2)
	NoPad          *bool  `json:"no_pad"`           // 帧长=内容长, 不补零尾(默认 true; 零尾会被渲染成静音 ⇒ 40ms 周期空洞)
	LoadRate       int    `json:"load_rate"`        // 实验性: 强制载荷采样率(0=按 content_rate_div 推); 探"SDK 按声明率 24000 解释缓冲"假设用
	FeedIntervalMs int    `json:"feed_interval_ms"` // 实验性: 喂入节拍 ms(默认 20), 消费端 40ms 取一次时设 40 防积压
	FullFrame      bool   `json:"full_frame"`       // 实验性: 整块 buffer 填满内容(不留零尾)
	DeclaredRate   int    `json:"declared_rate"`    // 实验性: PutExternalRecordData 声明采样率(默认 24000)
	MuteMic        *bool  `json:"mute_mic"`         // 接听后是否静音本机麦克风, 默认 true(否则对方听到本机环境音)
	MicGate        *bool  `json:"mic_gate"`         // 文件播放时阻断原生麦克风生产源, 默认 true(§17.9: 否则静音帧与注入帧交替 ⇒ 40ms 空洞)
	Hangup         *bool  `json:"hangup"`           // 播完是否自动挂断, 默认 true
}

var (
	voipInboundMu        sync.Mutex
	voipInboundDir       string // 本轮布防的工作目录(采集 PCM + 载荷)
	voipInboundFinalized bool   // 本轮通话是否已封装 WAV
	voipInboundLastTS    int64  // 已封装的那通 last.ts(防重复封装)
)

type voipInboundJSStatus struct {
	Armed        bool            `json:"armed"`
	Phase        string          `json:"phase"`
	Record       bool            `json:"record"`
	Play         bool            `json:"play"`
	MaxSeconds   int             `json:"maxSeconds"`
	NotifyCount  int             `json:"notifyCount"`
	AnswerRet    json.Number     `json:"answerRet"`
	InCallSecond float64         `json:"inCallSeconds"`
	Deadline     int64           `json:"deadline"`
	Last         *voipInboundJSL `json:"last"`
}

type voipInboundJSL struct {
	TS          int64       `json:"ts"`
	Reason      string      `json:"reason"`
	AnswerRet   json.Number `json:"answerRet"`
	NotifyCount int         `json:"notifyCount"`
	Played      bool        `json:"played"`
	Recorded    bool        `json:"recorded"`
	Seconds     float64     `json:"seconds"`
}

func voipInboundStatusNow() (*voipInboundJSStatus, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	raw, err := safeExportsCall(ctx, "voipInboundStatus")
	if err != nil {
		return nil, err
	}
	var st voipInboundJSStatus
	if err := json.Unmarshal([]byte(jsString(raw)), &st); err != nil {
		return nil, err
	}
	return &st, nil
}

// voiceCallInboundHandler POST /voice_call_inbound —— 武装/解除被叫自动接听
func voiceCallInboundHandler(w http.ResponseWriter, r *http.Request) {
	var req VoiceCallInboundRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, map[string]any{"status": "failed", "message": "请求体解析失败: " + err.Error()})
		return
	}
	voipInboundMu.Lock()
	defer voipInboundMu.Unlock()

	if !req.Enabled {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		ret, _ := safeExportsCall(ctx, "voipInboundDisarm")
		voipInboundDir = ""
		writeJSON(w, map[string]any{"status": "ok", "disarm": jsString(ret)})
		return
	}

	// 与出站互斥: 出站通话进行中不接受布防
	if !voiceCallMu.TryLock() {
		writeJSON(w, map[string]any{"status": "failed", "message": "出站通话进行中, 无法布防入站接听"})
		return
	}
	voiceCallMu.Unlock()

	var prefix string
	if req.Voice != "" || req.Text != "" {
		dir, err := os.MkdirTemp("", "onebot_voip_in_")
		if err != nil {
			writeJSON(w, map[string]any{"status": "failed", "message": "临时目录创建失败: " + err.Error()})
			return
		}
		prefix, err = prepareVoIPPayload(dir, req.Voice, req.Text, req.TTSVoice, intOr(req.MaxSeconds, 120))
		if err != nil {
			os.RemoveAll(dir)
			writeJSON(w, map[string]any{"status": "failed", "message": "播放载荷准备失败: " + err.Error()})
			return
		}
		voipInboundDir = dir
	} else {
		voipInboundDir = ""
	}

	opts := map[string]any{
		"prefix":         prefix,
		"record":         req.Record,
		"maxSeconds":     intOr(req.MaxSeconds, 120),
		"answerDelayMs":  req.AnswerDelayMs,
		"windowSeconds":  req.WindowSeconds,
		"multi":          req.Multi,
		"callee40":       req.Callee40,
		"startDelayMs":   req.StartDelayMs,
		"contentRateDiv": req.ContentRateDiv,
		"feedIntervalMs": req.FeedIntervalMs,
		"fullFrame":      req.FullFrame,
		"noPad":          boolOr(req.NoPad, true),
		"loadRate":       req.LoadRate,
		"declaredRate":   req.DeclaredRate,
		"muteMic":        boolOr(req.MuteMic, true),
		"micGate":        boolOr(req.MicGate, true),
		"hangup":         boolOr(req.Hangup, true),
	}
	if req.Record {
		if voipInboundDir == "" {
			dir, err := os.MkdirTemp("", "onebot_voip_in_")
			if err != nil {
				writeJSON(w, map[string]any{"status": "failed", "message": "临时目录创建失败: " + err.Error()})
				return
			}
			voipInboundDir = dir
		}
		opts["capPath"] = voipInboundDir + "/down.pcm"
	}
	voipInboundFinalized = false
	voipInboundLastTS = 0

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ret, err := safeExportsCall(ctx, "voipInboundArm", mustJSONString(opts))
	if err != nil {
		writeJSON(w, map[string]any{"status": "failed", "message": "voipInboundArm 失败: " + err.Error()})
		return
	}
	if s := jsString(ret); s != "ok" {
		writeJSON(w, map[string]any{"status": "failed", "message": "voipInboundArm: " + s})
		return
	}
	Info("入站接听已武装", "record", req.Record, "play", prefix != "", "window", req.WindowSeconds)
	writeJSON(w, map[string]any{"status": "ok", "armed": true,
		"record": req.Record, "play": prefix != "",
		"max_seconds": intOr(req.MaxSeconds, 120), "window_seconds": req.WindowSeconds,
		"note": "接听方播放已按 §17.9 修复(麦克风生产源门控, mic_gate 可关), 录音不受影响"})
}

// voiceCallInboundStatusHandler GET /voice_call_inbound_status —— 入站状态查询;
// 通话结束后自动把采集 PCM 封装成 WAV(voice_records/call_inbound_<ts>.wav)。
func voiceCallInboundStatusHandler(w http.ResponseWriter, r *http.Request) {
	st, err := voipInboundStatusNow()
	if err != nil {
		writeJSON(w, map[string]any{"status": "failed", "message": err.Error()})
		return
	}
	resp := map[string]any{"status": "ok", "data": st}
	voipInboundMu.Lock()
	if st.Last != nil && st.Last.TS != voipInboundLastTS {
		if !st.Last.Recorded || voipInboundDir == "" {
			voipInboundLastTS = st.Last.TS // 无录音诉求也推进, 防重复判定
		} else if !voipInboundFinalized {
			voipInboundFinalized = true
			voipInboundLastTS = st.Last.TS
			resp["record"] = finalizeVoiceRecording(voipInboundDir, "inbound")
		}
	}
	voipInboundMu.Unlock()
	writeJSON(w, resp)
}

func mustJSONString(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return "{}"
	}
	return string(b)
}
