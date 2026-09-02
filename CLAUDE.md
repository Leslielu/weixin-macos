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
- `idapro/` - IDA Pro Python analysis scripts
- `wechat_version/` - Memory address configs for different WeChat versions (JSON)
- `frida-gadget/` - Alternative approach for systems without SIP disabled
- `hook/` - Additional hook scripts

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
- For OpenClaw integration, see `onebot/readme.md`

## IDA Pro Usage

```bash
# Attach to running WeChat (ARM macOS)
sudo /Applications/IDA\ Professional\ 9.1.app/Contents/MacOS/ida
# Or use remote debug server:
/Applications/IDA\ Professional\ 9.1.app/Contents/MacOS/dbgsrv/mac_server_arm
```

**Note**: `WeChatExt` code can cause IDA Pro issues.
