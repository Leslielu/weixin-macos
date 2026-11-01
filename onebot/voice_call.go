package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"
)

// 语音通话(给对方拨号并播放一段语音) —— docs/VOIP-CALL-STATUS.md §13
//
// 链路: ffmpeg/say 备好 PCM → JS triggerVoipCall 原生客户端拨号 →
//
//	JS voipPlay 每 20ms 注入一帧(帧长按每通协商的引擎格式现算) →
//	JS voipStatus 轮询直到播完/超时 → triggerVoipHangup 挂断。
//
// 约束:
//   - 同一时刻只允许一通(ConfSDK 服务单例 + 引擎都是独占的)
//   - 只做出站(给对方放音); 入站接听尚未接线
//   - 设备采样率每通协商不同(16000/48000 都出现过) ⇒ PCM 预生成多档采样率,
//     JS 侧按引擎实际格式选, 缺档才退化成线性插值
var (
	voiceCallMu   sync.Mutex  // 串行化: 同一时刻只有一通电话
	voiceCallBusy atomic.Bool // 供 /voice_call_status 查询(不加锁读)

	// 预生成的采样率各档(覆盖常见协商结果)
	voipPCMRates = []int{16000, 44100, 48000}
)

// VoiceCallRequest /send_voice_call 请求体
type VoiceCallRequest struct {
	UserID     string `json:"user_id"`     // 被叫 wxid, 必填
	Voice      string `json:"voice"`       // 本地音频文件路径(wav/mp3/aiff/...)
	Text       string `json:"text"`        // 或用 TTS 合成(Voice 为空时生效)
	TTSVoice   string `json:"tts_voice"`   // macOS say 音色, 默认 Tingting
	Hangup     *bool  `json:"hangup"`      // 播完是否挂断, 默认 true
	Async      bool   `json:"async"`       // true = 立即返回, 通话在后台跑完
	MaxSeconds int    `json:"max_seconds"` // 单次播放上限(秒), 默认 120
	Timeout    int    `json:"timeout"`     // 等接听上限(秒), 默认 60
}

func boolOr(p *bool, def bool) bool {
	if p == nil {
		return def
	}
	return *p
}

func intOr(v, def int) int {
	if v <= 0 {
		return def
	}
	return v
}

// prepareVoIPPayload 把源音频转成各档采样率的 16bit mono 裸 PCM,
// 返回供 JS 使用的前缀(<prefix>_<rate>_1.pcm)
func prepareVoIPPayload(dir, voicePath, text, ttsVoice string, maxSeconds int) (string, error) {
	src := voicePath
	if src == "" {
		if ttsVoice == "" {
			ttsVoice = "Tingting"
		}
		src = filepath.Join(dir, "tts.aiff")
		cmd := exec.Command("say", "-v", ttsVoice, "-o", src, text)
		if out, err := cmd.CombinedOutput(); err != nil {
			return "", fmt.Errorf("TTS 合成失败: %v (%s)", err, string(out))
		}
	}
	if _, err := os.Stat(src); err != nil {
		return "", fmt.Errorf("音频文件不可读: %v", err)
	}

	prefix := filepath.Join(dir, "p")
	ok := 0
	var lastErr error
	for _, rate := range voipPCMRates {
		out := fmt.Sprintf("%s_%d_1.pcm", prefix, rate)
		cmd := exec.Command("ffmpeg", "-y", "-loglevel", "error",
			"-i", src,
			"-t", fmt.Sprintf("%d", maxSeconds),
			"-ac", "1", "-ar", fmt.Sprintf("%d", rate),
			"-f", "s16le", out)
		if err := cmd.Run(); err != nil {
			// 单档失败不致命: JS 侧会用 16k 兜底重采样
			lastErr = err
			continue
		}
		if st, err := os.Stat(out); err == nil && st.Size() > 0 {
			ok++
		}
	}
	// 16k 必须存在(JS 侧兜底源), 其余档可缺
	src16k := fmt.Sprintf("%s_16000_1.pcm", prefix)
	st, err := os.Stat(src16k)
	if err != nil || st.Size() == 0 {
		return "", fmt.Errorf("ffmpeg 转 PCM 失败(16k 源缺失): %v", lastErr)
	}
	if ok == 0 {
		return "", fmt.Errorf("ffmpeg 转 PCM 失败: %v", lastErr)
	}
	// 至少 100ms, 否则大概率是空/损坏文件
	if st.Size() < 3200 {
		return "", fmt.Errorf("音频过短或为空(%d 字节)", st.Size())
	}
	return prefix, nil
}

// jsString 取出 rpc 导出函数的字符串返回值
func jsString(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return fmt.Sprintf("%v", v)
}

type voipJSLast struct {
	Reason     string `json:"reason"`
	Answered   bool   `json:"answered"`
	Calls      int    `json:"calls"`
	BytesSent  int    `json:"bytesSent"`
	TotalBytes int    `json:"totalBytes"`
	Error      string `json:"error"`
}

type voipJSStatus struct {
	Active      bool        `json:"active"`
	Answered    bool        `json:"answered"`
	Calls       int         `json:"calls"`
	BytesSent   int         `json:"bytesSent"`
	TotalBytes  int         `json:"totalBytes"`
	ContentRate int         `json:"contentRate"`
	Channels    int         `json:"channels"`
	FrameMs     int         `json:"frameMs"`
	FrameBytes  int         `json:"frameBytes"`
	MaxLateMs   int         `json:"maxLateMs"`
	LateOver3ms int         `json:"lateOver3ms"`
	Error       string      `json:"error"`
	Last        *voipJSLast `json:"last"`
}

func voipStatusNow() (*voipJSStatus, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	raw, err := safeExportsCall(ctx, "voipStatus")
	if err != nil {
		return nil, err
	}
	var st voipJSStatus
	if err := json.Unmarshal([]byte(jsString(raw)), &st); err != nil {
		return nil, fmt.Errorf("解析 voipStatus 失败: %v (%v)", err, raw)
	}
	return &st, nil
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

// voiceCallHandler POST /send_voice_call
func voiceCallHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "仅支持 POST", http.StatusMethodNotAllowed)
		return
	}
	var req VoiceCallRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "无效的 JSON", http.StatusBadRequest)
		return
	}
	if req.UserID == "" {
		http.Error(w, "user_id 必填", http.StatusBadRequest)
		return
	}
	if req.Voice == "" && req.Text == "" {
		http.Error(w, "voice 或 text 至少填一个", http.StatusBadRequest)
		return
	}
	if !voiceCallMu.TryLock() {
		writeJSON(w, map[string]any{"status": "failed", "error": "已有通话进行中"})
		return
	}
	voiceCallBusy.Store(true)

	if req.Async {
		// 后台跑完整通话, 立即返回(避免长通话把 HTTP 请求挂几分钟)
		go func() {
			defer voiceCallMu.Unlock()
			defer voiceCallBusy.Store(false)
			res := runVoiceCall(req)
			Info("语音通话(异步)结束", "user_id", req.UserID, "result", res)
		}()
		writeJSON(w, map[string]any{"status": "ok", "retcode": 0,
			"data": map[string]any{"async": true, "user_id": req.UserID}})
		return
	}

	defer voiceCallMu.Unlock()
	defer voiceCallBusy.Store(false)
	writeJSON(w, runVoiceCall(req))
}

// runVoiceCall 执行一次完整通话, 返回响应体。调用方负责持有 voiceCallMu。
func runVoiceCall(req VoiceCallRequest) map[string]any {
	maxSeconds := intOr(req.MaxSeconds, 120)
	answerTimeout := intOr(req.Timeout, 60)
	doHangup := boolOr(req.Hangup, true)

	dir, err := os.MkdirTemp("", "onebot_voip_")
	if err != nil {
		return map[string]any{"status": "failed", "error": "临时目录创建失败: " + err.Error()}
	}
	defer os.RemoveAll(dir)

	prefix, err := prepareVoIPPayload(dir, req.Voice, req.Text, req.TTSVoice, maxSeconds)
	if err != nil {
		return map[string]any{"status": "failed", "error": err.Error()}
	}

	started := time.Now()
	// 1. 拨号(原生客户端入口, 会连带把微信自己的通话状态机/音频引擎拉起来)
	dialCtx, dialCancel := context.WithTimeout(context.Background(), 10*time.Second)
	dialRet, dialErr := safeExportsCall(dialCtx, "triggerVoipCall", req.UserID)
	dialCancel()
	if dialErr != nil {
		return map[string]any{"status": "failed", "error": "拨号失败: " + dialErr.Error()}
	}
	if jsString(dialRet) != "0" {
		return map[string]any{"status": "failed", "user_id": req.UserID,
			"error": "拨号未成功: " + jsString(dialRet)}
	}
	Info("语音通话: 已拨出", "user_id", req.UserID)

	// 2. 启动注入(JS 侧自己等接通: -405447 每 200ms 重试, 接通瞬间才开播)
	opts, _ := json.Marshal(map[string]any{"maxSeconds": maxSeconds})
	playCtx, playCancel := context.WithTimeout(context.Background(), 10*time.Second)
	playRet, playErr := safeExportsCall(playCtx, "voipPlay", prefix, string(opts))
	playCancel()
	if playErr != nil || jsString(playRet) != "ok" {
		msg := jsString(playRet)
		if playErr != nil {
			msg = playErr.Error()
		}
		doHangupNow(doHangup)
		return map[string]any{"status": "failed", "error": "注入启动失败: " + msg}
	}

	// 3. 轮询到播完 / 超时(等接听上限 + 播放上限 + 余量)
	deadline := started.Add(time.Duration(answerTimeout+maxSeconds+15) * time.Second)
	var final *voipJSStatus
	var lastErr error
	answered := false
	for {
		time.Sleep(300 * time.Millisecond)
		st, err := voipStatusNow()
		if err != nil {
			lastErr = err
			if time.Now().After(deadline) {
				break
			}
			continue
		}
		lastErr = nil
		if !st.Active {
			final = st
			break
		}
		answered = st.Answered
		if !answered && time.Since(started) > time.Duration(answerTimeout)*time.Second {
			Info("语音通话: 等接听超时, 挂断", "user_id", req.UserID,
				"waited_ms", time.Since(started).Milliseconds())
			hangupVoIP()
			return map[string]any{"status": "failed", "user_id": req.UserID,
				"error":     "对方未接听(超时)",
				"waited_ms": time.Since(started).Milliseconds()}
		}
		if time.Now().After(deadline) {
			Info("语音通话: 总时长超限, 挂断", "user_id", req.UserID)
			hangupVoIP()
			break
		}
	}
	if doHangup {
		hangupVoIP()
	}
	if final == nil && lastErr != nil {
		return map[string]any{"status": "failed", "error": "状态查询失败: " + lastErr.Error()}
	}

	data := map[string]any{
		"user_id":     req.UserID,
		"answered":    answered,
		"duration_ms": time.Since(started).Milliseconds(),
	}
	if final != nil && final.Last != nil {
		l := final.Last
		data["answered"] = l.Answered
		data["reason"] = l.Reason
		data["frames"] = l.Calls
		data["bytes_sent"] = l.BytesSent
		data["pcm_bytes"] = l.TotalBytes
		// 播放时长近似值(按 16k mono s16 折算), 精确时长以 reason=eof 为准
		data["played_seconds"] = float64(l.BytesSent) / 32000.0
		if l.Error != "" {
			data["error"] = l.Error
		}
	}
	Info("语音通话完成", "user_id", req.UserID, "data", data)
	return map[string]any{"status": "ok", "retcode": 0, "data": data}
}

func doHangupNow(doHangup bool) {
	if doHangup {
		hangupVoIP()
	}
}

func hangupVoIP() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := safeExportsCall(ctx, "triggerVoipHangup"); err != nil {
		Warn("语音通话挂断失败", "err", err)
	}
}

// voiceCallStatusHandler GET /voice_call_status —— 查询当前通话状态
func voiceCallStatusHandler(w http.ResponseWriter, r *http.Request) {
	st, err := voipStatusNow()
	if err != nil {
		writeJSON(w, map[string]any{"status": "failed", "error": err.Error()})
		return
	}
	writeJSON(w, map[string]any{"status": "ok", "busy": voiceCallBusy.Load(), "data": st})
}

// voiceCallHangupHandler POST /hangup_voice_call —— 手动挂断(打断长语音)
func voiceCallHangupHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "仅支持 POST", http.StatusMethodNotAllowed)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ret, err := safeExportsCall(ctx, "triggerVoipHangup")
	if err != nil {
		writeJSON(w, map[string]any{"status": "failed", "error": err.Error()})
		return
	}
	writeJSON(w, map[string]any{"status": "ok", "ret": jsString(ret)})
}
