package main

// voice_stream_ws.go —— 实时会话控制 WebSocket(设计: docs/VOIP-STREAMING-DESIGN.md §5/§10.4)
//
// 单通一个控制连接; 第二连接在升级前 409。读写分离: 读循环解析命令入 actor 队列,
// writer 单 goroutine 写 ping/控制事件/下行音频帧(禁止并发写)。
// 鉴权与 Origin 在 authWrap 完成; token 不落日志。

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
)

type streamWSConn struct {
	conn *websocket.Conn
}

var streamUpgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin:     func(r *http.Request) bool { return true }, // Origin 在 authWrap 校验
}

// parseWSCommand 解析客户端命令(§5.2); audio.append 在此解码 PCM(读 goroutine, 不占 actor)
func parseWSCommand(data []byte) wsCommand {
	var raw struct {
		Type       string `json:"type"`
		RequestID  string `json:"request_id"`
		Generation int64  `json:"generation"`
		SegmentID  string `json:"segment_id"`
		Seq        int64  `json:"seq"`
		LastSeq    int64  `json:"last_seq"`
		AudioB64   string `json:"audio_b64"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return wsCommand{parseErr: &streamError{Code: "invalid_message",
			Message: "JSON 解析失败: " + err.Error()}}
	}
	cmd := wsCommand{requestID: raw.RequestID}
	switch raw.Type {
	case "call.start":
		cmd.kind = wsCmdStart
	case "audio.append":
		cmd.kind = wsCmdAppend
		cmd.generation = raw.Generation
		cmd.segmentID = raw.SegmentID
		cmd.seq = raw.Seq
		pcm, serr := decodeAudioChunk(raw.AudioB64)
		if serr != nil {
			cmd.parseErr = serr
		} else {
			cmd.pcm = pcm
		}
	case "audio.commit":
		cmd.kind = wsCmdCommit
		cmd.generation = raw.Generation
		cmd.segmentID = raw.SegmentID
		cmd.lastSeq = raw.LastSeq
	case "audio.clear":
		cmd.kind = wsCmdClear
		cmd.newGen = raw.Generation // 设计 §5.2: clear 携带新 generation
	case "call.hangup":
		cmd.kind = wsCmdHangup
	default:
		cmd.parseErr = &streamError{Code: "invalid_message",
			Message: "未知命令 type: " + raw.Type}
	}
	if cmd.requestID == "" && cmd.parseErr == nil {
		cmd.parseErr = &streamError{Code: "invalid_message",
			Message: raw.Type + " 缺少 request_id"}
	}
	return cmd
}

func (s *streamSession) buildHello() map[string]any {
	h := s.envelope("hello")
	h["protocol_version"] = StreamProtocolVersion
	h["state"] = s.getState()
	h["direction"] = map[bool]string{true: "incoming", false: "outbound"}[s.incoming]
	h["input_format"] = s.inFmt
	h["output_format"] = s.outFmt
	h["input_source"] = "remote_downlink"
	h["engine_format"] = nil
	h["progress_scope"] = "submitted_to_wechat"
	h["progress_interval_ms"] = 100
	h["segment_done_scope"] = "submitted_to_wechat"
	h["remote_heard"] = false
	h["queue"] = map[string]any{"target_ms": StreamQueueTargetMs,
		"hard_ms": s.mgr.cfg.QueueHardMs, "input_max_frames": StreamInputQueueMax}
	h["heartbeat"] = map[string]any{"ping_s": StreamPingIntervalS,
		"pong_timeout_s": StreamPongTimeoutS}
	h["clear"] = map[string]any{"onebot_queue_clear": true,
		"native_buffer_clear": false, "sdk_residual_upper_ms": nil}
	h["limits"] = map[string]any{"max_chunk_bytes": StreamMaxChunkBytes,
		"control_rate_per_s": StreamControlRatePerS, "inflight_appends": StreamAppendInFlightMax}
	return h
}

// handleStreamWS GET /voice_calls/{id}/stream
func (m *StreamManager) handleStreamWS(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	m.mu.Lock()
	s := m.sessions[id]
	m.mu.Unlock()
	if s == nil {
		writeStreamJSON(w, 404, streamErrBody("not_found", "call_id 不存在或已结束"))
		return
	}
	// 第二控制连接冲突: 升级前拒绝(§4.2)
	s.mu.Lock()
	bound := s.ws != nil
	state := s.state
	s.mu.Unlock()
	if bound {
		writeStreamJSON(w, 409, streamErrBody("control_conflict", "该会话已有控制连接"))
		return
	}
	if state != "reserved" {
		writeStreamJSON(w, 409, streamErrBody("invalid_state",
			"会话状态为 "+state+", 仅 reserved 可连接"))
		return
	}
	conn, err := streamUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return // Upgrade 已写错误响应
	}
	s.mu.Lock()
	s.ws = &streamWSConn{conn: conn}
	if !s.incoming {
		// 入站无 call.start 动作, 无 start 截止; 窗口截止在 sweep
		s.startDeadlineSet = true
		s.startDeadline = time.Now().Add(s.mgr.cfg.StartTimeout)
	}
	s.mu.Unlock()
	Info("voip-stream: 控制连接建立", "call_id", s.id)

	s.pushCritical(s.buildHello())
	go s.writeLoop(conn)
	s.readLoop(conn)
}

// readLoop 读循环: 每条消息刷新读 deadline(pong/命令都算心跳)
func (s *streamSession) readLoop(conn *websocket.Conn) {
	defer func() {
		// WS 断开 → 停播/清队列/挂断(§6: P0 无断线恢复)
		s.enqueueCmd(wsCommand{kind: wsCmdWSClosed})
		_ = conn.Close()
	}()
	conn.SetReadLimit(StreamWSReadLimit)
	// pong 保活: 控制帧在 ReadMessage 内部消化不返回, 必须在处理器里刷新截止
	conn.SetPongHandler(func(_ string) error {
		return conn.SetReadDeadline(time.Now().Add(StreamPongTimeoutS * time.Second))
	})
	for {
		_ = conn.SetReadDeadline(time.Now().Add(StreamPongTimeoutS * time.Second))
		mt, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		if mt != websocket.TextMessage {
			continue
		}
		cmd := parseWSCommand(data)
		s.enqueueCmd(cmd)
	}
}

// writeLoop 单写者: 控制事件(outCh) + 下行音频帧(inCh) + ping(§10.4)
func (s *streamSession) writeLoop(conn *websocket.Conn) {
	ping := time.NewTicker(StreamPingIntervalS * time.Second)
	defer ping.Stop()
	outOpen, inOpen := true, true
	writeFailed := false
	write := func(mt int, data []byte) bool {
		_ = conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
		if err := conn.WriteMessage(mt, data); err != nil {
			writeFailed = true
			return false
		}
		return true
	}
	for (outOpen || inOpen) && !writeFailed {
		select {
		case ev, ok := <-s.outCh:
			if !ok {
				outOpen = false
				continue
			}
			b, err := json.Marshal(ev)
			if err != nil {
				Warn("voip-stream: 事件序列化失败", "call_id", s.id, "err", err)
				continue
			}
			write(websocket.TextMessage, b)
		case ev, ok := <-s.inCh:
			if !ok {
				inOpen = false
				continue
			}
			b, err := json.Marshal(ev)
			if err != nil {
				continue
			}
			write(websocket.TextMessage, b)
		case <-ping.C:
			write(websocket.PingMessage, []byte("vs"))
		}
	}
	// 会话收尾后主动关连接 → readLoop 退出 → ws_closed(已 ended 时幂等忽略)
	_ = conn.SetWriteDeadline(time.Now().Add(time.Second))
	_ = conn.WriteMessage(websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.CloseNormalClosure, "ended"))
	_ = conn.Close()
	if writeFailed && s.getState() != "ended" {
		// 写失败 = 客户端半死: 走断连清理
		s.enqueueCmd(wsCommand{kind: wsCmdWSClosed})
	}
}
