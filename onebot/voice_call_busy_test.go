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
