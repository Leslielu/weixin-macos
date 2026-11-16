package main

// voice_stream.go —— 实时语音流会话管理层(设计: docs/VOIP-STREAMING-DESIGN.md §3/§4/§6/§11)
//
// 权威职责: call_id、全局通话锁(与旧 voiceCallMu 同一把)、创建幂等、状态机
// reserved→dialing→connected→ending→ended、硬时限、JS ack 超时、统一 cleanup、
// 结束记录保留。会话内所有命令/事件/超时都串行在 actor goroutine 上处理。

import (
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
)

var streamProcessStart = time.Now()

func monotimeMs() int64 { return time.Since(streamProcessStart).Milliseconds() }

// ---- 配置 ----

type StreamConfig struct {
	Token          string   // 内部 Bearer token; 空 = 实时路由 fail-closed
	MaxDurationS   int      // 服务端总时长硬上限(从开始拨号计)
	QueueHardMs    int      // 播放队列硬上限
	AllowedOrigins []string // 浏览器 Origin 白名单; 空 = 带 Origin 的请求一律拒绝

	// 以下留空取默认值; 测试可注入短超时
	AttachTimeout  time.Duration
	StartTimeout   time.Duration
	AckTimeout     time.Duration
	StopAckTimeout time.Duration
	SweepEvery     time.Duration
}

// ---- manager ----

type StreamManager struct {
	mu       sync.Mutex
	cfg      StreamConfig
	backend  StreamBackend
	hub      *StreamHub
	sessions map[string]*streamSession
	idem     map[string]*streamIdemRecord
	ended    map[string]*streamEndedRecord
	healthy  bool
}

type streamIdemRecord struct {
	callID    string
	paramHash string
	resp      []byte
	expires   time.Time
}

type streamEndedRecord struct {
	CallID            string         `json:"call_id"`
	UserID            string         `json:"user_id"`
	Source            string         `json:"source,omitempty"`
	State             string         `json:"state"`
	EndReason         string         `json:"end_reason"`
	EndDetection      string         `json:"end_detection,omitempty"`
	ResourcesReleased bool           `json:"resources_released"`
	HangupRet         string         `json:"hangup_ret,omitempty"`
	Stats             map[string]any `json:"stats,omitempty"`
	EndedAtMs         int64          `json:"ended_at_ms"`
	endedAt           time.Time
}

func NewStreamManager(cfg StreamConfig, backend StreamBackend, hub *StreamHub) *StreamManager {
	if cfg.MaxDurationS <= 0 {
		cfg.MaxDurationS = StreamMaxDurationCapS
	}
	if cfg.QueueHardMs <= 0 {
		cfg.QueueHardMs = StreamQueueHardMs
	}
	if cfg.AttachTimeout <= 0 {
		cfg.AttachTimeout = StreamAttachTimeout * time.Second
	}
	if cfg.StartTimeout <= 0 {
		cfg.StartTimeout = StreamStartTimeout * time.Second
	}
	if cfg.AckTimeout <= 0 {
		cfg.AckTimeout = StreamAckTimeoutS * time.Second
	}
	if cfg.StopAckTimeout <= 0 {
		cfg.StopAckTimeout = StreamStopAckTimeoutS * time.Second
	}
	if cfg.SweepEvery <= 0 {
		cfg.SweepEvery = 500 * time.Millisecond
	}
	return &StreamManager{cfg: cfg, backend: backend, hub: hub,
		sessions: map[string]*streamSession{}, idem: map[string]*streamIdemRecord{},
		ended: map[string]*streamEndedRecord{}, healthy: true}
}

// Start 启动事件路由与记录清理(各一个 goroutine)
func (m *StreamManager) Start() {
	go m.routeLoop()
	go m.janitorLoop()
}

func (m *StreamManager) routeLoop() {
	for ev := range m.hub.Events() {
		callID, _ := ev.Fields["callId"].(string)
		m.mu.Lock()
		s := m.sessions[callID]
		m.mu.Unlock()
		if s == nil {
			continue
		}
		select {
		case s.bridgeCh <- ev:
		default:
			// 会话事件队列满: 交给 ack 超时/心跳兜底
			Info("voip-stream: 会话事件队列满", "call_id", callID)
		}
	}
}

func (m *StreamManager) janitorLoop() {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for range t.C {
		now := time.Now()
		m.mu.Lock()
		for k, rec := range m.idem {
			if now.After(rec.expires) {
				delete(m.idem, k)
			}
		}
		for k, rec := range m.ended {
			if now.Sub(rec.endedAt) > StreamRetentionMin*time.Minute {
				delete(m.ended, k)
			}
		}
		m.mu.Unlock()
	}
}

func (m *StreamManager) HasActiveSession() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.sessions) > 0
}

// ---- 状态快照(actor 发布, 外部只读) ----

type streamStatsSnapshot struct {
	gen             int64
	nextSeq         int64
	curSegment      string
	segCommitted    bool
	submittedEng    int64
	consumedSrc     int64
	queuedMs        int
	acceptedChunks  int
	inputFrames     int64
	gapFrames       int64
	gapSamples      int64
	inDropFrames    int64
	callerWxid      string
	roomId          string
	engineFormat    map[string]any
	answerDetection string
}

// ---- 会话 ----

type wsCommandKind int

const (
	wsCmdStart wsCommandKind = iota
	wsCmdAppend
	wsCmdCommit
	wsCmdClear
	wsCmdHangup
	wsCmdWSClosed
)

type wsCommand struct {
	kind       wsCommandKind
	requestID  string
	generation int64
	newGen     int64
	segmentID  string
	seq        int64
	lastSeq    int64
	pcm        []byte
	parseErr   *streamError
}

type streamPendingAppend struct {
	gen        int64
	seq        int64
	seg        string
	hash       string
	origReqID  string
	pcmMs      float64
	postedAtMs int64
}

type streamSession struct {
	id, userID, source string
	inFmt, outFmt      AudioFormat
	ringTimeout        time.Duration
	maxDuration        time.Duration
	createdAt          time.Time
	incoming           bool
	windowDeadline     time.Time // incoming: 布防窗口
	incomingOpts       StreamIncomingOpts

	mgr     *StreamManager
	backend StreamBackend

	mu                sync.Mutex
	state             string
	endReason         string
	endDetection      string
	dialed            bool
	answered          bool
	hangupRet         string
	resourcesReleased bool
	ws                *streamWSConn
	closed            bool

	// ---- actor 独占(actor goroutine 之外一律经 mu/atomic 访问) ----
	cmdCh    chan wsCommand
	bridgeCh chan StreamEvent
	outCh    chan map[string]any // 控制事件 → writer
	inCh     chan map[string]any // 下行音频帧 → writer
	stats    atomic.Pointer[streamStatsSnapshot]

	// 计数与协商状态(actor 独占写; 快照经 stats 发布)
	submittedEng    int64
	consumedSrc     int64
	queuedMs        int
	acceptedChunks  int
	inputFrames     int64
	gapFrames       int64
	gapSamples      int64
	inDropFrames    int64
	inDropSamples   int64
	callerWxid      string
	roomId          string
	engineFormat    map[string]any
	answerDetection string

	evSeq            atomic.Int64
	gen              int64
	nextSeq          int64
	curSegment       string
	segCommitted     bool
	segHasData       bool
	segLastSeq       int64
	hashes           map[int64]string
	pending          map[string]*streamPendingAppend
	commitReqID      string
	clearing         bool
	clearReqID       string
	clearOldGen      int64
	lastProgress     string // 进度去重指纹
	audioSec         int64
	audioCount       int
	dropWinStartMs   int64
	dropWinCount     int
	pendingCommitAck string

	dialAt           time.Time
	connectedAt      time.Time
	attachDeadline   time.Time
	startDeadlineSet bool
	startDeadline    time.Time
	ringDeadline     time.Time
	durationDeadline time.Time
	stopAckDeadline  time.Time
	stopSeen         bool
}

func (m *StreamManager) newSession(req *StreamCreateRequest, ringS, maxS, winS, delayMs int) *streamSession {
	id := uuid.New().String()
	s := &streamSession{
		id: id, userID: req.UserID, source: req.Source,
		inFmt: req.InputFormat, outFmt: req.OutputFormat,
		ringTimeout: time.Duration(ringS) * time.Second,
		maxDuration: time.Duration(maxS) * time.Second,
		createdAt:   time.Now(),
		incoming:    req.Mode == "incoming_stream",
		windowDeadline: time.Now().Add(time.Duration(winS) * time.Second),
		incomingOpts: StreamIncomingOpts{
			InputRate: req.InputFormat.SampleRate, OutputRate: req.OutputFormat.SampleRate,
			QueueHardMs: m.cfg.QueueHardMs, MaxSeconds: maxS,
			WindowS: winS, AnswerDelayMs: delayMs,
			MuteMic: boolOr(req.MuteMic, true), MicGate: boolOr(req.MicGate, true),
		},
		mgr:      m,
		backend:  m.backend,
		state:    "reserved",
		gen:      1,
		cmdCh:    make(chan wsCommand, 1024),
		bridgeCh: make(chan StreamEvent, 512),
		outCh:    make(chan map[string]any, 256),
		inCh:     make(chan map[string]any, StreamInputQueueMax),
		hashes:   map[int64]string{},
		pending:  map[string]*streamPendingAppend{},
	}
	s.publishStats()
	return s
}

func (s *streamSession) publishStats() {
	snap := &streamStatsSnapshot{
		gen: s.gen, nextSeq: s.nextSeq, curSegment: s.curSegment,
		segCommitted: s.segCommitted, submittedEng: s.submittedEng,
		consumedSrc: s.consumedSrc, queuedMs: s.queuedMs,
		acceptedChunks: s.acceptedChunks, inputFrames: s.inputFrames,
		gapFrames: s.gapFrames, gapSamples: s.gapSamples,
		inDropFrames: s.inDropFrames, callerWxid: s.callerWxid,
		roomId: s.roomId, engineFormat: s.engineFormat,
		answerDetection: s.answerDetection,
	}
	s.stats.Store(snap)
}

func (s *streamSession) run() {
	s.attachDeadline = s.createdAt.Add(s.mgr.cfg.AttachTimeout)
	t := time.NewTicker(s.mgr.cfg.SweepEvery)
	defer t.Stop()
	for {
		select {
		case cmd := <-s.cmdCh:
			s.handleCommand(cmd)
		case ev := <-s.bridgeCh:
			s.handleBridge(ev)
		case <-t.C:
			s.sweep()
		}
		if s.getState() == "ended" {
			return
		}
	}
}

func (s *streamSession) getState() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state
}

func (s *streamSession) setState(st string) {
	s.mu.Lock()
	s.state = st
	s.mu.Unlock()
}

func (s *streamSession) enqueueCmd(cmd wsCommand) {
	select {
	case s.cmdCh <- cmd:
	default:
		Warn("voip-stream: 命令队列满, 丢弃", "call_id", s.id, "kind", cmd.kind)
	}
}

// requestHangup 供 HTTP scoped hangup 调用
func (s *streamSession) requestHangup() {
	s.enqueueCmd(wsCommand{kind: wsCmdHangup})
}

// ---- 事件信封(§5.1) ----

func (s *streamSession) envelope(typ string) map[string]any {
	seq := s.evSeq.Add(1)
	m := map[string]any{
		"type": typ, "call_id": s.id,
		"event_seq": seq, "t_ms": time.Since(s.createdAt).Milliseconds(),
	}
	return m
}

func (s *streamSession) pushEvent(ev map[string]any) {
	s.mu.Lock()
	ws := s.ws
	closed := s.closed
	s.mu.Unlock()
	if ws == nil || closed {
		return
	}
	select {
	case s.outCh <- ev:
	default:
		if ev["type"] == "audio.progress" {
			return // 进度可丢; 其余事件队满视为媒体异常
		}
		Warn("voip-stream: 事件队列满", "call_id", s.id, "type", ev["type"])
	}
}

func (s *streamSession) pushCritical(ev map[string]any) {
	s.mu.Lock()
	ws := s.ws
	closed := s.closed
	s.mu.Unlock()
	if ws == nil || closed {
		return
	}
	select {
	case s.outCh <- ev:
	case <-time.After(time.Second):
		Warn("voip-stream: 关键事件写入超时", "call_id", s.id, "type", ev["type"])
	}
}

func (s *streamSession) errorEvent(reqID, code, msg string, extra map[string]any) map[string]any {
	e := s.envelope("error")
	if reqID != "" {
		e["request_id"] = reqID
	}
	e["fatal"] = false
	er := map[string]any{"code": code, "message": msg, "retryable": retryable(code)}
	for k, v := range extra {
		er[k] = v
	}
	e["error"] = er
	return e
}

func (s *streamSession) fatalEvent(reqID, code, msg string) map[string]any {
	e := s.errorEvent(reqID, code, msg, nil)
	e["fatal"] = true
	return e
}

// ---- 命令处理 ----

func (s *streamSession) handleCommand(cmd wsCommand) {
	if cmd.parseErr != nil {
		s.pushEvent(s.errorEvent(cmd.requestID, cmd.parseErr.Code, cmd.parseErr.Message, nil))
		return
	}
	switch cmd.kind {
	case wsCmdStart:
		s.cmdStart(cmd)
	case wsCmdAppend:
		s.cmdAppend(cmd)
	case wsCmdCommit:
		s.cmdCommit(cmd)
	case wsCmdClear:
		s.cmdClear(cmd)
	case wsCmdHangup:
		s.cmdHangup(cmd)
	case wsCmdWSClosed:
		s.cmdWSClosed()
	}
}

func (s *streamSession) cmdStart(cmd wsCommand) {
	if s.incoming {
		// 入站: 创建即布防, call.start 幂等确认(无拨号动作)
		st := s.envelope("call.state")
		st["request_id"] = cmd.requestID
		st["state"] = s.getState()
		s.pushEvent(st)
		return
	}
	switch s.getState() {
	case "reserved":
		s.setState("dialing")
		s.dialed = true
		s.mu.Lock()
		s.dialAt = time.Now()
		s.ringDeadline = s.dialAt.Add(s.ringTimeout)
		s.durationDeadline = s.dialAt.Add(s.maxDuration)
		s.mu.Unlock()
		st := s.envelope("call.state")
		st["request_id"] = cmd.requestID
		st["state"] = "dialing"
		s.pushEvent(st)
		// 拨号是同步 RPC(≤10s), 阻塞 actor 可接受(dialing 期间无其他媒体要处理)
		opts := StreamDialOpts{
			InputRate: s.inFmt.SampleRate, OutputRate: s.outFmt.SampleRate,
			QueueHardMs: s.mgr.cfg.QueueHardMs,
			MaxSeconds:  int(s.maxDuration.Seconds()),
		}
		if err := s.dialWithWarmup(opts); err != nil {
			Warn("voip-stream: 拨号失败", "call_id", s.id, "err", err)
			s.finalizeNoJS("dial_failed", "", err.Error())
		}
	case "dialing", "connected":
		st := s.envelope("call.state")
		st["request_id"] = cmd.requestID
		st["state"] = s.getState()
		if s.engineFormat != nil {
			st["engine_format"] = s.engineFormat
		}
		s.pushEvent(st)
	default:
		s.pushEvent(s.errorEvent(cmd.requestID, "invalid_state",
			"call.start 仅在 reserved 状态有效", nil))
	}
}

// dialWithWarmup 微信重启后 VoIP 客户端单例延迟初始化([+0x28]), 立即拨号会失败。
// 对该特定错误 1s×20 次重试(约 20s, 在 ring 预算内); 其他拨号错误不重试。
func (s *streamSession) dialWithWarmup(opts StreamDialOpts) error {
	err := s.backend.Dial(s.id, s.userID, opts)
	if err == nil {
		return nil
	}
	for i := 0; i < 20; i++ {
		if !strings.Contains(err.Error(), "未初始化") {
			return err
		}
		if i == 0 {
			Info("voip-stream: VoIP 客户端未就绪, 等待初始化后重试", "call_id", s.id)
		}
		time.Sleep(time.Second)
		err = s.backend.Dial(s.id, s.userID, opts)
		if err == nil {
			Info("voip-stream: VoIP 客户端就绪, 拨号成功", "call_id", s.id,
				"waited_s", i+1)
			return nil
		}
	}
	return err
}

func (s *streamSession) cmdAppend(cmd wsCommand) {
	if s.getState() != "connected" {
		s.pushEvent(s.errorEvent(cmd.requestID, "invalid_state",
			"音频仅在 connected 后接受", nil))
		return
	}
	// 音频消息速率护栏(§10.3)
	nowMs := monotimeMs()
	sec := nowMs / 1000
	if s.audioSec != sec {
		s.audioSec = sec
		s.audioCount = 0
	}
	s.audioCount++
	if s.audioCount > StreamAudioMsgRateMax {
		s.pushEvent(s.errorEvent(cmd.requestID, "rate_limited", "音频消息频率超限", nil))
		return
	}
	if s.clearing {
		s.pushEvent(s.errorEvent(cmd.requestID, "temporarily_unavailable",
			"清理进行中, 收到 cleared 后重发", nil))
		return
	}
	if cmd.generation < s.gen {
		s.pushEvent(s.errorEvent(cmd.requestID, "stale_generation", "旧代数据", nil))
		return
	}
	if cmd.generation > s.gen {
		s.pushEvent(s.errorEvent(cmd.requestID, "invalid_generation", "未来代次", nil))
		return
	}
	// segment 顺序: 上一段必须 commit
	if s.curSegment == "" {
		if cmd.segmentID == "" {
			s.pushEvent(s.errorEvent(cmd.requestID, "invalid_message", "segment_id 必填", nil))
			return
		}
	} else if cmd.segmentID != s.curSegment {
		if !s.segCommitted {
			s.pushEvent(s.errorEvent(cmd.requestID, "segment_not_committed",
				"上一 segment 尚未 commit", nil))
			return
		}
	}
	// 序号规则(§5.2): 在途窗口 —— 每个 in-flight pending 恰好允许一个后继 seq
	// (JS FIFO 保序, 接受必连续; ack 未回时后续 seq 不再被误判 invalid_seq。
	// 2026-11-15 轮B实测: 旧严格等号判定让 ack 延迟 > 发送间隔时级联拒绝且不可恢复;
	// 真·跳号(中间 seq 既未接受也非在途)仍然拒绝并回 expected_seq)
	if cmd.seq > s.nextSeq {
		if cmd.seq-s.nextSeq > int64(len(s.pending)) {
			exp := s.nextSeq
			s.pushEvent(s.errorEvent(cmd.requestID, "invalid_seq", "seq 跳号",
				map[string]any{"expected_seq": exp}))
			return
		}
	}
	if cmd.seq < s.nextSeq {
		// 幂等重传: 同 seq 同数据重发 accepted; 不同数据冲突
		if h, ok := s.hashes[cmd.seq]; ok && chunkHash(cmd.pcm) == h {
			s.pushEvent(s.acceptedEvent(cmd.requestID, cmd.generation, cmd.segmentID, cmd.seq))
			return
		}
		s.pushEvent(s.errorEvent(cmd.requestID, "seq_conflict",
			"同 seq 不同数据", nil))
		return
	}
	// 队列硬上限预检(JS 侧是权威, Go 预检省一次往返)
	chunkMs := chunkDurationMs(len(cmd.pcm), s.inFmt.SampleRate)
	if s.queuedMs+int(chunkMs) > s.mgr.cfg.QueueHardMs {
		q := s.queuedMs
		s.pushEvent(s.errorEvent(cmd.requestID, "buffer_full", "播放队列已满",
			map[string]any{"queued_ms": q}))
		return
	}
	if len(s.pending) >= StreamAppendInFlightMax {
		s.pushEvent(s.errorEvent(cmd.requestID, "buffer_full", "在途 append 窗口已满", nil))
		return
	}
	reqID := fmt.Sprintf("%s-%d-%d", s.id[:8], cmd.generation, cmd.seq)
	// 同 seq 在途重复(客户端超时重发): 拒绝为可重试, 不重复投 JS(会双播)
	if _, dup := s.pending[reqID]; dup {
		s.pushEvent(s.errorEvent(cmd.requestID, "temporarily_unavailable",
			"同 seq 在途确认中, 稍后重试", nil))
		return
	}
	s.pending[reqID] = &streamPendingAppend{
		gen: cmd.generation, seq: cmd.seq, seg: cmd.segmentID,
		hash: chunkHash(cmd.pcm), origReqID: cmd.requestID,
		pcmMs: chunkMs, postedAtMs: nowMs,
	}
	_ = s.backend.Append(s.id, reqID, cmd.generation, cmd.segmentID, cmd.seq, cmd.pcm)
}

func (s *streamSession) acceptedEvent(reqID string, gen int64, seg string, seq int64) map[string]any {
	e := s.envelope("audio.accepted")
	if reqID != "" {
		e["request_id"] = reqID
	}
	e["generation"] = gen
	e["segment_id"] = seg
	e["seq"] = seq
	e["queued_ms"] = s.queuedMs
	e["scope"] = "queued_in_onebot"
	return e
}

func (s *streamSession) cmdCommit(cmd wsCommand) {
	if s.getState() != "connected" {
		s.pushEvent(s.errorEvent(cmd.requestID, "invalid_state", "仅 connected 可 commit", nil))
		return
	}
	if cmd.generation != s.gen {
		code := "stale_generation"
		if cmd.generation > s.gen {
			code = "invalid_generation"
		}
		s.pushEvent(s.errorEvent(cmd.requestID, code, "代次不匹配", nil))
		return
	}
	if s.curSegment == "" || cmd.segmentID != s.curSegment {
		s.pushEvent(s.errorEvent(cmd.requestID, "empty_segment", "segment 不存在或已提交", nil))
		return
	}
	if !s.segHasData {
		s.pushEvent(s.errorEvent(cmd.requestID, "empty_segment", "该 segment 无已接受数据", nil))
		return
	}
	if cmd.lastSeq != s.segLastSeq {
		exp := s.segLastSeq
		s.pushEvent(s.errorEvent(cmd.requestID, "invalid_seq",
			"last_seq 与该段最后已接受 seq 不符",
			map[string]any{"expected_seq": exp}))
		return
	}
	s.segCommitted = true
	s.pendingCommitAck = cmd.requestID
	_ = s.backend.Commit(s.id, fmt.Sprintf("%s-commit-%d", s.id[:8], cmd.generation), cmd.generation, cmd.segmentID)
}

func (s *streamSession) cmdClear(cmd wsCommand) {
	if s.getState() != "connected" {
		s.pushEvent(s.errorEvent(cmd.requestID, "invalid_state", "仅 connected 可 clear", nil))
		return
	}
	if cmd.newGen != s.gen+1 {
		s.pushEvent(s.errorEvent(cmd.requestID, "invalid_generation",
			"clear 的 generation 必须是当前代+1", nil))
		return
	}
	if s.clearing {
		s.pushEvent(s.errorEvent(cmd.requestID, "temporarily_unavailable",
			"上一次 clear 仍在清理", nil))
		return
	}
	s.clearing = true
	s.clearReqID = cmd.requestID
	s.clearOldGen = s.gen
	_ = s.backend.Clear(s.id, fmt.Sprintf("%s-clear-%d", s.id[:8], cmd.newGen), s.gen, cmd.newGen)
}

func (s *streamSession) cmdHangup(cmd wsCommand) {
	switch s.getState() {
	case "reserved":
		if s.incoming {
			// 布防解除: JS 会话在场, 需走 Stop → stopped → 收尾(dialed=false 不调原生挂断)
			s.beginEnding("local_hangup", "")
		} else {
			s.finalizeNoJS("local_hangup", "", "")
		}
	case "ringing":
		// 来电响铃中解除: 不接听、不拒接, 布防取消(铃声自然停止)
		s.beginEnding("local_hangup", "")
	case "dialing", "connected":
		s.beginEnding("local_hangup", "")
	default:
		// ending/ended: 幂等, call.ended 会跟上
	}
}

func (s *streamSession) cmdWSClosed() {
	s.mu.Lock()
	s.ws = nil
	s.mu.Unlock()
	switch s.getState() {
	case "reserved":
		s.finalizeNoJS("client_disconnected", "", "")
	case "dialing", "connected":
		s.beginEnding("client_disconnected", "")
	}
}

// ---- JS 事件处理 ----

func evStr(f map[string]any, k string) string {
	v, _ := f[k].(string)
	return v
}

func evInt(f map[string]any, k string) int64 {
	switch v := f[k].(type) {
	case float64:
		return int64(v)
	case int64:
		return v
	case int:
		return int64(v)
	}
	return 0
}

func (s *streamSession) handleBridge(ev StreamEvent) {
	f := ev.Fields
	switch evStr(f, "ev") {
	case "state":
		s.bridgeState(f)
	case "stopped":
		s.bridgeStopped(evStr(f, "reason"))
	case "append_ack":
		s.bridgeAppendAck(f)
	case "commit_ack":
		if s.pendingCommitAck != "" {
			reqID := s.pendingCommitAck
			s.pendingCommitAck = ""
			if b, _ := f["ok"].(bool); b {
				r := s.envelope("result")
				r["request_id"] = reqID
				r["ok"] = true
				r["op"] = "commit"
				s.pushEvent(r)
			} else {
				s.pushEvent(s.errorEvent(reqID, evStr(f, "code"), "commit 被拒绝", nil))
			}
		}
	case "clear_ack":
		s.bridgeClearAck(f)
	case "stats":
		s.bridgeStats(f)
	case "segment_done":
		e := s.envelope("audio.segment_done")
		e["generation"] = evInt(f, "generation")
		e["segment_id"] = evStr(f, "segmentId")
		e["consumed_samples"] = evInt(f, "consumedSamples")
		e["submitted_native_samples"] = evInt(f, "submittedEngSamples")
		e["scope"] = "submitted_to_wechat"
		s.pushEvent(e)
	case "input":
		s.bridgeInput(f, ev.Data)
	case "input_gap":
		// JS 报的是累计值, 取 max
		s.mu.Lock()
		if gf := evInt(f, "frames"); gf > s.gapFrames {
			s.gapFrames = gf
		}
		if gs := evInt(f, "missingSamples"); gs > s.gapSamples {
			s.gapSamples = gs
		}
		s.mu.Unlock()
	case "backend_error":
		if s.getState() == "connected" || s.getState() == "dialing" {
			s.beginEnding("backend_error", evStr(f, "detail"))
		}
	}
}

func (s *streamSession) bridgeState(f map[string]any) {
	switch evStr(f, "state") {
	case "ringing":
		if s.getState() != "reserved" {
			return
		}
		s.mu.Lock()
		s.state = "ringing"
		if cw, _ := f["callerWxid"].(string); cw != "" {
			s.callerWxid = cw
		}
		if rid, _ := f["roomId"].(string); rid != "" {
			s.roomId = rid
		}
		caller := s.callerWxid
		s.mu.Unlock()
		s.publishStats()
		st := s.envelope("call.state")
		st["state"] = "ringing"
		if v, ok := f["roomKnown"].(bool); ok {
			st["room_known"] = v
		}
		if caller != "" {
			st["caller_wxid"] = caller
		}
		s.pushEvent(st)
		Info("voip-stream: 来电响铃", "call_id", s.id, "caller", caller)
	case "connected":
		st := s.getState()
		if st != "dialing" && st != "ringing" {
			return
		}
		ef, _ := f["engineFormat"].(map[string]any)
		s.mu.Lock()
		s.state = "connected"
		s.answered = true
		s.connectedAt = time.Now()
		if s.incoming {
			s.durationDeadline = s.connectedAt.Add(s.maxDuration) // 通话时长自接通计
		}
		s.answerDetection = evStr(f, "answerDetection")
		if s.answerDetection == "" {
			s.answerDetection = "put_ready_inferred"
		}
		s.engineFormat = ef
		s.mu.Unlock()
		s.publishStats()
		stEv := s.envelope("call.state")
		stEv["state"] = "connected"
		stEv["answer_detection"] = s.answerDetection
		s.mu.Lock()
		if s.callerWxid != "" {
			stEv["caller_wxid"] = s.callerWxid
		}
		s.mu.Unlock()
		if ef != nil {
			stEv["engine_format"] = ef
		}
		s.pushEvent(stEv)
		Info("voip-stream: 已接通", "call_id", s.id, "user_id", s.userID,
			"detection", s.answerDetection, "incoming", s.incoming)
	case "remote_end_hint":
		if s.getState() == "connected" {
			s.beginEnding("remote_hangup", "start_talk_down_inferred")
		}
	}
}

func (s *streamSession) bridgeStopped(reason string) {
	s.mu.Lock()
	s.resourcesReleased = true
	s.stopSeen = true
	s.mu.Unlock()
	mapped := reason
	switch {
	case reason == "ring_timeout":
		mapped = "ring_timeout"
	case reason == "engine_lost":
		mapped = "remote_end_unknown"
	case len(reason) > 13 && reason[:13] == "backend_error":
		mapped = "backend_error"
	}
	switch s.getState() {
	case "ending":
		if s.endReason == "" {
			s.mu.Lock()
			s.endReason = mapped
			s.mu.Unlock()
		}
		s.completeEnding()
	case "dialing", "connected", "ringing":
		s.beginEnding(mapped, "")
		s.completeEnding() // JS 已停, 无需等 stop ack
	default:
		// reserved(出站未拨): JS 不可能有会话
	}
}

func (s *streamSession) bridgeAppendAck(f map[string]any) {
	reqID := evStr(f, "reqId")
	p := s.pending[reqID]
	if p == nil {
		return
	}
	delete(s.pending, reqID)
	if b, _ := f["ok"].(bool); b {
		s.nextSeq = p.seq + 1
		s.hashes[p.seq] = p.hash
		s.queuedMs = int(evInt(f, "queuedMs"))
		if s.curSegment != p.seg {
			s.curSegment = p.seg
			s.segCommitted = false
			s.segHasData = false
		}
		s.segHasData = true
		s.segLastSeq = p.seq
		s.acceptedChunks++
		s.publishStats()
		s.pushEvent(s.acceptedEvent(p.origReqID, p.gen, p.seg, p.seq))
	} else {
		code := evStr(f, "code")
		if code == "" {
			code = "backend_error"
		}
		extra := map[string]any{}
		if q := evInt(f, "queuedMs"); q > 0 {
			extra["queued_ms"] = int(q)
		}
		s.pushEvent(s.errorEvent(p.origReqID, code, "append 被拒绝", extra))
	}
}

func (s *streamSession) bridgeClearAck(f map[string]any) {
	if !s.clearing {
		return
	}
	s.clearing = false
	if b, _ := f["ok"].(bool); !b {
		s.pushEvent(s.errorEvent(s.clearReqID, evStr(f, "code"), "clear 被拒绝", nil))
		return
	}
	oldGen := s.clearOldGen
	newGen := evInt(f, "newGeneration")
	if newGen != oldGen+1 {
		newGen = oldGen + 1
	}
	s.gen = newGen
	s.nextSeq = 0
	s.hashes = map[int64]string{}
	s.pending = map[string]*streamPendingAppend{}
	s.segCommitted = false
	s.segHasData = false
	s.segLastSeq = 0
	s.curSegment = ""
	s.lastProgress = ""
	s.publishStats()
	e := s.envelope("audio.cleared")
	e["request_id"] = s.clearReqID
	e["old_generation"] = oldGen
	e["new_generation"] = newGen
	e["final_progress"] = map[string]any{
		"segment_id":       evStr(f, "finalSegment"),
		"consumed_samples": evInt(f, "consumedSamples"),
	}
	e["dropped_samples"] = evInt(f, "droppedSamples")
	e["onebot_queue_empty"] = true
	e["old_generation_future_submissions"] = false
	e["native_submitted_reclaimable"] = false
	e["sdk_residual_upper_ms"] = nil
	s.pushEvent(e)
	Info("voip-stream: clear 完成", "call_id", s.id, "gen", oldGen, "→", newGen,
		"dropped", evInt(f, "droppedSamples"))
}

func (s *streamSession) bridgeStats(f map[string]any) {
	s.mu.Lock()
	s.submittedEng = evInt(f, "submittedEngSamples")
	s.consumedSrc = evInt(f, "consumedSamples")
	s.queuedMs = int(evInt(f, "queuedMs"))
	gen := s.gen
	seg := s.curSegment
	s.mu.Unlock()
	s.publishStats()
	fp := fmt.Sprintf("%d|%s|%d|%d|%d", gen, seg, s.consumedSrc, s.submittedEng, s.queuedMs)
	if fp == s.lastProgress || s.getState() != "connected" {
		return
	}
	s.lastProgress = fp
	e := s.envelope("audio.progress")
	e["generation"] = gen
	e["segment_id"] = seg
	e["consumed_samples"] = s.consumedSrc
	e["submitted_native_samples"] = s.submittedEng
	e["queued_ms"] = s.queuedMs
	e["scope"] = "submitted_to_wechat"
	s.pushEvent(e)
}

func (s *streamSession) bridgeInput(f map[string]any, data []byte) {
	if data == nil || len(data) == 0 {
		return
	}
	s.mu.Lock()
	s.inputFrames++
	s.mu.Unlock()
	e := s.envelope("audio.input")
	e["seq"] = evInt(f, "seq")
	e["sample_offset"] = evInt(f, "sampleOffset")
	e["rate"] = evInt(f, "rate")
	e["samples"] = evInt(f, "samples")
	s.mu.Lock()
	e["gap"] = map[string]any{"frames": s.gapFrames, "missing_samples": s.gapSamples}
	s.mu.Unlock()
	e["audio_b64"] = base64.StdEncoding.EncodeToString(data)
	// 下行帧走 inCh(独立于控制事件), 满则丢最旧(§10.2)
	s.mu.Lock()
	closed := s.closed
	s.mu.Unlock()
	if closed {
		return
	}
	select {
	case s.inCh <- e:
	default:
		select {
		case <-s.inCh:
			s.inDropFrames++
			s.inDropSamples += evInt(f, "samples")
		default:
		}
		select {
		case s.inCh <- e:
		default:
		}
		// 持续积压判定: 2s 滑动窗口内丢帧达到阈值 ⇒ media_overflow
		// (不用"连续丢帧": 与 writer 交替成功会错误重置)
		nowMs := monotimeMs()
		if nowMs-s.dropWinStartMs > 2000 {
			s.dropWinStartMs = nowMs
			s.dropWinCount = 0
		}
		s.dropWinCount++
		if s.dropWinCount >= StreamMediaOverflowN && s.getState() == "connected" {
			s.beginEnding("media_overflow", "input_queue_sustained_overflow")
		}
	}
}

// ---- 结束路径(§11.1) ----

// finalizeNoJS: 无 JS 会话(ring 前)的结束: 无需 stop/hangup 等待
func (s *streamSession) finalizeNoJS(reason, detection, detail string) {
	if !s.casEnding(reason, detection) {
		return
	}
	s.mu.Lock()
	s.resourcesReleased = true
	s.mu.Unlock()
	s.completeEnding()
}

// casEnding 进入 ending; 返回 false 表示已在 ending/ended(幂等)
func (s *streamSession) casEnding(reason, detection string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.state != "reserved" && s.state != "dialing" && s.state != "connected" &&
		s.state != "ringing" {
		return false
	}
	s.state = "ending"
	if reason != "" {
		s.endReason = reason
	}
	if detection != "" {
		s.endDetection = detection
	}
	return true
}

// beginEnding: 有 JS 会话的结束: 先停 JS 生产, 等 stopped/超时再挂断收尾
func (s *streamSession) beginEnding(reason, detection string) {
	if !s.casEnding(reason, detection) {
		return
	}
	s.mu.Lock()
	s.stopAckDeadline = time.Now().Add(s.mgr.cfg.StopAckTimeout)
	s.mu.Unlock()
	_ = s.backend.Stop(s.id, reason)
}

// completeEnding: 挂断(如已拨) → call.ended → 释放资源。仅在 actor 上调用。
func (s *streamSession) completeEnding() {
	s.mu.Lock()
	if s.state != "ending" {
		s.mu.Unlock()
		return
	}
	stopSeen := s.stopSeen
	reason := s.endReason
	detection := s.endDetection
	s.mu.Unlock()
	if !stopSeen && s.dialed && time.Now().Before(s.stopAckDeadline) {
		return // 等 JS stopped(由 sweep 超时兜底再调)
	}
	// 原生挂断(已拨才调; JS stop 已停生产)
	if s.dialed {
		ret, err := s.backend.HangupNative()
		s.mu.Lock()
		if err != nil {
			s.hangupRet = "err:" + err.Error()
		} else {
			s.hangupRet = ret
		}
		s.mu.Unlock()
	}
	// call.ended
	stats := s.endedStats()
	s.mu.Lock()
	released := s.resourcesReleased
	s.mu.Unlock()
	e := s.envelope("call.ended")
	e["reason"] = reason
	if detection != "" {
		e["detection"] = detection
	}
	e["stats"] = stats
	e["resources_released"] = released
	s.pushCritical(e)
	// 收尾
	s.mu.Lock()
	s.state = "ended"
	s.closed = true
	s.mu.Unlock()
	close(s.outCh)
	close(s.inCh)
	s.mgr.finishSession(s, released, reason, detection)
	Info("voip-stream: 会话结束", "call_id", s.id, "user_id", s.userID,
		"reason", reason, "released", released, "hangup", s.hangupRet)
}

func (s *streamSession) endedStats() map[string]any {
	snap := s.stats.Load()
	durMs := int64(0)
	s.mu.Lock()
	if !s.dialAt.IsZero() {
		durMs = time.Since(s.dialAt).Milliseconds()
	} else if !s.connectedAt.IsZero() {
		durMs = time.Since(s.connectedAt).Milliseconds() // 入站: 自接通计
	}
	hr := s.hangupRet
	s.mu.Unlock()
	m := map[string]any{
		"duration_ms": durMs,
		"caller_wxid": snap.callerWxid,
		"room_id":     snap.roomId,
		"input": map[string]any{
			"frames": snap.inputFrames, "gap_frames": snap.gapFrames,
			"gap_missing_samples": snap.gapSamples,
			"dropped_frames":      snap.inDropFrames,
		},
		"output": map[string]any{
			"submitted_native_samples": snap.submittedEng,
			"consumed_samples":         snap.consumedSrc,
			"accepted_chunks":          snap.acceptedChunks,
			"queued_ms_final":          snap.queuedMs,
		},
		"generation":  snap.gen,
		"next_seq":    snap.nextSeq,
		"hangup_ret":  hr,
	}
	return m
}

func (s *streamSession) sweep() {
	now := time.Now()
	switch s.getState() {
	case "reserved":
		if s.incoming {
			// 布防窗口: 无来电自动释放(JS 会话在场 → 走 beginEnding 让 JS teardown)
			if now.After(s.windowDeadline) {
				s.beginEnding("window_expired", "")
				return
			}
			break
		}
		// attach 后由 start 截止接管; 未 attach 才看 attach 截止(§4.2)
		s.mu.Lock()
		sdSet := s.startDeadlineSet
		sd := s.startDeadline
		s.mu.Unlock()
		if sdSet {
			if now.After(sd) {
				s.finalizeNoJS("start_timeout", "", "")
				return
			}
		} else if now.After(s.attachDeadline) {
			s.finalizeNoJS("attach_timeout", "", "")
			return
		}
	case "dialing":
		if now.After(s.ringDeadline) {
			s.beginEnding("ring_timeout", "")
			return
		}
		if now.After(s.durationDeadline) {
			s.beginEnding("duration_limit", "")
			return
		}
	case "connected":
		if now.After(s.durationDeadline) {
			s.beginEnding("duration_limit", "")
			return
		}
	case "ending":
		s.mu.Lock()
		stopSeen := s.stopSeen
		s.mu.Unlock()
		// stop 每轮 sweep 重发直到 JS 确认: 单发曾被吞导致 JS 幽灵会话(背着 Go 接听了
		// 一通电话, 2026-11-16)。RPC 廉价, 幽灵会话会偷接来电并碰已释放引擎, 必须杀干净
		if !stopSeen {
			_ = s.backend.Stop(s.id, "stop-retry")
		}
		if stopSeen || now.After(s.stopAckDeadline) {
			s.completeEnding() // 确认 或 超时放弃(released=false)
			return
		}
	}
	// append ack 超时(§5: 无响应不等于成功)
	nowMs := monotimeMs()
	ackLimit := s.mgr.cfg.AckTimeout.Milliseconds()
	for _, p := range s.pending {
		if nowMs-p.postedAtMs > ackLimit {
			s.beginEnding("backend_error", "append_ack_timeout")
			return
		}
	}
}

// ---- manager 收尾 ----

func (m *StreamManager) finishSession(s *streamSession, released bool, reason, detection string) {
	m.mu.Lock()
	delete(m.sessions, s.id)
	rec := &streamEndedRecord{
		CallID: s.id, UserID: s.userID, Source: s.source, State: "ended",
		EndReason: reason, EndDetection: detection, ResourcesReleased: released,
		HangupRet: s.hangupRet, Stats: s.endedStats(), EndedAtMs: time.Now().UnixMilli(),
		endedAt: time.Now(),
	}
	m.ended[s.id] = rec
	if !released {
		m.healthy = false
	}
	m.mu.Unlock()
	// 释放全局通话锁(创建时 TryLock 持有)
	voiceCallMu.Unlock()
	voiceCallBusy.Store(false)
}

// ---- HTTP ----

func writeStreamJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func streamErrBody(code, msg string) map[string]any {
	return map[string]any{"status": "failed",
		"error": map[string]any{"code": code, "message": msg, "retryable": retryable(code)}}
}

var streamErrHTTP = map[string]int{
	"invalid_request":       400,
	"invalid_message":       400,
	"unauthorized":          401,
	"forbidden":             403,
	"not_found":             404,
	"idempotency_conflict":  409,
	"call_busy":             409,
	"control_conflict":      409,
	"unsupported_format":    422,
	"backend_unhealthy":     503,
	"backend_error":         500,
}

func (m *StreamManager) authWrap(fn http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if m.cfg.Token == "" {
			writeStreamJSON(w, 503, streamErrBody("backend_unhealthy",
				"实时语音未配置 -stream_token, 路由已禁用"))
			return
		}
		auth := r.Header.Get("Authorization")
		const pref = "Bearer "
		if len(auth) <= len(pref) || auth[:len(pref)] != pref ||
			subtle.ConstantTimeCompare([]byte(auth[len(pref):]), []byte(m.cfg.Token)) != 1 {
			writeStreamJSON(w, 401, streamErrBody("unauthorized", "需要 Bearer token"))
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" {
			allowed := false
			for _, o := range m.cfg.AllowedOrigins {
				if o == origin {
					allowed = true
					break
				}
			}
			if !allowed {
				writeStreamJSON(w, 403, streamErrBody("forbidden", "Origin 不在白名单"))
				return
			}
		}
		fn(w, r)
	}
}

func (m *StreamManager) RegisterRoutes(mux *http.ServeMux) {
	if mux == nil {
		mux = http.DefaultServeMux
	}
	mux.HandleFunc("GET /voice_calls/capabilities", m.authWrap(m.handleCapabilities))
	mux.HandleFunc("POST /voice_calls", m.authWrap(m.handleCreate))
	mux.HandleFunc("GET /voice_calls/{id}", m.authWrap(m.handleStatus))
	mux.HandleFunc("POST /voice_calls/{id}/hangup", m.authWrap(m.handleHangup))
	mux.HandleFunc("GET /voice_calls/{id}/stream", m.authWrap(m.handleStreamWS))
}

func (m *StreamManager) handleCapabilities(w http.ResponseWriter, r *http.Request) {
	m.mu.Lock()
	busy := len(m.sessions) > 0
	healthy := m.healthy
	m.mu.Unlock()
	data := map[string]any{
		"protocol_version": StreamProtocolVersion,
		"modes":            []string{"outbound_stream", "incoming_stream"},
		"duplex":           true,
		"input_source":     "remote_downlink",
		"remote_independent_track": false,
		"remote_independent_track_note": "待真实自声回环验收后置 true",
		"input_formats":   []map[string]any{{"codec": "pcm_s16le", "sample_rates": []int{16000, 24000, 48000}, "channels": []int{1}}},
		"output_formats":  []map[string]any{{"codec": "pcm_s16le", "sample_rates": []int{16000, 24000, 48000}, "channels": []int{1}}},
		"frame_ms":        map[string]any{"preferred": 20, "min": 20, "max": 100},
		"answer_detection": "put_ready_inferred",
		"ringing_event":   false,
		"rejected_event":  false,
		"busy_event":      false,
		"remote_hangup_detection": "start_talk_down_inferred",
		"progress_scope":  "submitted_to_wechat",
		"progress_interval_ms": 100,
		"segment_done_scope": "submitted_to_wechat",
		"remote_heard_progress": false,
		"onebot_queue_clear": true,
		"native_submitted_frame_reclaimable": false,
		"native_buffer_clear": false,
		"onebot_submission_quantum_ms": 20,
		"sdk_residual_upper_ms": nil,
		"remote_stop_position_available": false,
		"queue": map[string]any{"target_ms": StreamQueueTargetMs, "hard_ms": m.cfg.QueueHardMs},
		"max_duration_s":  m.cfg.MaxDurationS,
		"attach_timeout_s": StreamAttachTimeout,
		"incoming_window_default_s": StreamIncomingWindowDefaultS,
		"incoming_window_max_s":     StreamIncomingWindowMaxS,
		"incoming_answer_delay_ms":  StreamIncomingAnswerDelayMs,
		"heartbeat": map[string]any{"ping_s": StreamPingIntervalS, "pong_timeout_s": StreamPongTimeoutS},
		"recording": false,
		"busy":      busy,
		"backend_healthy": healthy,
	}
	writeStreamJSON(w, 200, map[string]any{"status": "ok", "retcode": 0, "data": data})
}

func (m *StreamManager) handleCreate(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 8192)
	var req StreamCreateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeStreamJSON(w, 400, streamErrBody("invalid_request", "请求体解析失败: "+err.Error()))
		return
	}
	ringS, maxS, winS, delayMs, err := req.validate()
	if err != nil {
		writeStreamJSON(w, 422, streamErrBody("unsupported_format", err.Error()))
		return
	}
	idemKey := r.Header.Get("Idempotency-Key")
	if len(idemKey) > 128 {
		writeStreamJSON(w, 400, streamErrBody("invalid_request", "Idempotency-Key 过长(≤128)"))
		return
	}
	if maxS > m.cfg.MaxDurationS {
		maxS = m.cfg.MaxDurationS
	}
	norm, _ := json.Marshal(map[string]any{"u": req.UserID, "ring": ringS, "max": maxS,
		"win": winS, "delay": delayMs, "mm": boolOr(req.MuteMic, true),
		"mg": boolOr(req.MicGate, true),
		"in": req.InputFormat, "out": req.OutputFormat})
	paramHash := chunkHash(norm)

	m.mu.Lock()
	// 幂等回放(§4.1)
	if idemKey != "" {
		if rec, ok := m.idem[idemKey]; ok && time.Now().Before(rec.expires) {
			if rec.paramHash != paramHash {
				m.mu.Unlock()
				writeStreamJSON(w, 409, streamErrBody("idempotency_conflict",
					"相同 Idempotency-Key 携带不同参数"))
				return
			}
			m.mu.Unlock()
			w.Header().Set("Idempotency-Replayed", "true")
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(201)
			_, _ = w.Write(rec.resp)
			return
		}
	}
	if !m.healthy {
		m.mu.Unlock()
		writeStreamJSON(w, 503, streamErrBody("backend_unhealthy",
			"上一通清理未确认释放, 拒绝新通话(需重启 onebot 恢复)"))
		return
	}
	m.mu.Unlock()

	// 全局通话锁: 与旧文件通话/入站接听共用同一把 voiceCallMu(§11.2);
	// 持有直到会话结束(finishSession 统一释放)
	if !voiceCallMu.TryLock() {
		writeStreamJSON(w, 409, streamErrBody("call_busy", "已有通话进行中"))
		return
	}
	voiceCallBusy.Store(true)

	s := m.newSession(&req, ringS, maxS, winS, delayMs)
	// 入站: 创建即布防(JS RecvNotify hook 武装)。同步 RPC(≤10s), 失败即回滚。
	if s.incoming {
		if err := s.backend.ArmIncoming(s.id, s.userID, s.incomingOpts); err != nil {
			voiceCallMu.Unlock()
			voiceCallBusy.Store(false)
			Warn("voip-stream: 入站布防失败", "err", err)
			writeStreamJSON(w, 500, streamErrBody("backend_error",
				"布防失败: "+err.Error()))
			return
		}
	}
	respBody, _ := json.Marshal(map[string]any{"status": "ok", "retcode": 0, "data": map[string]any{
		"protocol_version": StreamProtocolVersion,
		"call_id":          s.id,
		"state":            "reserved",
		"stream_path":      "/voice_calls/" + s.id + "/stream",
		"input_format":     s.inFmt,
		"output_format":    s.outFmt,
		"engine_format":    nil,
		"format_status":    "pending_dial",
		"attach_deadline_ms": s.createdAt.Add(StreamAttachTimeout * time.Second).UnixMilli(),
	}})
	m.mu.Lock()
	if idemKey != "" {
		if len(m.idem) >= StreamIdemMaxEntries {
			m.mu.Unlock()
			voiceCallMu.Unlock()
			voiceCallBusy.Store(false)
			writeStreamJSON(w, 503, streamErrBody("backend_unhealthy",
				"幂等记录已满, 请稍后重试"))
			return
		}
		m.idem[idemKey] = &streamIdemRecord{callID: s.id, paramHash: paramHash,
			resp: respBody, expires: time.Now().Add(StreamRetentionMin * time.Minute)}
	}
	m.sessions[s.id] = s
	m.mu.Unlock()
	go s.run()
	Info("voip-stream: 会话预留", "call_id", s.id, "user_id", s.userID, "source", s.source)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(201)
	_, _ = w.Write(respBody)
}

func (m *StreamManager) lookupAny(id string) *streamSession {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.sessions[id]
}

func (m *StreamManager) handleStatus(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if s := m.lookupAny(id); s != nil {
		writeStreamJSON(w, 200, map[string]any{"status": "ok", "retcode": 0,
			"data": s.snapshot()})
		return
	}
	m.mu.Lock()
	rec := m.ended[id]
	m.mu.Unlock()
	if rec != nil {
		writeStreamJSON(w, 200, map[string]any{"status": "ok", "retcode": 0,
			"data": rec})
		return
	}
	writeStreamJSON(w, 404, streamErrBody("not_found", "call_id 不存在或已过保留期"))
}

func (m *StreamManager) handleHangup(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if s := m.lookupAny(id); s != nil {
		s.requestHangup()
		writeStreamJSON(w, 200, map[string]any{"status": "ok", "retcode": 0,
			"data": map[string]any{"call_id": id, "state": s.getState()}})
		return
	}
	m.mu.Lock()
	rec := m.ended[id]
	m.mu.Unlock()
	if rec != nil {
		// 幂等: 已结束返回原结束结果
		writeStreamJSON(w, 200, map[string]any{"status": "ok", "retcode": 0, "data": rec})
		return
	}
	writeStreamJSON(w, 404, streamErrBody("not_found", "call_id 不存在或已过保留期"))
}

func (s *streamSession) snapshot() map[string]any {
	s.mu.Lock()
	st := s.state
	reason := s.endReason
	detection := s.endDetection
	dialed := s.dialed
	answered := s.answered
	released := s.resourcesReleased
	s.mu.Unlock()
	snap := s.stats.Load()
	m := map[string]any{
		"call_id": s.id, "user_id": s.userID, "source": s.source,
		"direction": map[bool]string{true: "incoming", false: "outbound"}[s.incoming],
		"caller_wxid": snap.callerWxid,
		"room_id":     snap.roomId,
		"state": st, "end_reason": reason, "end_detection": detection,
		"dialed": dialed, "answered": answered, "resources_released": released,
		"input_format": s.inFmt, "output_format": s.outFmt,
		"generation": snap.gen, "next_seq": snap.nextSeq,
		"cur_segment": snap.curSegment, "seg_committed": snap.segCommitted,
		"queued_ms": snap.queuedMs,
		"received_samples": nil, // 上行"已接收"与 accepted 等价, 见 accepted_chunks
		"accepted_chunks": snap.acceptedChunks,
		"consumed_samples": snap.consumedSrc,
		"submitted_native_samples": snap.submittedEng,
		"input": map[string]any{"frames": snap.inputFrames,
			"gap_frames": snap.gapFrames, "gap_missing_samples": snap.gapSamples,
			"dropped_output_frames": snap.inDropFrames},
		"engine_format": snap.engineFormat,
		"answer_detection": snap.answerDetection,
		"last_event_seq": s.evSeq.Load(),
		"backend_healthy": s.mgr.Healthy(),
	}
	return m
}

func (m *StreamManager) Healthy() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.healthy
}
