package main

// voice_stream_protocol.go —— 实时语音流协议层(设计: docs/VOIP-STREAMING-DESIGN.md §4/§5/§14)
//
// 职责: 格式校验、序号/代次规则、消息与频率限制、稳定错误码。
// 全部为纯函数/常量, 不依赖 Frida, 可独立单测(设计 §17.1 假底层自动化)。

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
)

// ---- 协议版本 ----
const StreamProtocolVersion = 1

// ---- 帧与队列限制(§10) ----
const (
	StreamMaxChunkBytes  = 9600  // 单帧解码后上限: 100ms × 48k × mono × s16le
	StreamMaxB64Len      = 14000 // base64 预检上限(9600B ≈ 12800 字符 + 余量)
	StreamWSReadLimit    = 32 << 10
	StreamQueueTargetMs  = 200   // 播放队列目标水位
	StreamQueueHardMs    = 1000  // 播放队列硬上限, 超过整块拒收
	StreamInputQueueMax  = 128   // 下行帧队列硬容量(≈2.5s @20ms)
	StreamMediaOverflowN = 100   // 持续丢下行帧达到该数量 ⇒ media_overflow
)

// ---- 生命周期超时(§6) ----
const (
	StreamAttachTimeout   = 10 // 创建后等待 WS attach(秒)
	StreamStartTimeout    = 10 // attach 后等待 call.start(秒)
	StreamRingMaxS        = 60 // 等接听上限(秒), 客户端可请求更小
	StreamMaxDurationCapS = 300 // 服务端总时长硬上限(秒), 从开始拨号计
	StreamAckTimeoutS     = 3  // JS ack 超时(秒)
	StreamStopAckTimeoutS = 5  // JS stop 确认超时(秒)
	StreamPingIntervalS   = 10
	StreamPongTimeoutS    = 30
	StreamRetentionMin    = 10 // 结束记录/幂等记录保留(分钟)
	StreamIdemMaxEntries  = 128
)

// ---- 速率限制(§10.3) ----
const (
	StreamControlRatePerS  = 20
	StreamControlBurst     = 40
	StreamAudioMsgRateMax  = 100 // 超过按 rate_limited 拒绝
	StreamAppendInFlightMax = 8 // Go↔JS 在途 append 窗口
)

// ---- 外部格式(§4.1) ----
var StreamSupportedRates = map[int]bool{16000: true, 24000: true, 48000: true}

type AudioFormat struct {
	Codec       string `json:"codec"`
	SampleRate  int    `json:"sample_rate"`
	Channels    int    `json:"channels"`
}

func (f AudioFormat) validate() error {
	if f.Codec != "pcm_s16le" {
		return fmt.Errorf("codec 仅支持 pcm_s16le(收到 %q)", f.Codec)
	}
	if f.Channels != 1 {
		return fmt.Errorf("channels 仅支持 1(收到 %d)", f.Channels)
	}
	if !StreamSupportedRates[f.SampleRate] {
		return fmt.Errorf("sample_rate 仅支持 16000/24000/48000(收到 %d)", f.SampleRate)
	}
	return nil
}

func (f AudioFormat) isZero() bool { return f.SampleRate == 0 && f.Codec == "" }

// ---- 请求体(§4.1) ----
type StreamCreateRequest struct {
	UserID       string       `json:"user_id"`
	Source       string       `json:"source"`
	Mode         string       `json:"mode"`
	RingTimeoutS  int          `json:"ring_timeout_s"`
	MaxDurationS int          `json:"max_duration_s"`
	InputFormat  AudioFormat `json:"input_format"`
	OutputFormat AudioFormat `json:"output_format"`
}

func (r *StreamCreateRequest) validate() (ringS, maxS int, err error) {
	if r.UserID == "" {
		return 0, 0, fmt.Errorf("user_id 必填")
	}
	if len(r.UserID) > 128 {
		return 0, 0, fmt.Errorf("user_id 过长")
	}
	if r.Mode != "stream" {
		return 0, 0, fmt.Errorf("mode 仅支持 stream(收到 %q)", r.Mode)
	}
	if r.Source == "" {
		return 0, 0, fmt.Errorf("source 必填(调用方标识, 如 mumble)")
	}
	if len(r.Source) > 64 {
		return 0, 0, fmt.Errorf("source 过长(≤64)")
	}
	ringS = r.RingTimeoutS
	if ringS <= 0 {
		ringS = StreamRingMaxS
	}
	if ringS > StreamRingMaxS {
		return 0, 0, fmt.Errorf("ring_timeout_s 上限 %d", StreamRingMaxS)
	}
	maxS = r.MaxDurationS
	if maxS <= 0 {
		maxS = StreamMaxDurationCapS
	}
	if maxS > StreamMaxDurationCapS {
		return 0, 0, fmt.Errorf("max_duration_s 上限 %d", StreamMaxDurationCapS)
	}
	if !r.InputFormat.isZero() {
		if err := r.InputFormat.validate(); err != nil {
			return 0, 0, fmt.Errorf("input_format: %v", err)
		}
	} else {
		r.InputFormat = AudioFormat{Codec: "pcm_s16le", SampleRate: 16000, Channels: 1}
	}
	if !r.OutputFormat.isZero() {
		if err := r.OutputFormat.validate(); err != nil {
			return 0, 0, fmt.Errorf("output_format: %v", err)
		}
	} else {
		r.OutputFormat = AudioFormat{Codec: "pcm_s16le", SampleRate: 24000, Channels: 1}
	}
	return ringS, maxS, nil
}

// ---- 稳定错误码(§14) ----
type streamError struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable,omitempty"`
	ExpectedSeq *int64 `json:"expected_seq,omitempty"`
	QueuedMs   *int   `json:"queued_ms,omitempty"`
}

func retryable(code string) bool {
	switch code {
	case "buffer_full", "temporarily_unavailable", "rate_limited":
		return true
	}
	return false
}

// chunkHash 音频块指纹: 同 seq 同数据重传幂等, 不同数据冲突(§5.2)
func chunkHash(pcm []byte) string {
	h := sha256.Sum256(pcm)
	return hex.EncodeToString(h[:])
}

// decodeAudioChunk 解码并校验一块上行 PCM(§10.3)
func decodeAudioChunk(b64 string) ([]byte, *streamError) {
	if len(b64) == 0 {
		return nil, &streamError{Code: "invalid_message", Message: "audio_b64 为空"}
	}
	if len(b64) > StreamMaxB64Len {
		return nil, &streamError{Code: "invalid_message",
			Message: fmt.Sprintf("audio_b64 超长(%d > %d)", len(b64), StreamMaxB64Len)}
	}
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return nil, &streamError{Code: "invalid_message", Message: "audio_b64 不是合法 base64"}
	}
	if len(raw) == 0 {
		return nil, &streamError{Code: "invalid_message", Message: "解码后 PCM 为空"}
	}
	if len(raw) > StreamMaxChunkBytes {
		return nil, &streamError{Code: "invalid_message",
			Message: fmt.Sprintf("解码后 PCM 超长(%d > %d)", len(raw), StreamMaxChunkBytes)}
	}
	if len(raw)%2 != 0 {
		return nil, &streamError{Code: "invalid_message", Message: "PCM 必须是完整 16bit 采样"}
	}
	return raw, nil
}

// chunkDurationMs 一块 PCM 的时长(客户端输入采样域)
func chunkDurationMs(bytes, sampleRate int) float64 {
	if sampleRate <= 0 {
		return 0
	}
	return float64(bytes/2) * 1000 / float64(sampleRate)
}

// tokenBucket 控制命令限速(§10.3)
type tokenBucket struct {
	rate   float64 // tokens/s
	burst  float64
	tokens float64
	lastMs int64
	nowFn  func() int64 // ms
}

func newTokenBucket(ratePerS, burst int) *tokenBucket {
	return &tokenBucket{rate: float64(ratePerS), burst: float64(burst),
		tokens: float64(burst), lastMs: 0, nowFn: func() int64 { return monotimeMs() }}
}

func (b *tokenBucket) allow() bool {
	now := b.nowFn()
	if b.lastMs == 0 {
		b.lastMs = now
	}
	elapsed := float64(now-b.lastMs) / 1000.0
	b.lastMs = now
	b.tokens += elapsed * b.rate
	if b.tokens > b.burst {
		b.tokens = b.burst
	}
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}
