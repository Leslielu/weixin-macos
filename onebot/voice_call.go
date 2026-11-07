package main

import (
	"context"
	"encoding/binary"
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
	// 8000/24000 是接听方自适应降采样后的目标(JS 兜底重采样有混叠, 人声会发尖)
	voipPCMRates = []int{8000, 16000, 24000, 44100, 48000}
)

// VoiceCallRequest /send_voice_call 请求体
type VoiceCallRequest struct {
	UserID        string `json:"user_id"`       // 被叫 wxid, 必填
	Voice         string `json:"voice"`         // 本地音频文件路径(wav/mp3/aiff/...)
	Text          string `json:"text"`          // 或用 TTS 合成(Voice 为空时生效)
	TTSVoice      string `json:"tts_voice"`     // macOS say 音色, 默认 Tingting
	Hangup        *bool  `json:"hangup"`        // 播完是否挂断, 默认 true(record 模式见下)
	Async         bool   `json:"async"`         // true = 立即返回, 通话在后台跑完
	MaxSeconds    int    `json:"max_seconds"`   // 单次播放上限(秒), 默认 120
	Timeout       int    `json:"timeout"`       // 等接听上限(秒), 默认 60
	Record        bool   `json:"record"`        // 采集对方下行音频(听对方), 存 WAV 返回路径
	RecordSeconds int    `json:"record_seconds"` // 采集时长上限(秒, 自接通起算), 默认 60
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
	FrameMs    int    `json:"frameMs"`
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
	if req.Voice == "" && req.Text == "" && !req.Record {
		http.Error(w, "voice/text/record 至少填一个", http.StatusBadRequest)
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
// 模式: 播放(voice/text) / 采集(record) / 两者同时(先播后录) / 纯采集。
func runVoiceCall(req VoiceCallRequest) map[string]any {
	maxSeconds := intOr(req.MaxSeconds, 120)
	answerTimeout := intOr(req.Timeout, 60)
	recordSeconds := intOr(req.RecordSeconds, 60)
	doHangup := boolOr(req.Hangup, true)
	playing := req.Voice != "" || req.Text != ""

	dir, err := os.MkdirTemp("", "onebot_voip_")
	if err != nil {
		return map[string]any{"status": "failed", "error": "临时目录创建失败: " + err.Error()}
	}
	defer os.RemoveAll(dir)

	var prefix string
	if playing {
		prefix, err = prepareVoIPPayload(dir, req.Voice, req.Text, req.TTSVoice, maxSeconds)
		if err != nil {
			return map[string]any{"status": "failed", "error": err.Error()}
		}
	}

	// 0. 先武装下行采集(JS 侧自己等接通才开始拉, 拨号前调用不影响拨号)
	if req.Record {
		capOpts, _ := json.Marshal(map[string]any{
			"path":       filepath.Join(dir, "down.pcm"),
			"maxSeconds": recordSeconds + 30, // 引擎就绪/接听等待的余量
		})
		capCtx, capCancel := context.WithTimeout(context.Background(), 10*time.Second)
		capRet, capErr := safeExportsCall(capCtx, "voipCaptureStart", string(capOpts))
		capCancel()
		if capErr != nil || jsString(capRet) != "ok" {
			Info("语音通话: 下行采集武装失败(继续通话)", "ret", jsString(capRet), "err", capErr)
		}
	}

	started := time.Now()
	// 1. 拨号(原生客户端入口, 会连带把微信自己的通话状态机/音频引擎拉起来)
	dialCtx, dialCancel := context.WithTimeout(context.Background(), 10*time.Second)
	dialRet, dialErr := safeExportsCall(dialCtx, "triggerVoipCall", req.UserID)
	dialCancel()
	if dialErr != nil {
		voipCaptureStopNow()
		return map[string]any{"status": "failed", "error": "拨号失败: " + dialErr.Error()}
	}
	if jsString(dialRet) != "0" {
		voipCaptureStopNow()
		return map[string]any{"status": "failed", "user_id": req.UserID,
			"error": "拨号未成功: " + jsString(dialRet)}
	}
	Info("语音通话: 已拨出", "user_id", req.UserID, "record", req.Record)

	// 2. 启动注入(JS 侧自己等接通: -405447 每 200ms 重试, 接通瞬间才开播)
	var final *voipJSStatus
	if playing {
		opts, _ := json.Marshal(map[string]any{"maxSeconds": maxSeconds})
		playCtx, playCancel := context.WithTimeout(context.Background(), 10*time.Second)
		playRet, playErr := safeExportsCall(playCtx, "voipPlay", prefix, string(opts))
		playCancel()
		if playErr != nil || jsString(playRet) != "ok" {
			msg := jsString(playRet)
			if playErr != nil {
				msg = playErr.Error()
			}
			voipCaptureStopNow()
			doHangupNow(doHangup)
			return map[string]any{"status": "failed", "error": "注入启动失败: " + msg}
		}
	}

	// 3. 轮询到 播放完成 && 采集完成 / 超时
	budget := answerTimeout + 15
	if playing {
		budget += maxSeconds
	}
	if req.Record {
		budget += recordSeconds
	}
	deadline := started.Add(time.Duration(budget) * time.Second)
	playDone := !playing
	recordDone := !req.Record
	var answeredAt time.Time
	var capStartedAt time.Time
	answered := false
	for {
		time.Sleep(300 * time.Millisecond)
		if playing && !playDone {
			st, err := voipStatusNow()
			if err == nil {
				if !st.Active {
					final = st
					playDone = true
				} else if st.Answered && answeredAt.IsZero() {
					answeredAt = time.Now()
				}
			}
		}
		if req.Record && !recordDone {
			cs, err := voipCaptureStatusNow()
			if err == nil && cs != nil {
				if !cs.Active {
					recordDone = true // JS 侧已收尾(call-end/max/stop)
				} else if answeredAt.IsZero() {
					answeredAt = time.Now() // 采集在跑 = 已接通
				}
				if cs.Active && cs.Phase == "run" && capStartedAt.IsZero() {
					capStartedAt = time.Now() // 真正开拉的时刻(引擎就绪可晚于接通数秒)
				}
			}
			if !capStartedAt.IsZero() && time.Since(capStartedAt) > time.Duration(recordSeconds)*time.Second {
				recordDone = true
			}
		}
		if !answeredAt.IsZero() {
			answered = true
		}
		if !answered && time.Since(started) > time.Duration(answerTimeout)*time.Second {
			Info("语音通话: 等接听超时, 挂断", "user_id", req.UserID,
				"waited_ms", time.Since(started).Milliseconds())
			voipCaptureStopNow()
			hangupVoIP()
			return map[string]any{"status": "failed", "user_id": req.UserID,
				"error":     "对方未接听(超时)",
				"waited_ms": time.Since(started).Milliseconds()}
		}
		if playDone && recordDone {
			break
		}
		if time.Now().After(deadline) {
			Info("语音通话: 总时长超限, 挂断", "user_id", req.UserID)
			break
		}
	}
	voipCaptureStopNow()
	if doHangup {
		hangupVoIP()
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
		// 播放时长 = 帧数 × 帧长(帧长每通协商, 20ms 居多)
		fms := l.FrameMs
		if fms <= 0 {
			fms = 20
		}
		data["played_seconds"] = float64(l.Calls) * float64(fms) / 1000.0
		if l.Error != "" {
			data["error"] = l.Error
		}
	}
	// 采集收尾: PCM → WAV 落盘 voice_records/
	if req.Record {
		data["record"] = finalizeVoiceRecording(dir, req.UserID)
	}
	Info("语音通话完成", "user_id", req.UserID, "data", data)
	return map[string]any{"status": "ok", "retcode": 0, "data": data}
}

// voipCaptureStopNow 请求 JS 停止下行采集并收尾(幂等)
func voipCaptureStopNow() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := safeExportsCall(ctx, "voipCaptureStop"); err != nil {
		Warn("语音通话: 停止采集失败", "err", err)
	}
}

type voipCapLast struct {
	Path      string  `json:"path"`
	Rate      int     `json:"rate"`
	FrameMs   int     `json:"frameMs"`
	PullBytes int     `json:"pullBytes"`
	Frames  int     `json:"frames"`
	Bytes   int     `json:"bytes"`
	SwapN   int     `json:"swapN"`
	ZeroN   int     `json:"zeroN"`
	Seconds float64 `json:"seconds"`
	Reason  string  `json:"reason"`
	Error   string  `json:"error"`
}

type voipCapStatus struct {
	Active bool         `json:"active"`
	Phase  string       `json:"phase"`
	Rate   int          `json:"rate"`
	Last   *voipCapLast `json:"last"`
}

func voipCaptureStatusNow() (*voipCapStatus, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	raw, err := safeExportsCall(ctx, "voipCaptureStatus")
	if err != nil {
		return nil, err
	}
	var st voipCapStatus
	if err := json.Unmarshal([]byte(jsString(raw)), &st); err != nil {
		return nil, fmt.Errorf("解析 voipCaptureStatus 失败: %v (%v)", err, raw)
	}
	return &st, nil
}

// finalizeVoiceRecording 把采集 PCM 封成 WAV 落盘, 返回摘要
func finalizeVoiceRecording(dir, userID string) map[string]any {
	pcmPath := filepath.Join(dir, "down.pcm")
	pcm, err := os.ReadFile(pcmPath)
	if err != nil {
		return map[string]any{"ok": false, "note": "无采集数据(未接通或引擎未就绪)"}
	}
	rate := 16000
	frame := 1280 // 20ms@48k×2B 兜底
	if st, err := voipCaptureStatusNow(); err == nil && st != nil && st.Last != nil {
		if st.Last.Rate > 0 {
			rate = st.Last.Rate
		}
		if st.Last.PullBytes > 0 {
			frame = st.Last.PullBytes
		}
	}
	// 裁掉首尾整帧数字静音(采集从响铃期就开始: startTalk 在拨出后即>=1,
	// 接通前的拉取全是零)。中间静音不动 — 时间轴语义只去头尾。
	orig := len(pcm)
	for len(pcm) >= frame && allZero(pcm[:frame]) {
		pcm = pcm[frame:]
	}
	for len(pcm) >= frame && allZero(pcm[len(pcm)-frame:]) {
		pcm = pcm[:len(pcm)-frame]
	}
	if len(pcm) == 0 {
		return map[string]any{"ok": true, "note": "全程数字静音(对方未出声)",
			"raw_seconds": float64(orig) / float64(rate) / 2}
	}
	if err := os.MkdirAll("voice_records", 0o755); err != nil {
		return map[string]any{"ok": false, "error": "创建 voice_records 失败: " + err.Error()}
	}
	name := fmt.Sprintf("call_%s_%d.wav", sanitizeFileToken(userID), time.Now().Unix())
	wavPath := filepath.Join("voice_records", name)
	if err := writeWAV(wavPath, pcm, rate, 1); err != nil {
		return map[string]any{"ok": false, "error": "WAV 封装失败: " + err.Error()}
	}
	abs, _ := filepath.Abs(wavPath)
	return map[string]any{"ok": true, "path": abs, "rate": rate, "bytes": len(pcm),
		"seconds":    float64(len(pcm)) / float64(rate) / 2,
		"raw_bytes":  orig,
		"trim_note":  "已裁首尾静音帧(响铃期+挂断尾)"}
}

func allZero(b []byte) bool {
	for _, v := range b {
		if v != 0 {
			return false
		}
	}
	return true
}

func sanitizeFileToken(s string) string {
	var b []byte
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' || r == '-' {
			b = append(b, byte(r))
		}
	}
	if len(b) == 0 {
		return "unknown"
	}
	return string(b)
}

// writeWAV 把 s16le PCM 封成 44 字节头的 WAV
func writeWAV(path string, pcm []byte, rate, channels int) error {
	const bits = 16
	blockAlign := channels * bits / 8
	byteRate := rate * blockAlign
	hdr := make([]byte, 44)
	copy(hdr[0:4], "RIFF")
	binary.LittleEndian.PutUint32(hdr[4:8], uint32(36+len(pcm)))
	copy(hdr[8:12], "WAVE")
	copy(hdr[12:16], "fmt ")
	binary.LittleEndian.PutUint32(hdr[16:20], 16) // PCM chunk size
	binary.LittleEndian.PutUint16(hdr[20:22], 1)  // PCM format
	binary.LittleEndian.PutUint16(hdr[22:24], uint16(channels))
	binary.LittleEndian.PutUint32(hdr[24:28], uint32(rate))
	binary.LittleEndian.PutUint32(hdr[28:32], uint32(byteRate))
	binary.LittleEndian.PutUint16(hdr[32:34], uint16(blockAlign))
	binary.LittleEndian.PutUint16(hdr[34:36], bits)
	copy(hdr[36:40], "data")
	binary.LittleEndian.PutUint32(hdr[40:44], uint32(len(pcm)))
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := f.Write(hdr); err != nil {
		return err
	}
	_, err = f.Write(pcm)
	return err
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
