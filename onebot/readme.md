## 如何使用onebot的http接口

### 使用方式和脚本基本一致：        
   1. 编译main.go或者直接下载编译好的onebot二进制文件       
   2. 如果不想关闭SIP直接使用，需要按gadget文档操作wechat的二进制，[文档](https://github.com/yincongcyincong/weixin-macos/tree/main/frida-gadget),需要找到自己的图片位置：./onebot -type=gadget -image_path='/Users/xx/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/wxid_xxx/temp/xxx/2026-01/Img/'
   3. 如果关闭了SIP， 直接使用pid即可，./onebot -image_path='/Users/xxx/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/wxid_xxx/temp/xxx/2026-01/Img/'
   4. 发送一张图片，如果成功证明已经patch成功，可以正常使用。
   5. 启动onebot服务，默认监听127.0.0.1:58080，可以通过http接口发送消息。
   6. 会把收到的消息通过 http://127.0.0.1:36060/onebot 其他参数可用./onebot -h查看


### 接口信息
私聊是send_private_msg     
群聊是send_group_msg       

```
curl -i -X POST \
   -H "Content-Type:application/json" \
   -d \
'{
  "message" : [{
    "data" : {
      "text" : "🚀successfully delete!"
    },
    "type" : "text"
  },{
    "data" : {
      "file" : "base64://"
    },
    "type" : "image"
  } ,{
    "data" : {
      "file" : "base64://"
    },
    "type" : "video"
  } ],
  "user_id" : "wxid_xxx"
}' \
 'http://127.0.0.1:58080/send_private_msg'
 
返回结果：
{"status":"ok"}

```

### 语音通话（拨号给对方播放一段语音）

给指定 wxid 拨一通微信语音通话，接通后播放给定的音频（或 TTS 合成的语音），播完挂断。

```
# 播放本地音频文件（wav/mp3/aiff 均可，内部用 ffmpeg 转 PCM）
curl -X POST -H "Content-Type:application/json" \
  -d '{"user_id":"wxid_xxx","voice":"/tmp/hello.wav"}' \
  http://127.0.0.1:58080/send_voice_call

# 或直接给一段要念的话（macOS say 合成，默认音色 Tingting）
curl -X POST -H "Content-Type:application/json" \
  -d '{"user_id":"wxid_xxx","text":"你好，这是一通语音播报"}' \
  http://127.0.0.1:58080/send_voice_call
```

可选参数：`tts_voice`（say 音色）、`hangup`（播完是否挂断，默认 true）、
`async`（true = 立即返回，通话在后台跑完）、`max_seconds`（播放上限，默认 120）、
`timeout`（等接听秒数，默认 60）、`record`（true = 采集对方声音，挂断后生成
静音裁剪的 WAV 落 `voice_records/`，响应返回路径）、`record_seconds`（采集秒数，
默认 60，自开拉时刻起算）。

```
# 纯采集模式: 不带 voice/text, 拨通只录音(听到对方说什么)
curl -X POST -H "Content-Type:application/json" \
  -d '{"user_id":"wxid_xxx","record":true,"record_seconds":30}' \
  http://127.0.0.1:58080/send_voice_call
```

返回：`{"status":"ok","retcode":0,"data":{"answered":true,"reason":"eof","frames":522,...}}`

配套接口：

- `GET  /voice_call_status` — 查询是否在通话中及上一通的注入摘要
- `POST /hangup_voice_call` — 手动挂断

注意：同一时刻只允许一通；出站放音 + 入站采集（record）均已可用。
链路细节与标定见 [docs/VOIP-CALL-STATUS.md](../docs/VOIP-CALL-STATUS.md) §13。

## 接入openclaw
```
# 进入插件目录
cd openclaw/extensions
# 克隆仓库
git clone https://github.com/constansino/openclaw_qq.git qq
# 安装依赖并构建
cd ../..
pnpm install && pnpm build
# 安装openclaw命令
npm install -g openclaw@latest
# 根据 https://github.com/constansino/openclaw_qq 把extension放到extensions目录下
openclaw plugins install ./extensions/qq
# 启动openclaw
openclaw gateway run
# 启动onebot
./onebot -wechat_pid=18835 -image_path='/Users/xxx/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/wxid_xxx/temp/xxx/2026-01/Img/ -conn_type=websocket
```

