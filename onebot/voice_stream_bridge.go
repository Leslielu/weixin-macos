package main

// voice_stream_bridge.go —— Go ⇄ Frida(JS) 流式桥(设计: docs/VOIP-STREAMING-DESIGN.md §3/§7/§8)
//
// 控制命令(append/commit/clear/stop)走 script.Post + 二进制附件, 与音频同一通道保序;
// 拨号/挂断走 RPC(safeExportsCall)。JS→Go 事件经 StreamHub 单通道汇入, 由 manager 路由。
// StreamBackend 接口可被假底层替换(设计 §17.1 自动化测试)。

import (
	"context"
	"encoding/json"
	"log"
	"sync"
	"time"
)

// ---- JS→Go 事件汇(单写入者: frida message 回调; 单读取者: manager router) ----

type StreamEvent struct {
	Fields map[string]any
	Data   []byte // audio.input 的 PCM(s16le LE, 客户端输出采样域)
}

type StreamHub struct {
	ch    chan StreamEvent
	mu    sync.Mutex
	drops int
}

func NewStreamHub() *StreamHub {
	return &StreamHub{ch: make(chan StreamEvent, 1024)}
}

// Submit 由 frida message 回调调用, 永不阻塞; 满则丢弃计数(异常拥塞由会话超时兜底)
func (h *StreamHub) Submit(fields map[string]any, data []byte) {
	if fields == nil || fields["type"] != "voip_stream" {
		return
	}
	ev := StreamEvent{Fields: fields, Data: data}
	select {
	case h.ch <- ev:
	default:
		h.mu.Lock()
		h.drops++
		n := h.drops
		h.mu.Unlock()
		if n%100 == 1 {
			log.Printf("[ERROR] voip-stream: hub 满, 已丢弃 %d 个事件", n)
		}
	}
}

func (h *StreamHub) Events() <-chan StreamEvent { return h.ch }

// ---- 抽象后端 ----

type StreamDialOpts struct {
	InputRate   int
	OutputRate  int
	QueueHardMs int
	MaxSeconds  int
}

type StreamBackend interface {
	Dial(callID, userID string, opts StreamDialOpts) error
	Append(callID, reqID string, gen int64, seg string, seq int64, pcm []byte) error
	Commit(callID, reqID string, gen int64, seg string) error
	Clear(callID, reqID string, oldGen, newGen int64) error
	Stop(callID, reason string) error
	HangupNative() (string, error)
}

// ---- Frida 实现 ----

type fridaStreamBackend struct{}

func streamPostMeta(op, callID, reqID string, extra map[string]any, data []byte) {
	m := map[string]any{"type": "voip_stream_in", "op": op, "callId": callID}
	if reqID != "" {
		m["reqId"] = reqID
	}
	for k, v := range extra {
		m[k] = v
	}
	b, _ := json.Marshal(m)
	fridaScript.Post(string(b), data)
}

func (fridaStreamBackend) Dial(callID, userID string, opts StreamDialOpts) error {
	optsJSON, _ := json.Marshal(map[string]any{
		"inputRate":   opts.InputRate,
		"outputRate":  opts.OutputRate,
		"queueHardMs": opts.QueueHardMs,
		"maxSeconds":  opts.MaxSeconds,
	})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ret, err := safeExportsCall(ctx, "voipStreamDial", callID, userID, string(optsJSON))
	if err != nil {
		return err
	}
	s := jsString(ret)
	if s != "ok" {
		if len(s) > 120 {
			s = s[:120]
		}
		return &streamFailure{Code: s}
	}
	return nil
}

type streamFailure struct{ Code string }

func (e *streamFailure) Error() string { return e.Code }

func (fridaStreamBackend) Append(callID, reqID string, gen int64, seg string, seq int64, pcm []byte) error {
	streamPostMeta("append", callID, reqID, map[string]any{
		"generation": gen, "segmentId": seg, "seq": seq}, pcm)
	return nil
}

func (fridaStreamBackend) Commit(callID, reqID string, gen int64, seg string) error {
	streamPostMeta("commit", callID, reqID, map[string]any{
		"generation": gen, "segmentId": seg}, nil)
	return nil
}

func (fridaStreamBackend) Clear(callID, reqID string, oldGen, newGen int64) error {
	streamPostMeta("clear", callID, reqID, map[string]any{
		"oldGeneration": oldGen, "newGeneration": newGen}, nil)
	return nil
}

func (fridaStreamBackend) Stop(callID, reason string) error {
	streamPostMeta("stop", callID, "", map[string]any{"reason": reason}, nil)
	return nil
}

func (fridaStreamBackend) HangupNative() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ret, err := safeExportsCall(ctx, "triggerVoipHangup")
	if err != nil {
		return "", err
	}
	return jsString(ret), nil
}

// ---- 单例与接线 ----

var (
	streamHub     *StreamHub
	streamMgr     *StreamManager
	streamHubOnce sync.Once
)

// submitStreamEvent 供 main.go 的 frida message 回调调用(data 为二进制 PCM 或 nil)
func submitStreamEvent(fields map[string]any, data []byte) {
	if streamHub == nil {
		return
	}
	streamHub.Submit(fields, data)
}

// StreamBusy 供旧 /hangup_voice_call 等入口检查实时会话是否占用(§4.4/§11.2)
func StreamBusy() bool {
	if streamMgr == nil {
		return false
	}
	return streamMgr.HasActiveSession()
}
