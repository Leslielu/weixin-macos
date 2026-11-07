# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Upstream

This project is forked from https://github.com/yincongcyincong/wechat_chatter/

- 提 Issue 应提交到上游仓库，不是 fork
- 判断是否有更新、合并上游改动也基于此上游仓库

## Project Overview

WeChat macOS reverse engineering project. Hooks WeChat's underlying message sending capability (based on Tencent's open-source `mars` library) via Frida, and exposes a OneBot protocol HTTP/WebSocket API for programmatic message sending/receiving.

## Directory Structure

- `frida/` - Frida JavaScript hook scripts. Key files:
  - `succ.js` - Main hook script for message sending
  - `script.js` - Full-featured hook with message receiving
  - `text.js`, `upload_image.js`, `receiver.js` - Specialized hooks
- `onebot/` - Go service implementing OneBot protocol (HTTP/WebSocket)
- `tools/` - 逆向/分析工具：
  - `addrfind` - 跨版本地址迁移（方法论见 docs/version-upgrade.md）
  - `voip` - VoIP 语音通话逆向工具链（strxref/voipwalk/voipclimb 静态分析 + voipprobe runner + probe1-43 探针演进 + run_probe.py 探针驱动 + invite_payload.py 报文拼装），做通话相关工作先读 docs/VOIP-CALL-STATUS.md
- `idapro/` - IDA Pro Python analysis scripts
- `wechat_version/` - Memory address configs for different WeChat versions (JSON)
- `frida-gadget/` - Alternative approach for systems without SIP disabled
- `hook/` - Additional hook scripts
- `watchdog/` - 看门狗（权威副本在本仓库，生产运行在 mac-m1 `~/Prog/wxgate/`）:
  - `wechat-watchdog.sh` - 微信 bot 全链路看门狗（LaunchAgent `com.user.wechat_watchdog` 30s 一轮）
  - `ocr_allow.py` - TCC 弹窗「允许」按钮 OCR 定位（rapidocr/mumble venv），2026-09-28 起为点允许主路径
  - `ocr_selftest.sh` - 链路自检（launchd 上下文跑，只截屏+定位不点击）

**watchdog 改动部署流程**（改仓库版 → 部署 mac-m1）：远端先 `cp` 出 `.bak.日期` 备份，`bash -n` 过后 `mv` 原子替换（不打断正在跑的实例），`wechat-watchdog.sh` + `ocr_allow.py` 两件套一起放 `~/Prog/wxgate/`，md5 与仓库版核对。clicclick 只在 launchd 上下文有效，ssh 里测点击要借 `com.user.clicclick_test` LaunchAgent kickstart（其 /tmp runner 脚本会被定期清理，用前重建）。

## Common Commands

### Basic Frida Hook (SIP disabled)
```bash
frida -f /Applications/WeChat.app/Contents/MacOS/WeChat -l frida/succ.js
# In Frida console:
triggerSendTextMessage(0x20000095, "wxid_xxxx", "hi")
```

### With Frida Gadget (no SIP required)
Follow `frida-gadget/readme.md`, then:
```bash
frida -H 127.0.0.1:27042 -n Gadget -l ./frida/succ.js
```

### Build OneBot Service (本地编译)
```bash
cd ~/Prog/weixin-macos/onebot
CGO_CFLAGS="-I$HOME/Prog/weixin-macos/frida-devkit" CGO_LDFLAGS="-L$HOME/Prog/weixin-macos/frida-devkit" go build -o onebot .
```
frida-core-devkit 17.8.1 存放在项目目录 `frida-devkit/`（已加入 .gitignore，不提交 git）。
原始压缩包在 `~/frida-dev/frida-core-devkit-17.8.1-macos-arm64.tar.xz`。
编译产物直接 rsync 到远端 Mac 即可，远端不需要编译环境。

**编译后必须重签名**（mac-m1 上 onebot 以 `com.leslie.onebot` 固定证书签名运行）：
每次 `go build` 产出全新未签名二进制，须用固定证书重签——证书身份不变，macOS TCC 授权才不会
失效重弹窗。材料在本机 `~/.wxsign/`（`wxsign.p12` + `wxsign.p12.pass`，CN=wxgate-signer，
2036 到期，wxgate/onebot 共用）。临时钥匙串法全程免 GUI 弹窗，用完即删：

```bash
cd ~/Prog/weixin-macos/onebot && \
PASS=$(cat ~/.wxsign/wxsign.p12.pass) && \
security create-keychain -p "$PASS" onebot-signer-tmp && \
security import ~/.wxsign/wxsign.p12 -k onebot-signer-tmp -P "$PASS" && \
security set-key-partition-list -S apple-tool:,apple: -k "$PASS" onebot-signer-tmp >/dev/null && \
codesign --force --sign wxgate-signer --identifier com.leslie.onebot onebot && \
security delete-keychain onebot-signer-tmp && \
codesign --verify --strict onebot && echo SIGN_OK
```

部署：签名后 rsync/scp 二进制到 mac-m1 `~/Prog/weixin-macos/onebot/onebot`，再重启链路
（mac-m1 `~/Prog/wxgate/start.sh restart`，先停 onebot→wxgate 再依序拉起）。

**运行硬依赖（启动自检 fail-fast）**：`python3 + pilk`（silk 语音编码）。新机器：
`brew install python@3.x` 后 `/opt/homebrew/bin/python3 -m pip install pilk`。缺失时 onebot
拒绝启动（2026-10-08 滋啦事故：缺 pilk 曾静默回退 go-silk，腾讯解码器不认，详见
docs/VOICE-BATTLE-STATUS.md §15）。

### Run OneBot
```bash
# Local mode (SIP disabled)
./onebot/onebot -image_path='/Users/xxx/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/wxid_xxx/temp/xxx/2026-01/Img/'

# Gadget mode (no SIP)
./onebot/onebot -type=gadget -gadget_addr=127.0.0.1:27042 -image_path='...'
```

### Test OneBot API
```bash
curl -X POST -H "Content-Type:application/json" \
  -d '{"user_id":"wxid_xxx","message":[{"type":"text","data":{"text":"hello"}}]}' \
  http://127.0.0.1:58080/send_private_msg
```

## Key Architecture Notes

### 崩溃/发送异常排查
**先读 `docs/crash-history.md`** —— 历次崩溃的指纹、根因、已上线修复和遗留问题都在里面，别从零开始。

两条血泪规程（2026-11-01 复现）：
- **别单独重启存活微信上的 onebot**。gadget 会话拆除有竞态（G 类，实测会 SIGSEGV 崩微信），
  且反复重启会耗尽 gadget 会话（F 类，实测预算约 9 次/微信生命周期）。改 `script.js` 或二进制的
  规程是**改好 → 重启微信 → 登录 → 起新 onebot**，一次到位别反复。
- **探针只在开发副本跑**。生产微信上再挂 frida client 会让拦截器状态劣化，之后
  `Interceptor.attach` 在个别地址报 `unable to intercept function at 0x...`（resp-dispatch /
  下载 hook）→ **静默收不到消息**（微信侧照常下载，onebot 零转发）。启动日志出现 ERROR 级
  「关键 hook 挂载失败」就是它。处置只有一条：**重启微信**拿全新进程，在旧进程上再重启
  onebot 只会更糟。

### 语音通话（VoIP）相关工作
**先读 `docs/VOIP-CALL-STATUS.md`** —— 通话信令全图、`0x1fdc80c` 统一发送函数、原生入口与音频注入全标定。核心入口（§11/§13）：
- **拨号**：静态单例 `CLIENT=BASE+0x9b93ab8`，`0x1fc07f4(client, 被叫cstr, vector<string>*, 1, 0, 0x2e6981b3)`，ret=1 即成功；`+0x28` 是初始化标志不是一次性门禁（§12.4 旧结论已作废）。简化版：`svc=GetWXConfService(0x1352707)`，拨出 `vt[6]=ConfSDKdyn+0x79ab4(svc, pb, 50)`（pb 第一字段=被叫 wxid，field7 可填 0），挂断 `vt[12]=ConfSDKdyn+0x79dfc(svc,1,0)`。§10 的 selector 34 注入口只能响铃接不通（历史路线）。
- **给对方播放语音（§13 已打通）**：`ConfSDKdyn+0x7a370(svc, pcm, len, 24000, 1)` 外部 PCM 注入。铁律：帧长**按每通电话协商出的引擎格式现算**——`frameMs×采样率×声道/1000` 是**样本数**，×2 才是字节（16k→960B=640B 内容+320B 零尾；48k→1920B 整帧无尾），内容先重采样到该采样率；声明采样率恒定 24000；每 20ms 推一帧（绝对时间线节拍）；接通后必须调 `MuteMicPhone`（`ConfSDKdyn+0x662e0(confEngine,1)`，confEngine=`[svc+8]+0xa10`），否则音调 ×1.5 偏快。格式从 `[svc+8]+0xa10`+8 的 mvq 对象 `-8+0x234/0x254/0x258` 读，**拨号前为空，要在前 40 个 tick 重试、并在接通瞬间重读**（设备采样率每通协商不同，16000/48000 都实测出现过；写死 960B 打 48k 通话会造成间歇空白）。`-405447`=未接通（200ms 重试自动等接听）。遗留疑点：同配置偶发一轮杂音（嫌疑 SDK 录音器设备竞争，复现时先占住内建麦克风）。入站采集已通（2026-11-02）：每 20ms 拉 `GetAudioData(+0x4dba8)`，x2 必须传引擎登记的每拉字节数 `[av+0x2320]`（传错恒 -1）；部分通话会吐 16bit 字节交换帧（按 LE/BE 幅度判别交换）；`+0x7a388` 在无播放上下文时仍禁止盲调（必崩）。**拓扑铁律（§14，2026-11-07 修订）**：音质验收优先让被测方**拨号**、自己接听；"接听方注入=40ms 空洞+2 倍慢放"的旧结论实为**双生产源交替**（§17.9：在录音回调入口门控麦克风源后 0 洞），生产路径本就是拨号方注入，维持不变。
- **0x546a558/0x5470f7c/0x54704e4/0x5470644/0x5470688 一律禁止挂钩子**：PAC 签名间接调用目标，挂上必崩 AudioIOThread（毒值 `0xac4400000002`）。Stalker 必崩；SubmitCgi 读 x1。探针用 `run_probe.py` 跑（日志追加写，等待循环要按行号偏移 grep；触发文件边沿触发，每轮两个都要刷新）。开发副本 = 本机 `~/Applications/WeChat-4.1.13.app`（与生产同版本，地址直接通用）。

### Version-Specific Memory Addresses
Each WeChat version requires specific memory offsets in `wechat_version/*.json`. When adding new versions:
1. Use IDA Pro to find function addresses (search `MMStartTask`, `Req2Buf`)
2. Update corresponding JSON with new addresses
3. Key addresses: `sendFuncAddr`, `req2bufEnterAddr`, `req2bufExitAddr`, `protobufAddr`, etc.

### Message Flow
1. Hook `STNManager__MMStartTask` - triggers message task start
2. Hook `Req2Buf` - inject protobuf message body
3. Clear message body before `OnTaskEnd` to prevent crash (memory cleanup)

### OneBot Integration
- Default HTTP server: `127.0.0.1:58080`
- Message callback URL: `http://127.0.0.1:36060/onebot` (configurable)
- Supports both HTTP and WebSocket connections (`-conn_type=websocket`)
- 语音通话（2026-11-01 实现，2026-11-02 增采集并部署 mac-m1）：`POST /send_voice_call`
  `{user_id, voice|<text>, record?, record_seconds?, async?, hangup?, max_seconds?, timeout?}` —
  拨号、等接听、播放给定音频或 TTS、挂断；`record:true` 采集对方下行音频（听对方），
  挂断后裁首尾静音封装 WAV 落 `voice_records/` 并在响应返回路径；不带 voice/text 时为纯采集模式。
  配 `GET /voice_call_status`、`POST /hangup_voice_call`。同一时刻只允许一通，出站/入站互斥。
  入站接听（2026-11-05）：`POST /voice_call_inbound`
  `{enabled, voice|<text>, record?, max_seconds?, answer_delay_ms?, window_seconds?, multi?, hangup?, mute_mic?, mic_gate?}` —
  布防后来电自动接听 → 采集对方下行（录音）/实验性播放 → 挂断；`enabled:false` 解除；
  配 `GET /voice_call_inbound_status`（通话结束自动封 `voice_records/call_inbound_<ts>.wav`）。
  实验参数：`content_rate_div`（默认 1，内容率=引擎率，降半会音高×2）、`no_pad`（默认 true）、
  `load_rate`、`feed_interval_ms`、`full_frame`、`declared_rate`、`callee40`、`start_delay_ms`。
  实现见 `onebot/voice_call.go`、`onebot/voice_call_inbound.go` + `onebot/script.js` 的 VoIP 分区，
  标定见 `docs/VOIP-CALL-STATUS.md` §13.5(注入)/§16(采集)/§17(入站接听)/§17.7(喂入链静态)/
  §17.9(接听方空洞根因, §17.8 为历史记录).
  ⚠️ 注入口 `PutExternalRecordData` 每次调用**只吃一个引擎帧**（§17.7 B，多喂必被截）。
  **接听方播放空洞根因已结案（2026-11-07 深夜，§17.9）**：原生麦克风路径以 50 帧/s 产出
  20ms **数字静音帧**，与外部注入帧交替进 mixer ⇒ 每 40ms 一个 ~19ms 洞（占空比 ~59%）。
  在 `XVE_RecordDevDataCallBack`（`MultiMediaDyn+0x795c4`；4.1.13 静态为 `+0x78050`）入口
  把 `eng+0x75cc`（4.1.13 静态为 `+0x7504`）写 2，让该回调走"直接 ret 0"分支后，同样本
  M1 录音 **0 洞 / 100% 占空比**（对照 59.2%/244 洞）。**写字段+轮询无效**（SDK 每次原生
  回调前会写回 0）；只有回调入口 onEnter 拦得住。`MM+0x79720` 是 PlayDevDataCallBack，
  不能门控。版本 JSON 可选键 `voipMicGateAddr` / `voipMicGateModeOff`（须成对，缺任一即门控禁用）；
  仅接听方文件播放启用，出站与纯采集接听不受影响。4.1.15.55 已按"重启微信→登录→起新 onebot"
  走真实 HTTP 路径端到端验收（`mic_gate` 默认 0 洞/100%，`false` 对照 59.2%/271 洞，§17.9 D）。
  4.1.13 地址为静态定位、未运行时验证。
  **开发副本注意**：调过公开原生录音入口
  `0x7eb18` 后引擎被锁 mode-1（进程级持久、麦克风被旁路），重启微信才恢复。
- For OpenClaw integration, see `onebot/readme.md`

## IDA Pro Usage

```bash
# Attach to running WeChat (ARM macOS)
sudo /Applications/IDA\ Professional\ 9.1.app/Contents/MacOS/ida
# Or use remote debug server:
/Applications/IDA\ Professional\ 9.1.app/Contents/MacOS/dbgsrv/mac_server_arm
```

**Note**: `WeChatExt` code can cause IDA Pro issues.
