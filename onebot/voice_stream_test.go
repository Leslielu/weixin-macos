package main

// voice_stream_test.go —— 实时流自动化测试(设计 §17.1): 假底层验证协议与生命周期,
// 不依赖 Frida/微信。真实硬件行为按设计 §17.3 在开发副本验证。

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// ---- 假底层 ----

type postedAppend struct {
	callID, reqID, seg string
	gen, seq           int64
	pcm                []byte
}

type fakeBackend struct {
	mu              sync.Mutex
	hub             *StreamHub
	dialDelay       time.Duration
	dialErr         string
	ackQueuedMs     int
	appends         []postedAppend
	commits         int
	clears          int
	stops           []string
	hangupN         int
	armedIncoming   int
	emitSegmentDone bool
}

func (fb *fakeBackend) submit(fields map[string]any) {
	fb.submitData(fields, nil)
}

func (fb *fakeBackend) submitData(fields map[string]any, data []byte) {
	if fb.hub != nil {
		fields["type"] = "voip_stream" // 与 JS voipStreamEmit 同形, hub 靠它过滤
		fb.hub.Submit(fields, data)
	}
}

func (fb *fakeBackend) Dial(callID, userID string, _ StreamDialOpts) error {
	if fb.dialDelay > 0 {
		time.Sleep(fb.dialDelay)
	}
	fb.mu.Lock()
	errCode := fb.dialErr
	fb.mu.Unlock()
	if errCode != "" {
		return &streamFailure{Code: errCode}
	}
	fb.submit(map[string]any{"ev": "state", "callId": callID, "state": "connected",
		"answerDetection": "put_ready_inferred",
		"engineFormat": map[string]any{"engRate": 16000, "engCh": 1, "frameMs": 20,
			"frameBytes": 960, "payloadBytes": 640, "payloadSamples": 320,
			"capRate": 16000, "pullBytes": 640}})
	return nil
}

func (fb *fakeBackend) ArmIncoming(callID, userID string, _ StreamIncomingOpts) error {
	fb.mu.Lock()
	fb.armedIncoming++
	fb.mu.Unlock()
	return nil // 接通由测试驱动 submit state ringing/connected
}

func (fb *fakeBackend) Append(callID, reqID string, gen int64, seg string, seq int64, pcm []byte) error {
	fb.mu.Lock()
	fb.appends = append(fb.appends, postedAppend{callID: callID, reqID: reqID,
		gen: gen, seq: seq, seg: seg, pcm: append([]byte(nil), pcm...)})
	q := fb.ackQueuedMs
	fb.mu.Unlock()
	fb.submit(map[string]any{"ev": "append_ack", "callId": callID, "reqId": reqID,
		"generation": gen, "seq": seq, "ok": true, "queuedMs": q})
	return nil
}

func (fb *fakeBackend) Commit(callID, reqID string, gen int64, seg string) error {
	fb.mu.Lock()
	fb.commits++
	done := fb.emitSegmentDone
	fb.mu.Unlock()
	fb.submit(map[string]any{"ev": "commit_ack", "callId": callID, "reqId": reqID,
		"ok": true})
	if done {
		fb.submit(map[string]any{"ev": "segment_done", "callId": callID,
			"generation": gen, "segmentId": seg,
			"consumedSamples": 320, "submittedEngSamples": 320})
	}
	return nil
}

func (fb *fakeBackend) Clear(callID, reqID string, oldGen, newGen int64) error {
	fb.mu.Lock()
	fb.clears++
	fb.mu.Unlock()
	fb.submit(map[string]any{"ev": "clear_ack", "callId": callID, "reqId": reqID,
		"ok": true, "oldGeneration": oldGen, "newGeneration": newGen,
		"droppedSamples": 100, "consumedSamples": 220, "finalSegment": "reply-1",
		"queueEmpty": true})
	return nil
}

func (fb *fakeBackend) Stop(callID, reason string) error {
	fb.mu.Lock()
	fb.stops = append(fb.stops, reason)
	fb.mu.Unlock()
	fb.submit(map[string]any{"ev": "stopped", "callId": callID, "reason": reason})
	return nil
}

func (fb *fakeBackend) HangupNative() (string, error) {
	fb.mu.Lock()
	fb.hangupN++
	fb.mu.Unlock()
	return "0", nil
}

// emitStats 模拟 JS 100ms stats 事件
func (fb *fakeBackend) emitStats(callID string, gen int64, submitted, consumed, queued int) {
	fb.submit(map[string]any{"ev": "stats", "callId": callID, "generation": gen,
		"segmentId": "reply-1", "submittedEngSamples": submitted,
		"consumedSamples": consumed, "queuedMs": queued})
}

// ---- 测试环境 ----

type streamTestEnv struct {
	t   *testing.T
	mgr *StreamManager
	hub *StreamHub
	srv *httptest.Server
}

func newStreamTestEnv(t *testing.T, fb *fakeBackend) *streamTestEnv {
	t.Helper()
	hub := NewStreamHub()
	fb.hub = hub
	mgr := NewStreamManager(StreamConfig{
		Token: "tk", SweepEvery: 50 * time.Millisecond,
		AttachTimeout: 300 * time.Millisecond, StartTimeout: 300 * time.Millisecond,
		AckTimeout: time.Second, StopAckTimeout: 600 * time.Millisecond,
	}, fb, hub)
	mgr.Start()
	mux := http.NewServeMux()
	mgr.RegisterRoutes(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(func() {
		srv.Close()
		// 测试中途失败也会话兜底释放, 避免全局锁泄漏影响后续用例
		mgr.mu.Lock()
		sessions := make([]*streamSession, 0, len(mgr.sessions))
		for _, s := range mgr.sessions {
			sessions = append(sessions, s)
		}
		mgr.mu.Unlock()
		for _, s := range sessions {
			s.requestHangup()
		}
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) && mgr.HasActiveSession() {
			time.Sleep(20 * time.Millisecond)
		}
		if mgr.HasActiveSession() {
			t.Logf("警告: 测试结束后仍有活跃会话")
		}
	})
	return &streamTestEnv{t: t, mgr: mgr, hub: hub, srv: srv}
}

func (e *streamTestEnv) do(method, path, body string, headers map[string]string) (int, map[string]any) {
	e.t.Helper()
	var rd *strings.Reader
	if body == "" {
		rd = strings.NewReader("")
	} else {
		rd = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, e.srv.URL+path, rd)
	if err != nil {
		e.t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer tk")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	var m map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&m)
	return resp.StatusCode, m
}

func (e *streamTestEnv) create(user string, headers map[string]string) (int, map[string]any) {
	body := fmt.Sprintf(`{"user_id":%q,"source":"mumble","mode":"stream",
		"input_format":{"codec":"pcm_s16le","sample_rate":16000,"channels":1},
		"output_format":{"codec":"pcm_s16le","sample_rate":24000,"channels":1}}`, user)
	return e.do("POST", "/voice_calls", body, headers)
}

func (e *streamTestEnv) wsDial(callID string, header http.Header) (*websocket.Conn, int, error) {
	u := "ws" + strings.TrimPrefix(e.srv.URL, "http") + "/voice_calls/" + callID + "/stream"
	if header == nil {
		header = http.Header{"Authorization": []string{"Bearer tk"}}
	}
	conn, resp, err := websocket.DefaultDialer.Dial(u, header)
	return conn, resp.StatusCode, err
}

func wsSend(t *testing.T, conn *websocket.Conn, v map[string]any) {
	t.Helper()
	b, _ := json.Marshal(v)
	_ = conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
	if err := conn.WriteMessage(websocket.TextMessage, b); err != nil {
		t.Fatalf("ws send: %v", err)
	}
}

func wsRecv(t *testing.T, conn *websocket.Conn, wantType string) map[string]any {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("ws read %s: %v", wantType, err)
		}
		var m map[string]any
		if json.Unmarshal(data, &m) != nil {
			continue
		}
		t.Logf("ws <- %s (want %s)", m["type"], wantType)
		if m["type"] == wantType {
			return m
		}
	}
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("等待 %s 超时", what)
}

func pcmChunk(samples int) []byte {
	b := make([]byte, samples*2)
	for i := range b {
		b[i] = byte(i % 251)
	}
	return b
}

func mustCreate(t *testing.T, e *streamTestEnv) string {
	t.Helper()
	code, body := e.create("wxid_peer", nil)
	if code != 201 {
		t.Fatalf("create: http %d %v", code, body)
	}
	data := body["data"].(map[string]any)
	return data["call_id"].(string)
}

// ---- 协议层单测 ----

func TestStreamProtocolValidate(t *testing.T) {
	req := &StreamCreateRequest{UserID: "wxid_x", Source: "mumble", Mode: "stream",
		InputFormat:  AudioFormat{Codec: "pcm_s16le", SampleRate: 16000, Channels: 1},
		OutputFormat: AudioFormat{Codec: "pcm_s16le", SampleRate: 48000, Channels: 1}}
	if _, _, _, _, err := req.validate(); err != nil {
		t.Fatalf("合法请求被拒: %v", err)
	}
	bad := *req
	bad.Mode = "file"
	if _, _, _, _, err := bad.validate(); err == nil {
		t.Fatal("mode=file 应被拒绝")
	}
	bad = *req
	bad.InputFormat.SampleRate = 44100
	if _, _, _, _, err := bad.validate(); err == nil {
		t.Fatal("44100 应被拒绝")
	}
	bad = *req
	bad.MaxDurationS = 600
	if _, _, _, _, err := bad.validate(); err == nil {
		t.Fatal("超上限时长应被拒绝")
	}
	inc := *req
	inc.Mode = "incoming_stream"
	inc.WindowS = 99999
	if _, _, _, _, err := inc.validate(); err == nil {
		t.Fatal("incoming 超上限窗口应被拒绝")
	}
	inc.WindowS = 60
	if _, _, winS, _, err := inc.validate(); err != nil || winS != 60 {
		t.Fatalf("incoming 窗口校验异常: win=%d err=%v", winS, err)
	}

	if _, se := decodeAudioChunk("!!!not-b64!!!"); se == nil || se.Code != "invalid_message" {
		t.Fatal("非法 base64 应拒绝")
	}
	if _, se := decodeAudioChunk(base64.StdEncoding.EncodeToString([]byte{1})); se == nil {
		t.Fatal("奇数字节应拒绝")
	}
	if _, se := decodeAudioChunk(base64.StdEncoding.EncodeToString(make([]byte, StreamMaxChunkBytes+2))); se == nil {
		t.Fatal("超长 chunk 应拒绝")
	}
	ok, _ := decodeAudioChunk(base64.StdEncoding.EncodeToString(pcmChunk(320)))
	if len(ok) != 640 {
		t.Fatalf("解码长度错: %d", len(ok))
	}
	if chunkDurationMs(640, 16000) != 20.0 {
		t.Fatalf("20ms 计算错: %v", chunkDurationMs(640, 16000))
	}
	tb := newTokenBucket(20, 2)
	if !tb.allow() || !tb.allow() || tb.allow() {
		t.Fatal("burst 限速行为不符")
	}
}

// ---- 全流程 ----

func TestStreamConsecutiveSegmentsCommitIndependently(t *testing.T) {
	fb := &fakeBackend{}
	e := newStreamTestEnv(t, fb)
	id := mustCreate(t, e)
	conn, _, err := e.wsDial(id, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	wsRecv(t, conn, "hello")
	wsSend(t, conn, map[string]any{"type": "call.start", "request_id": "start"})
	wsRecv(t, conn, "call.state")
	wsRecv(t, conn, "call.state")
	for index, segment := range []string{"greeting", "task", "answer"} {
		request := fmt.Sprintf("append-%d", index)
		wsSend(t, conn, map[string]any{"type": "audio.append", "request_id": request,
			"generation": 1, "segment_id": segment, "seq": index,
			"audio_b64": base64.StdEncoding.EncodeToString(pcmChunk(320))})
		accepted := wsRecv(t, conn, "audio.accepted")
		if accepted["segment_id"] != segment {
			t.Fatalf("段确认错误: %v", accepted)
		}
		wsSend(t, conn, map[string]any{"type": "audio.commit", "request_id": "commit-" + segment,
			"generation": 1, "segment_id": segment, "last_seq": index})
		result := wsRecv(t, conn, "result")
		if result["request_id"] != "commit-"+segment || result["ok"] != true {
			t.Fatalf("连续段提交失败: %v", result)
		}
	}
}

func TestStreamFullFlow(t *testing.T) {
	fb := &fakeBackend{emitSegmentDone: true}
	e := newStreamTestEnv(t, fb)

	id := mustCreate(t, e)

	// reserved 状态可查询
	code, st := e.do("GET", "/voice_calls/"+id, "", nil)
	if code != 200 || st["data"].(map[string]any)["state"] != "reserved" {
		t.Fatalf("reserved 查询异常: %d %v", code, st)
	}

	conn, hsCode, err := e.wsDial(id, nil)
	if err != nil {
		t.Fatalf("ws dial: %v http=%d", err, hsCode)
	}
	defer conn.Close()

	hello := wsRecv(t, conn, "hello")
	if hello["protocol_version"].(float64) != StreamProtocolVersion {
		t.Fatal("hello 协议版本错")
	}
	if hello["progress_scope"] != "submitted_to_wechat" || hello["remote_heard"] != false {
		t.Fatal("hello 必须如实披露进度口径")
	}

	wsSend(t, conn, map[string]any{"type": "call.start", "request_id": "r1"})
	dialing := wsRecv(t, conn, "call.state")
	if dialing["state"] != "dialing" {
		t.Fatalf("期望 dialing: %v", dialing)
	}
	connected := wsRecv(t, conn, "call.state")
	if connected["state"] != "connected" || connected["answer_detection"] == "" {
		t.Fatalf("connected 缺 answer_detection: %v", connected)
	}

	// 接通前 append 拒绝不了(已接通) — 先测 committed 前 commit 空 segment
	wsSend(t, conn, map[string]any{"type": "audio.append", "request_id": "a0",
		"generation": 1, "segment_id": "reply-1", "seq": 0,
		"audio_b64": base64.StdEncoding.EncodeToString(pcmChunk(320))})
	acc := wsRecv(t, conn, "audio.accepted")
	if acc["seq"].(float64) != 0 || acc["scope"] != "queued_in_onebot" {
		t.Fatalf("accepted 口径错: %v", acc)
	}

	// stats → progress
	fb.emitStats(id, 1, 320, 320, 40)
	prog := wsRecv(t, conn, "audio.progress")
	if prog["scope"] != "submitted_to_wechat" || prog["submitted_native_samples"].(float64) != 320 {
		t.Fatalf("progress 口径错: %v", prog)
	}

	// 同 seq 同数据 → 幂等 accepted; 同 seq 不同数据 → seq_conflict
	wsSend(t, conn, map[string]any{"type": "audio.append", "request_id": "a0",
		"generation": 1, "segment_id": "reply-1", "seq": 0,
		"audio_b64": base64.StdEncoding.EncodeToString(pcmChunk(320))})
	acc2 := wsRecv(t, conn, "audio.accepted")
	_ = acc2
	wsSend(t, conn, map[string]any{"type": "audio.append", "request_id": "aX",
		"generation": 1, "segment_id": "reply-1", "seq": 0,
		"audio_b64": base64.StdEncoding.EncodeToString(pcmChunk(100))})
	errEv := wsRecv(t, conn, "error")
	if errEv["error"].(map[string]any)["code"] != "seq_conflict" {
		t.Fatalf("期望 seq_conflict: %v", errEv)
	}

	// commit + segment_done
	wsSend(t, conn, map[string]any{"type": "audio.commit", "request_id": "c0",
		"generation": 1, "segment_id": "reply-1", "last_seq": 0})
	res := wsRecv(t, conn, "result")
	if res["op"] != "commit" || res["ok"] != true {
		t.Fatalf("commit result 异常: %v", res)
	}
	done := wsRecv(t, conn, "audio.segment_done")
	if done["scope"] != "submitted_to_wechat" {
		t.Fatalf("segment_done 口径错: %v", done)
	}

	// 打断: clear → cleared → 旧代拒绝 → 新代接受
	wsSend(t, conn, map[string]any{"type": "audio.clear", "request_id": "x1",
		"generation": 2})
	cleared := wsRecv(t, conn, "audio.cleared")
	if cleared["old_generation"].(float64) != 1 || cleared["new_generation"].(float64) != 2 {
		t.Fatalf("cleared 代次错: %v", cleared)
	}
	if cleared["native_submitted_reclaimable"] != false || cleared["sdk_residual_upper_ms"] != nil {
		t.Fatalf("cleared 必须披露原生边界: %v", cleared)
	}
	wsSend(t, conn, map[string]any{"type": "audio.append", "request_id": "old",
		"generation": 1, "segment_id": "reply-1", "seq": 9,
		"audio_b64": base64.StdEncoding.EncodeToString(pcmChunk(320))})
	errEv = wsRecv(t, conn, "error")
	if errEv["error"].(map[string]any)["code"] != "stale_generation" {
		t.Fatalf("旧代应 stale_generation: %v", errEv)
	}
	wsSend(t, conn, map[string]any{"type": "audio.append", "request_id": "new",
		"generation": 2, "segment_id": "reply-2", "seq": 0,
		"audio_b64": base64.StdEncoding.EncodeToString(pcmChunk(320))})
	_ = wsRecv(t, conn, "audio.accepted")
	// 跳号
	wsSend(t, conn, map[string]any{"type": "audio.append", "request_id": "jump",
		"generation": 2, "segment_id": "reply-2", "seq": 5,
		"audio_b64": base64.StdEncoding.EncodeToString(pcmChunk(320))})
	errEv = wsRecv(t, conn, "error")
	ee := errEv["error"].(map[string]any)
	if ee["code"] != "invalid_seq" || ee["expected_seq"].(float64) != 1 {
		t.Fatalf("期望 invalid_seq expected=1: %v", errEv)
	}

	// 挂断 → ended
	wsSend(t, conn, map[string]any{"type": "call.hangup", "request_id": "h1"})
	ended := wsRecv(t, conn, "call.ended")
	if ended["reason"] != "local_hangup" {
		t.Fatalf("期望 local_hangup: %v", ended)
	}
	if ended["resources_released"] != true {
		t.Fatalf("call.ended 应带 resources_released=true: %v", ended)
	}
	stats := ended["stats"].(map[string]any)
	if stats["generation"].(float64) != 2 {
		t.Fatalf("ended stats 代次错: %v", stats)
	}

	// 结束记录保留
	waitFor(t, "ended record", func() bool {
		_, st := e.do("GET", "/voice_calls/"+id, "", nil)
		d, _ := st["data"].(map[string]any)
		return d != nil && d["state"] == "ended"
	})
	// 全局锁释放: 可立即创建下一通(§8.8); 清理交给本环境 t.Cleanup 兜底
	if codeNew, _ := e.create("wxid_peer2", nil); codeNew != 201 {
		t.Fatalf("锁未释放, 第二通创建失败: %d", codeNew)
	}
	fb.mu.Lock()
	hangN := fb.hangupN
	fb.mu.Unlock()
	if hangN == 0 {
		t.Fatal("挂断应调用原生 hangup")
	}
}

// ---- 幂等 ----

func TestStreamIdempotency(t *testing.T) {
	fb := &fakeBackend{}
	e := newStreamTestEnv(t, fb)
	h := map[string]string{"Idempotency-Key": "k1"}
	code1, b1 := e.create("wxid_a", h)
	code2, b2 := e.create("wxid_a", h)
	if code1 != 201 || code2 != 201 {
		t.Fatalf("幂等重放状态码错: %d %d", code1, code2)
	}
	id1 := b1["data"].(map[string]any)["call_id"].(string)
	id2 := b2["data"].(map[string]any)["call_id"].(string)
	if id1 != id2 {
		t.Fatalf("同 key 同参数应返回原会话: %s vs %s", id1, id2)
	}
	code3, _ := e.create("wxid_other", h)
	if code3 != 409 {
		t.Fatalf("同 key 不同参数应 409: %d", code3)
	}
}

// ---- 锁互斥 ----

func TestStreamOwnerExclusion(t *testing.T) {
	fb := &fakeBackend{}
	e := newStreamTestEnv(t, fb)
	oldWait := voiceCallPreemptWait
	voiceCallPreemptWait = 100 * time.Millisecond // 裸锁场景无可抢占对象, 不用等满上限
	t.Cleanup(func() { voiceCallPreemptWait = oldWait })
	voiceCallMu.Lock() // 模拟旧文件通话进行中
	code, body := e.create("wxid_a", nil)
	if code != 409 || body["error"].(map[string]any)["code"] != "call_busy" {
		t.Fatalf("锁被占应 409 call_busy: %d %v", code, body)
	}
	if msg, _ := body["error"].(map[string]any)["message"].(string); !strings.Contains(msg, "通话槽被占用") {
		t.Fatalf("call_busy 应带占用者信息: %v", body)
	}
	voiceCallMu.Unlock()

	id := mustCreate(t, e)
	if !e.mgr.HasActiveSession() {
		t.Fatal("实时会话应占用 manager(StreamBusy 生产路径走 streamMgr 单例)")
	}
	// 第二 WS 冲突
	conn1, _, err := e.wsDial(id, nil)
	if err != nil {
		t.Fatalf("ws1: %v", err)
	}
	defer conn1.Close()
	_ = wsRecv(t, conn1, "hello")
	_, code2, err2 := e.wsDial(id, nil)
	if err2 == nil || code2 != 409 {
		t.Fatalf("第二连接应 409: code=%d err=%v", code2, err2)
	}
	// 清理: 挂断释放锁
	_, _ = e.do("POST", "/voice_calls/"+id+"/hangup", "", nil)
	waitFor(t, "release", func() bool { return !StreamBusy() })
}

// ---- 鉴权 ----

func TestStreamAuth(t *testing.T) {
	fb := &fakeBackend{}
	e := newStreamTestEnv(t, fb)
	req, _ := http.NewRequest("POST", e.srv.URL+"/voice_calls",
		strings.NewReader(`{"user_id":"w","source":"s","mode":"stream"}`))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatalf("无 token 应 401: %d", resp.StatusCode)
	}
	// Origin 未在白名单
	req2, _ := http.NewRequest("GET", e.srv.URL+"/voice_calls/capabilities", nil)
	req2.Header.Set("Authorization", "Bearer tk")
	req2.Header.Set("Origin", "https://evil.example")
	resp2, _ := http.DefaultClient.Do(req2)
	resp2.Body.Close()
	if resp2.StatusCode != 403 {
		t.Fatalf("非法 Origin 应 403: %d", resp2.StatusCode)
	}
}

// ---- 超时生命周期 ----

func TestStreamAttachAndStartTimeout(t *testing.T) {
	fb := &fakeBackend{}
	e := newStreamTestEnv(t, fb)
	// attach 超时: 创建后不连接
	id1 := mustCreate(t, e)
	waitFor(t, "attach_timeout", func() bool {
		_, st := e.do("GET", "/voice_calls/"+id1, "", nil)
		d, _ := st["data"].(map[string]any)
		return d != nil && d["end_reason"] == "attach_timeout"
	})
	// 超时释放后可立即创建下一通(§8.8); 新会话先显式挂断再继续
	var idB string
	waitFor(t, "释放后可再创建", func() bool {
		code, b := e.create("wxid_b", nil)
		if code != 201 {
			return false
		}
		idB = b["data"].(map[string]any)["call_id"].(string)
		return true
	})
	_, _ = e.do("POST", "/voice_calls/"+idB+"/hangup", "", nil)
	waitFor(t, "wxid_b 释放", func() bool {
		_, st := e.do("GET", "/voice_calls/"+idB, "", nil)
		d, _ := st["data"].(map[string]any)
		return d != nil && d["end_reason"] == "local_hangup"
	})

	// start 超时: 连上但不 start
	id2 := mustCreate(t, e)
	conn, _, err := e.wsDial(id2, nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = wsRecv(t, conn, "hello")
	waitFor(t, "start_timeout", func() bool {
		_, st := e.do("GET", "/voice_calls/"+id2, "", nil)
		d, _ := st["data"].(map[string]any)
		return d != nil && d["end_reason"] == "start_timeout"
	})
	_ = conn.Close()
}

// ---- 断连 ----

func TestStreamClientDisconnect(t *testing.T) {
	fb := &fakeBackend{}
	e := newStreamTestEnv(t, fb)
	id := mustCreate(t, e)
	conn, _, err := e.wsDial(id, nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = wsRecv(t, conn, "hello")
	wsSend(t, conn, map[string]any{"type": "call.start", "request_id": "r"})
	_ = wsRecv(t, conn, "call.state")
	_ = wsRecv(t, conn, "call.state")
	conn.Close()
	waitFor(t, "client_disconnected", func() bool {
		_, st := e.do("GET", "/voice_calls/"+id, "", nil)
		d, _ := st["data"].(map[string]any)
		return d != nil && d["end_reason"] == "client_disconnected"
	})
}

// ---- 背压: 队列硬上限 ----

func TestStreamBufferFull(t *testing.T) {
	fb := &fakeBackend{ackQueuedMs: 990}
	e := newStreamTestEnv(t, fb)
	id := mustCreate(t, e)
	conn, _, err := e.wsDial(id, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = wsRecv(t, conn, "hello")
	wsSend(t, conn, map[string]any{"type": "call.start", "request_id": "r"})
	_ = wsRecv(t, conn, "call.state")
	_ = wsRecv(t, conn, "call.state")
	// 第一块入队成功(预检 0+20<1000), ack 置 queued=990
	wsSend(t, conn, map[string]any{"type": "audio.append", "request_id": "a1",
		"generation": 1, "segment_id": "s", "seq": 0,
		"audio_b64": base64.StdEncoding.EncodeToString(pcmChunk(320))})
	_ = wsRecv(t, conn, "audio.accepted")
	// 第二块预检 990+20>1000 → buffer_full, 不消耗 seq
	wsSend(t, conn, map[string]any{"type": "audio.append", "request_id": "a2",
		"generation": 1, "segment_id": "s", "seq": 1,
		"audio_b64": base64.StdEncoding.EncodeToString(pcmChunk(320))})
	errEv := wsRecv(t, conn, "error")
	ee := errEv["error"].(map[string]any)
	if ee["code"] != "buffer_full" || ee["retryable"] != true {
		t.Fatalf("期望可重试 buffer_full: %v", errEv)
	}
	// 队列恢复后同 seq 重试成功(不消耗 seq): 先用 stats 事件把会话 queued_ms 打下来
	// (真实时序: JS 队列排空后 stats 报告低水位)
	fb.mu.Lock()
	fb.ackQueuedMs = 10
	fb.mu.Unlock()
	fb.emitStats(id, 1, 320, 320, 10)
	wsRecv(t, conn, "audio.progress") // 消费 stats 派生的进度事件
	wsSend(t, conn, map[string]any{"type": "audio.append", "request_id": "a2",
		"generation": 1, "segment_id": "s", "seq": 1,
		"audio_b64": base64.StdEncoding.EncodeToString(pcmChunk(320))})
	acc := wsRecv(t, conn, "audio.accepted")
	if acc["seq"].(float64) != 1 {
		t.Fatalf("同 seq 重试应成功: %v", acc)
	}
}

// ---- 下行积压 → media_overflow ----

func TestStreamMediaOverflow(t *testing.T) {
	fb := &fakeBackend{}
	e := newStreamTestEnv(t, fb)
	id := mustCreate(t, e)
	conn, _, err := e.wsDial(id, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = wsRecv(t, conn, "hello")
	wsSend(t, conn, map[string]any{"type": "call.start", "request_id": "r"})
	_ = wsRecv(t, conn, "call.state")
	_ = wsRecv(t, conn, "call.state")
	// 洪灌下行帧(客户端不读): actor 推入速度远快于 writer 消费, inCh(128) 持续满载
	// → 滑动窗口丢帧达到阈值 → media_overflow(§10.2)
	frame := pcmChunk(160)
	for i := 0; i < 3000; i++ {
		fb.submitData(map[string]any{"ev": "input", "callId": id, "seq": i,
			"sampleOffset": i * 160, "rate": 24000, "samples": 160},
			append([]byte(nil), frame...))
	}
	waitFor(t, "media_overflow", func() bool {
		_, st := e.do("GET", "/voice_calls/"+id, "", nil)
		d, _ := st["data"].(map[string]any)
		return d != nil && d["end_reason"] == "media_overflow"
	})
}

// ---- 拨号失败 ----

func TestStreamDialFailed(t *testing.T) {
	fb := &fakeBackend{dialErr: "dial-failed:-1:client"}
	e := newStreamTestEnv(t, fb)
	id := mustCreate(t, e)
	conn, _, err := e.wsDial(id, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = wsRecv(t, conn, "hello")
	wsSend(t, conn, map[string]any{"type": "call.start", "request_id": "r"})
	ended := wsRecv(t, conn, "call.ended")
	if ended["reason"] != "dial_failed" {
		t.Fatalf("期望 dial_failed: %v", ended)
	}
}

// ---- scoped hangup 与未知 ID ----

func createIncomingReq(t *testing.T, e *streamTestEnv, windowS int) (int, map[string]any) {
	t.Helper()
	body := fmt.Sprintf(`{"user_id":"wxid_peer","source":"mumble","mode":"incoming_stream",
		"window_s":%d,"answer_delay_ms":1200,
		"input_format":{"codec":"pcm_s16le","sample_rate":16000,"channels":1},
		"output_format":{"codec":"pcm_s16le","sample_rate":24000,"channels":1}}`, windowS)
	return e.do("POST", "/voice_calls", body, nil)
}

func incomingEngineFormat() map[string]any {
	return map[string]any{"engRate": 16000, "engCh": 1, "frameMs": 20,
		"frameBytes": 640, "payloadBytes": 640, "payloadSamples": 320,
		"capRate": 16000, "pullBytes": 640}
}

func TestStreamIncomingFlow(t *testing.T) {
	fb := &fakeBackend{emitSegmentDone: true}
	e := newStreamTestEnv(t, fb)
	code, body := createIncomingReq(t, e, 60)
	if code != 201 {
		t.Fatalf("incoming 创建: %d %v", code, body)
	}
	id := body["data"].(map[string]any)["call_id"].(string)
	conn, _, err := e.wsDial(id, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	hello := wsRecv(t, conn, "hello")
	if hello["direction"] != "incoming" {
		t.Fatalf("hello direction 应为 incoming: %v", hello["direction"])
	}
	// call.start 幂等确认(无拨号动作)
	wsSend(t, conn, map[string]any{"type": "call.start", "request_id": "s1"})
	st := wsRecv(t, conn, "call.state")
	if st["state"] != "reserved" {
		t.Fatalf("incoming start 应回当前状态: %v", st)
	}
	// 来电响铃(带主叫 wxid)
	fb.submit(map[string]any{"ev": "state", "callId": id, "state": "ringing",
		"roomKnown": true, "callerWxid": "wxid_caller", "roomId": "123"})
	ring := wsRecv(t, conn, "call.state")
	if ring["state"] != "ringing" || ring["caller_wxid"] != "wxid_caller" {
		t.Fatalf("期望 ringing + caller_wxid: %v", ring)
	}
	// 快照也带 caller
	_, snap := e.do("GET", "/voice_calls/"+id, "", nil)
	if d, _ := snap["data"].(map[string]any); d["caller_wxid"] != "wxid_caller" {
		t.Fatalf("snapshot caller_wxid 异常: %v", d["caller_wxid"])
	}
	// 自动接听完成
	fb.submit(map[string]any{"ev": "state", "callId": id, "state": "connected",
		"answerDetection": "accept_inferred", "engineFormat": incomingEngineFormat()})
	connected := wsRecv(t, conn, "call.state")
	if connected["state"] != "connected" ||
		connected["answer_detection"] != "accept_inferred" {
		t.Fatalf("接通事件异常: %v", connected)
	}
	// 双向流
	wsSend(t, conn, map[string]any{"type": "audio.append", "request_id": "a0",
		"generation": 1, "segment_id": "s", "seq": 0,
		"audio_b64": base64.StdEncoding.EncodeToString(pcmChunk(320))})
	_ = wsRecv(t, conn, "audio.accepted")
	// 本地挂断
	wsSend(t, conn, map[string]any{"type": "call.hangup", "request_id": "h1"})
	ended := wsRecv(t, conn, "call.ended")
	if ended["reason"] != "local_hangup" || ended["resources_released"] != true {
		t.Fatalf("结束异常: %v", ended)
	}
	fb.mu.Lock()
	defer fb.mu.Unlock()
	if fb.armedIncoming != 1 {
		t.Fatalf("布防次数=%d", fb.armedIncoming)
	}
	if fb.hangupN != 0 {
		t.Fatal("入站布防/通话不应调原生拨号挂断(dialed=false)")
	}
}

func TestStreamIncomingWindowExpiry(t *testing.T) {
	fb := &fakeBackend{}
	e := newStreamTestEnv(t, fb)
	code, body := createIncomingReq(t, e, 1)
	if code != 201 {
		t.Fatalf("创建: %d", code)
	}
	id := body["data"].(map[string]any)["call_id"].(string)
	conn, _, err := e.wsDial(id, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = wsRecv(t, conn, "hello")
	waitFor(t, "window_expired", func() bool {
		_, st := e.do("GET", "/voice_calls/"+id, "", nil)
		d, _ := st["data"].(map[string]any)
		return d != nil && d["end_reason"] == "window_expired" &&
			d["resources_released"] == true
	})
	// 释放后可再创建
	if codeNew, _ := e.create("wxid_next", nil); codeNew != 201 {
		t.Fatalf("窗口到期释放后应可再创建: %d", codeNew)
	}
}

func TestStreamIncomingRingHangup(t *testing.T) {
	fb := &fakeBackend{}
	e := newStreamTestEnv(t, fb)
	code, body := createIncomingReq(t, e, 60)
	if code != 201 {
		t.Fatalf("创建: %d", code)
	}
	id := body["data"].(map[string]any)["call_id"].(string)
	conn, _, err := e.wsDial(id, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = wsRecv(t, conn, "hello")
	fb.submit(map[string]any{"ev": "state", "callId": id, "state": "ringing",
		"roomKnown": false})
	_ = wsRecv(t, conn, "call.state")
	wsSend(t, conn, map[string]any{"type": "call.hangup", "request_id": "h"})
	ended := wsRecv(t, conn, "call.ended")
	if ended["reason"] != "local_hangup" {
		t.Fatalf("响铃中解除应 local_hangup: %v", ended)
	}
	fb.mu.Lock()
	stops := len(fb.stops)
	fb.mu.Unlock()
	if stops == 0 {
		t.Fatal("解除布防应通知 JS teardown")
	}
}

func TestStreamScopedHangup(t *testing.T) {
	fb := &fakeBackend{}
	e := newStreamTestEnv(t, fb)
	code, _ := e.do("POST", "/voice_calls/no-such-id/hangup", "", nil)
	if code != 404 {
		t.Fatalf("未知 ID hangup 应 404: %d", code)
	}
	id := mustCreate(t, e)
	code, body := e.do("POST", "/voice_calls/"+id+"/hangup", "", nil)
	if code != 200 {
		t.Fatalf("scoped hangup 应 200: %d %v", code, body)
	}
	waitFor(t, "hangup done", func() bool {
		_, st := e.do("GET", "/voice_calls/"+id, "", nil)
		d, _ := st["data"].(map[string]any)
		return d != nil && d["end_reason"] == "local_hangup"
	})
	// 已结束再挂: 幂等返回结束记录
	code, body = e.do("POST", "/voice_calls/"+id+"/hangup", "", nil)
	if code != 200 || body["data"].(map[string]any)["end_reason"] != "local_hangup" {
		t.Fatalf("重复 hangup 应幂等: %d %v", code, body)
	}
}
