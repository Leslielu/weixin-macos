package main

// voice_call_busy_test.go —— 通话槽忙碌拒绝的诊断信息(2026-11-18 事故:
// 入站布防窗口占槽拒呼出, 错误只说「已有通话进行中」, 排查全靠拼日志)。
// 忙碌时错误文案带占用者与预计释放时间, 旧接口另回 holder 字段;
// 占用者登记在 Lock 后/Unlock 前成对设置与清除。

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// 旧 /send_voice_call: 忙碌拒绝仍 HTTP 200(OneBot 传统语义), 但带占用者信息与 holder 字段
func TestVoiceCallBusyHolderInfo(t *testing.T) {
	oldWait := voiceCallPreemptWait
	voiceCallPreemptWait = 100 * time.Millisecond // 裸锁场景无可抢占对象, 不用等满上限
	t.Cleanup(func() { voiceCallPreemptWait = oldWait })

	voiceCallMu.Lock()
	voiceCallHolderSet(&voiceCallHolder{Kind: "stream_incoming", CallID: "c1",
		UserID: "incoming:any", WindowEndsAt: time.Now().Add(90 * time.Second)})
	defer func() { voiceCallHolderClear(); voiceCallMu.Unlock() }()

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/send_voice_call",
		strings.NewReader(`{"user_id":"wxid_x","text":"hi"}`))
	voiceCallHandler(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("旧接口业务失败仍应 HTTP 200: %d", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "通话槽被占用") || !strings.Contains(body, "call_id=c1") {
		t.Fatalf("busy 错误应带占用者描述: %s", body)
	}
	if !strings.Contains(body, `"holder"`) {
		t.Fatalf("busy 响应应带 holder 字段: %s", body)
	}
}

// holder 登记随旧出站通话成对设置/清除(同步路径)
func TestVoiceCallHolderLifecycle(t *testing.T) {
	voiceCallMu.Lock()
	voiceCallHolderSet(&voiceCallHolder{Kind: "outgoing", UserID: "wxid_y"})
	if got := voiceCallHolderDesc(); got != "出站语音通话(user=wxid_y)" {
		t.Fatalf("outgoing 占用者描述: %q", got)
	}
	voiceCallHolderClear()
	if got := voiceCallHolderDesc(); got != "通话槽被占用(占用者未知)" {
		t.Fatalf("清除后应回退兜底文案: %q", got)
	}
	voiceCallMu.Unlock()
}

const preemptTestIncomingBody = `{"user_id":"incoming:any","source":"mumble","mode":"incoming_stream",
	"input_format":{"codec":"pcm_s16le","sample_rate":16000,"channels":1},
	"output_format":{"codec":"pcm_s16le","sample_rate":24000,"channels":1}}`

// 呼出优先(2026-11-18): 待机布防窗口(reserved, 未接过来电)占槽时, 呼出主动解除并拿锁
func TestOutboundPreemptsIdleArmedWindow(t *testing.T) {
	fb := &fakeBackend{}
	e := newStreamTestEnv(t, fb)
	oldMgr := streamMgr
	streamMgr = e.mgr
	t.Cleanup(func() { streamMgr = oldMgr })

	code, body := e.do("POST", "/voice_calls", preemptTestIncomingBody, nil)
	if code != 201 {
		t.Fatalf("布防应 201: %d %v", code, body)
	}
	if voiceCallMu.TryLock() {
		voiceCallMu.Unlock()
		t.Fatal("布防应占住通话槽")
	}

	if !lockVoiceCallPreempting("wxid_out", voiceCallPreemptWait) {
		t.Fatal("呼出应解除待机布防并拿到锁")
	}
	voiceCallMu.Unlock()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && e.mgr.HasActiveSession() {
		time.Sleep(20 * time.Millisecond)
	}
	if e.mgr.HasActiveSession() {
		t.Fatal("被抢占的布防会话应已结束")
	}
}

// 流式创建接入抢占: 布防占槽时呼出 201(非 409); 反向(呼出占槽时布防)仍 409 不抢占
func TestStreamCreatePreemptAndInboundNoPreempt(t *testing.T) {
	fb := &fakeBackend{}
	e := newStreamTestEnv(t, fb)
	oldMgr := streamMgr
	streamMgr = e.mgr
	t.Cleanup(func() { streamMgr = oldMgr })

	incCode, incBody := e.do("POST", "/voice_calls", preemptTestIncomingBody, nil)
	if incCode != 201 {
		t.Fatalf("布防应 201: %d %v", incCode, incBody)
	}

	code, body := e.create("wxid_out", nil)
	if code != 201 {
		t.Fatalf("呼出应抢占待机布防拿到槽: %d %v", code, body)
	}
	outID := body["data"].(map[string]any)["call_id"].(string)

	code2, body2 := e.do("POST", "/voice_calls", preemptTestIncomingBody, nil)
	if code2 != 409 {
		t.Fatalf("呼出占槽时布防不抢占, 应 409: %d %v", code2, body2)
	}
	if em, _ := body2["error"].(map[string]any)["message"].(string); !strings.Contains(em, "通话槽被占用") {
		t.Fatalf("409 应带占用者信息: %v", body2)
	}

	_, _ = e.do("POST", "/voice_calls/"+outID+"/hangup", "", nil)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && StreamBusy() {
		time.Sleep(20 * time.Millisecond)
	}
}

// 护栏: 无占用者/会话不存在时不抢占(返回 false, 调用方走忙碌拒绝)
func TestPreemptGuards(t *testing.T) {
	if preemptIncomingWindowIfIdle("wxid_x") {
		t.Fatal("无占用者不应抢占")
	}
}
