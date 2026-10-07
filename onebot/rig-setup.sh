#!/bin/bash
# rig-setup.sh — 重建本地实验台 /tmp 现场(重启会清 /tmp)
# 用法: bash onebot/rig-setup.sh   (在仓库根目录执行)
set -e
REPO="$(cd "$(dirname "$0")/.." && pwd)"

mkdir -p /tmp/onebot-run/rendercheck /tmp/onebot-run/img

# 1. 本地 rig JSON = 生产 4_1_13_63_mac.json + uploadImageAddr→0x575bef4(本地真入口)
python3 - "$REPO" <<'EOF'
import json, sys
repo = sys.argv[1]
prod = json.load(open(repo + '/wechat_version/4_1_13_63_mac.json'))
prod['uploadImageAddr'] = '0x575bef4'   # 本地 start_c2c_upload; 生产 0x575c75c 在本地是内层 _startUploadMedia
json.dump(prod, open('/tmp/wechat_local_rig.json', 'w'), indent=2)
print('rig json ok')
EOF

# 2. 脚本包 = script.js + rigcapture.js(Go 启动时渲染模板)
cat "$REPO/onebot/script.js" "$REPO/onebot/rigcapture.js" > /tmp/onebot-run/script.js

# 3. 渲染 + 语法预检(不通过绝不进会话 — 铁律)
cd /tmp/onebot-run/rendercheck
go run "$REPO/onebot/rendercheck/main.go" /tmp/wechat_local_rig.json /tmp/rig_render_final.js
node --check /tmp/rig_render_final.js && echo "RENDER+SYNTAX OK"

# 4. 探针命令文件(会话内参数通道, shell 改它即可换模式)
echo '{"mode": 0, "forceLegacy": true}' > /tmp/rig_probe_cmd.json

# 5. 测试物料
python3 - <<'EOF'
import base64, json
wav = open('/Users/leslielu/Prog/weixin-macos/test-assets/test-voice.wav','rb').read()
body = {"user_id": "filehelper",
        "message": [{"type": "record", "data": {"file": "base64://" + base64.b64encode(wav).decode()}}]}
open('/tmp/probe_send.json','w').write(json.dumps(body))
print('probe_send.json ok, wav bytes:', len(wav))
EOF

cat <<'RUN'

现场就绪。启动顺序:
1) 打开 ~/Applications/WeChat-4.1.13.app, 登录
2) cd /tmp/onebot-run && nohup /Users/leslielu/Prog/weixin-macos/onebot/onebot \
     -type=gadget -gadget_addr=127.0.0.1:27042 \
     -wechat_conf=/tmp/wechat_local_rig.json -conn_type=http \
     -image_path=/tmp/onebot-run/img/ -wechat_id=ludaohe \
     > /tmp/onebot-run/onebot.log 2>&1 &
3) 等 60s 登录稳定门; 新实例需一次媒体活动激活 CdnManager 单例
   (手机给本号发一张图 → 下载 hook 回填 uploadGlobalX0)
4) 发测试语音:
   curl -s -X POST -H "Content-Type:application/json" \
     -d @/tmp/probe_send.json --max-time 130 \
     http://127.0.0.1:58080/send_private_msg
5) 看日志: grep -E "RIGCAP3|RIGPROBE|LEGACY|VOICEDUMP" /tmp/onebot-run/onebot.log
RUN
