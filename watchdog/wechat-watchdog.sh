#!/bin/bash
# 微信 bot 全链路看门狗
# 职责:
#   1. 微信死亡 → 清理微信全家桶残留(防更新弹窗截获回车) → 拉起 + 自动登录点击 + 重启 bot 链
#      (onebot/wxgate 不会自动重连微信, 必须重启)
#   2. 微信被外部重启(升级/手动) → 检测 PID 变化 → 重启 bot 链
#   3. onebot 58080 没监听 → 重启 bot 链
# 告警: 恢复完成后给 ludaohe 发文本+截屏(经 onebot 58080, 恢复后必达);
#       死亡瞬间链路已断发不出, 只记日志(留档截图在 shots/ 供事后诊断)
# 回车安全: 每次回车前用 lsappinfo 检查前台应用必须是微信本体, 否则跳过
#           (更新助手是独立进程, crash 后其弹窗可能仍在前台, 默认按钮=立即更新, 误触即版本升级)
# TCC 兼容(2026-09-22): 4.1.13 重签后每次拉起必弹两次"想访问其他App的数据"授权框,
#           检测到 UserNotificationCenter 前台 → 截屏留证 + 自动点"允许"(坐标 ALLOW_X/Y)
# 开机自启(2026-09-27): 开机缓冲门(0节, uptime<180s或风暴未落定不动) → 微信在
#           pm2/隧道风暴落定后才拉起; 开机窗口登录预算加倍(1节) + 存活分支兜底(2.5节)
# OCR 点允许(2026-09-28): click_allow() = 现截屏 → ocr_allow.py 定位「允许」文字按钮
#           → 点它; 用 88 张历史截图验收(26 张含弹窗全部命中/零误报), 同时修复两个
#           旧缺口: ① 弹窗加高变体固定坐标点偏(逻辑 y 实测漂移 334~411) ② 开机窗口
#           主屏=内置 Retina 时只能放弃点击。OCR 确认无弹窗时不盲点, 且连续 3 次确认
#           无弹窗 + UNC 进程仍在 → 判僵尸 UNC 直接杀掉(否则前台被卡死→登录躺尸,
#           2026-09-28 演练实锤)。OCR 不可用/没找到 → 退回固定坐标+main_is_dummy。
# 升级弹窗: 不做主动点击(误点"立即更新"=版本升级=hook地址全废, 宁可它挡着);
#           防线 = 拉起前杀更新器残留 + 源头禁更新检查(SUEnableAutomaticCheck(s))
#           + 回车只在引导循环/开机窗口内按有限预算发(检查已禁, 暴露窗口极低)
# ⚠️ 登录态: wxid目录可见≠已登录(会话恢复场景实测翻车), 看门狗不依赖登录态决策
# 挂起: touch /tmp/wechat_watchdog.paused (升级微信前用), 恢复: rm 该文件
# 由 com.user.wechat_watchdog.plist 每 30s 调用, 幂等

ENABLE_LOGIN_CLICK=1
CLICK_MODE=return      # return=回车(进入微信为默认按钮); 坐标模式改 click
CLICK_X=960            # 1920x1080 屏, 登录窗居中时的按钮坐标(待实测校准)
CLICK_Y=690
# TCC 授权弹窗("微信"想访问其他App的数据)的"允许"按钮坐标。
# 4.1.13 起(2026-09-22 实测)每次拉起必弹两次(crash 一次+启动一次), 不点掉
# 到不了登录窗。弹窗由系统 UserNotificationCenter 渲染, 1920x1080 屏几何固定,
# 坐标 = 09-19 标定值。
# ⚠️ 2026-09-28 起降级为兜底: 正常路径走 OCR 现场定位(click_allow), 历史弹窗
# "允许"逻辑 y 实测漂移 334~411(加高变体), 固定坐标 375 对 334/406 变体已点偏;
# 且开机窗口主屏=内置屏(1512x982 逻辑@2x)时固定坐标完全失效。本坐标仅在 OCR
# 失败且 main_is_dummy 通过时使用。
ALLOW_X=1018
ALLOW_Y=375

WXGATE_DIR="$HOME/Prog/wxgate"
WECHAT_APP="$HOME/Applications/WeChat.app"
CLICCLICK="$(ls "$HOME"/Applications/*clic*.app/Contents/MacOS/* 2>/dev/null | head -1)"
PID_FILE="/tmp/wechat_watchdog.last_pid"
LOG="$WXGATE_DIR/watchdog.log"
ALERT_USER="ludaohe"
SHOTS_DIR="$WXGATE_DIR/shots"
# OCR 定位「允许」(2026-09-28): rapidocr 装在 mumble venv 里; helper 与本脚本
# 同仓库(weixin-macos/watchdog/ocr_allow.py), 部署时两件套一起放 ~/Prog/wxgate/。
# 任一缺失 click_allow 自动退固定坐标兜底, 不影响原行为。
OCR_PY="$HOME/Prog/mumble/.venv/bin/python"
OCR_ALLOW="$WXGATE_DIR/ocr_allow.py"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [wechat-watchdog] $*" >> "$LOG"; }

# --- 告警函数(尽力而为, 链路未恢复时静默失败) ---
# notify 发文本; snap 合成⌘⇧3截屏并等待落盘, echo 最新截图路径; notify_img 发文本+图(base64)
notify() {
    curl -s -m 6 -X POST -H "Content-Type:application/json" \
        -d "{\"user_id\":\"$ALERT_USER\",\"message\":[{\"type\":\"text\",\"data\":{\"text\":\"[看门狗] $*\"}}]}" \
        http://127.0.0.1:58080/send_private_msg >/dev/null 2>&1 || true
}

snap() {
    [ -n "$CLICCLICK" ] && "$CLICCLICK" -r kd:cmd kd:shift t:3 ku:shift ku:cmd 2>/dev/null
    sleep 6   # 落盘等待(已关截屏预览 show-thumbnail, 正常秒落, 留余量)
    ls -t "$SHOTS_DIR"/截屏*.png 2>/dev/null | head -1
}

send_img_once() {  # $1=图片 $2=文本; 响应含 "ok" 才算成功
    python3 - "$1" "$ALERT_USER" "$2" <<'PYEOF' 2>/dev/null
import sys, base64, json, urllib.request
img, user, text = sys.argv[1], sys.argv[2], sys.argv[3]
with open(img,'rb') as f: b64 = base64.b64encode(f.read()).decode()
msgs = [{"type":"text","data":{"text":text}}, {"type":"image","data":{"file":"base64://"+b64}}]
body = json.dumps({"user_id":user,"message":msgs}).encode()
req = urllib.request.Request("http://127.0.0.1:58080/send_private_msg",
                             data=body, headers={"Content-Type":"application/json"})
resp = urllib.request.urlopen(req, timeout=60).read().decode()
sys.exit(0 if '"ok"' in resp else 1)
PYEOF
}

notify_img() {  # $1=图片路径 $2=文本; 链刚恢复时 CdnManager 可能未就绪, 失败自动重试一次
    local img="$1" attempt
    [ -f "$img" ] || return 1
    for attempt in 1 2; do
        if send_img_once "$img" "$2"; then
            return 0
        fi
        [ "$attempt" = "1" ] && sleep 10
    done
    return 1
}

wx_pid() { pgrep -f "MacOS/WeChat$" 2>/dev/null | head -1; }

# 前台应用 bundle id (lsappinfo 不需要辅助功能权限)
frontmost_bundle() {
    local asn
    asn=$(lsappinfo front 2>/dev/null)
    [ -n "$asn" ] && lsappinfo info -only bundleid "$asn" 2>/dev/null | sed -n 's/.*= *"\(.*\)"/\1/p'
}

# TCC 授权弹窗存在性(进程级, 不依赖前台判定): 2026-09-27 重启实测, 会话恢复场景
# 弹窗不抢前台(lsappinfo front 探不到, 显示的是clash), pgrep 进程最可靠。
tcc_up() { pgrep -f "UserNotificationCenter.app/Contents/MacOS/UserNotificationCenter" >/dev/null 2>&1; }

# 主屏是否 UGREEN dummy(1920x1080): ALLOW_X/Y 只在这块屏上标定过。运行期常态就是
# dummy 主屏; 开机窗口期主屏可能是内置屏(镜像虚拟16:9, 分辨率 3024x1964), 此时固定
# 坐标点不中还会误点别处 → 跳过。判定 = 主屏块(含 "Main Display: Yes")的 Resolution,
# 不需要 Retina 换算(dummy 是 1:1)。system_profiler ~1-3s, 只在 TCC 分支被调, 可接受。
main_is_dummy() {
    local res
    res=$(system_profiler SPDisplaysDataType 2>/dev/null \
        | awk '/Resolution:/{r=$0} /Main Display: Yes/{print r; exit}' \
        | grep -o '[0-9]* x [0-9]*' | head -1)
    [ "$res" = "1920 x 1080" ]
}

# --- OCR 点「允许」两件套(2026-09-28) ---

# 触发 ⌘⇧3 并等新截图落盘, echo 新文件路径(多屏时一张/屏, 多行)。
# 比 snap() 快: 轮询检测到新文件即收(实测秒级落盘), 不固定 sleep 6。
# 用 mtime 基线文件比对(find -newer), 文件名含空格/中文都没问题。
snap_new() {
    local mark="$SHOTS_DIR/.snap_mark" _w
    [ -n "$CLICCLICK" ] || return 1
    touch "$mark"   # 必须在按键前 touch: 截图 mtime 一定晚于基线
    "$CLICCLICK" -r kd:cmd kd:shift t:3 ku:shift ku:cmd 2>/dev/null || return 1
    for _w in 1 2 3 4 5 6 7 8 9 10 11 12; do
        sleep 0.5
        if [ -n "$(find "$SHOTS_DIR" -maxdepth 1 -name '截屏*.png' -newer "$mark" 2>/dev/null)" ]; then
            sleep 1   # 多屏时两张几乎同时落盘, 稳定一下再收全
            find "$SHOTS_DIR" -maxdepth 1 -name '截屏*.png' -newer "$mark" 2>/dev/null
            return 0
        fi
    done
    return 1
}

# 点掉当前 TCC 弹窗的「允许」: snap_new → ocr_allow.py → 点 OCR 坐标。
# OCR 已按截图 scale 折算成逻辑点(Retina /2), 坐标即 clicclick 全局坐标(弹窗
# 出现在主屏, 主屏原点=(0,0))。返回码:
#   0 = 已发点击(OCR 定位, 或 OCR 不可用时的固定坐标兜底)
#   2 = OCR 跑过且确认屏上没有弹窗(MISS) — 调用方绝不能再盲点固定坐标
#       (2026-09-28 演练实锤: 弹窗清完后盲点打在 clash 窗口上), 应记 MISS 连击
#   1 = OCR 不可用/输出异常且兜底也没点成(非 dummy 屏跳过等)
click_allow() {
    local f line rest x y
    if [ -x "$OCR_PY" ] && [ -f "$OCR_ALLOW" ]; then
        local -a files=()
        while IFS= read -r f; do
            [ -n "$f" ] && files+=("$f")
        done < <(snap_new)
        if [ "${#files[@]}" -gt 0 ]; then
            line=$("$OCR_PY" "$OCR_ALLOW" "${files[@]}" 2>>"$LOG")
            if [ "${line%% *}" = "OK" ]; then
                rest=${line#OK }          # "x y 文件名 scale conf"
                x=${rest%% *}; rest=${rest#* }; y=${rest%% *}
                if "$CLICCLICK" -r "c:${x},${y}" 2>>"$LOG"; then
                    log "OCR定位并点允许 ${x},${y} (${rest#* })"
                    return 0
                fi
                return 1   # clicclick 失败(辅助功能问题), 不再退坐标盲点
            fi
            if [ "${line%% *}" = "MISS" ]; then
                log "OCR确认屏上无弹窗(${line}), 不盲点"
                return 2
            fi
            log "OCR输出异常(${line}), 走固定坐标兜底"
        else
            log "OCR点允许: 截屏未落盘, 走固定坐标兜底"
        fi
    fi
    if main_is_dummy; then
        if "$CLICCLICK" -r "c:${ALLOW_X},${ALLOW_Y}" 2>>"$LOG"; then
            log "固定坐标点允许 ${ALLOW_X},${ALLOW_Y}"
            return 0
        fi
        return 1
    fi
    if [ -z "$NONDUMMY_LOGGED" ]; then
        NONDUMMY_LOGGED=1
        log "主屏非1920x1080 dummy 且 OCR 未定位, 跳过点允许 (人工切回dummy后kill微信可走原恢复路径)"
    fi
    return 1
}

# OCR 连续确认无弹窗(rc=2)但 tcc_up 恒真 → UNC 是僵尸: 弹窗已被点掉、进程残留
# 数分钟, 前台判定被它卡死(前台翻到别的 App 也会被 BID 覆盖逻辑按住), 引导循环
# 空转到上限, 微信站登录窗躺尸(2026-09-28 演练 + 2026-09-27 开机两次实锤)。
# 对策: 连续 3 次 MISS(引导循环≈30s / 2.5节≈3min)直接杀 UNC 解锁前台;
# 真弹窗若还在排队(TCC 全局队列), 30s 内必然已上屏被 OCR 看见, 不会误杀。
# 状态存 /tmp 文件: 看门狗每轮是新进程, 循环内/2.5节跨轮都要共用这个计数。
MISS_FILE="/tmp/wechat_watchdog.ocrmiss"
note_ocr_miss() {  # $1=0 重置连击(点到了弹窗); $1=1 记一次 MISS, 满3杀僵尸
    local n
    n=$(cat "$MISS_FILE" 2>/dev/null)
    n=${n:-0}
    if [ "$1" = "0" ]; then
        [ "$n" != "0" ] && echo 0 > "$MISS_FILE"
        return 0
    fi
    n=$((n + 1))
    echo "$n" > "$MISS_FILE"
    if [ "$n" -ge 3 ]; then
        echo 0 > "$MISS_FILE"
        if pkill -9 -f "UserNotificationCenter.app/Contents/MacOS/UserNotificationCenter" 2>/dev/null; then
            log "OCR连续${n}次确认无弹窗, 已杀僵尸UNC解锁前台(等激活微信+回车)"
        fi
    fi
    return 0
}

# ⚠️ 教训(2026-09-27 重启实测): wxid_* 目录可见 ≠ 已登录 — 会话恢复启动时目录从
# 上次会话遗留, 微信卡 TCC 未登录时目录照样在。禁止用目录可见性当登录信号,
# 看门狗所有动作不得依赖登录态。

restart_chain() {
    log "重启 bot 链 (start.sh restart)"
    "$WXGATE_DIR/start.sh" restart >> "$LOG" 2>&1
    # 记录重启后的微信 PID, 防止下一轮 PID 变化检查重复触发
    wx_pid > "$PID_FILE" 2>/dev/null
}

[ -f /tmp/wechat_watchdog.paused ] && { log "已挂起(paused), 跳过本轮"; exit 0; }

# --- 0. 开机缓冲(2026-09-27): 开机瞬间 pm2(13进程)/各隧道/BetterDisplay 同时起,
# 16GB 内存风暴期拉微信大应用 → 冷启动慢 + 弹窗时序漂移 → 登录引导预算易耗尽。
# grace(180s) 内只等不动; 180~420s 间若 load1 仍 >6 继续等; 420s 硬上限强制放行。
# 平时崩溃恢复 uptime 按天计, 永不进此分支, 恢复速度不受影响。
# 测试钩子: WD_TEST_UPTIME=秒 直接伪造 uptime 验证本门(仅 ssh 手动跑时用)。
BOOT_GRACE_SEC=180
BOOT_HARD_CAP_SEC=420
LOAD_WAIT_MAX=6
# 注意: 正则必须锚定行首 "^{ sec = " —— 输出里 "usec = " 同样含 "sec = ", 贪婪匹配会
# 抓到 usec 值(910797)当 BOOT_SEC → UPTIME 虚高 17 亿秒 → 缓冲门永远不生效
# (2026-09-27 重启实测翻车根因)
BOOT_SEC=$(sysctl -n kern.boottime | sed -n 's/^{ sec = \([0-9]*\),.*/\1/p')
[ -n "$BOOT_SEC" ] || BOOT_SEC=0   # 解析失败的兜底: UPTIME 变巨大 → 跳过缓冲直接巡检
if [ -n "$WD_TEST_UPTIME" ]; then
    UPTIME="$WD_TEST_UPTIME"
else
    UPTIME=$(( $(date +%s) - BOOT_SEC ))
fi
LOAD1=$(sysctl -n vm.loadavg | awk '{print int($2)}')
if [ "$UPTIME" -lt "$BOOT_GRACE_SEC" ] || { [ "$UPTIME" -lt "$BOOT_HARD_CAP_SEC" ] && [ "$LOAD1" -gt "$LOAD_WAIT_MAX" ]; }; then
    [ "$(cat /tmp/wechat_watchdog.bootgrace 2>/dev/null)" = "waiting" ] || {
        echo waiting > /tmp/wechat_watchdog.bootgrace
        log "开机缓冲: uptime=${UPTIME}s load1=${LOAD1}, 等系统稳定后再拉微信 (grace=${BOOT_GRACE_SEC}s cap=${BOOT_HARD_CAP_SEC}s)"
    }
    exit 0
fi
if [ -f /tmp/wechat_watchdog.bootgrace ]; then
    rm -f /tmp/wechat_watchdog.bootgrace
    log "开机缓冲结束: uptime=${UPTIME}s load1=${LOAD1}, 开始正常巡检"
fi

# --- 1. 微信死亡 → 清残留 → 拉起 → 登录点击 → 链重启 ---
if [ -z "$(wx_pid)" ]; then
    DEAD_TS="$(date '+%H:%M:%S')"
    # 清理微信全家桶残留进程: AppEx 小程序、更新器(XSparkle)、崩溃报告弹窗等
    # 防止残留的更新提示窗口截获回车, 也防止旧 AppEx 挂着影响重启
    # ReportCrash = "微信意外退出"弹窗(重新打开/报告/忽略), 挡在前台会让登录回车被门禁跳过
    # (2026-09-03 06:11 事故: 弹窗挡道→回车全跳过→微信停在登录窗45分钟)
    pkill -9 -if "wechatappex" 2>/dev/null && log "清理 WeChatAppEx 残留"
    pkill -9 -if "wechatupdate|wechat_updater" 2>/dev/null && log "清理微信更新器残留"
    pkill -9 -if "xsparkle" 2>/dev/null && log "清理 XSparkle 残留"
    pkill -9 ReportCrash 2>/dev/null && log "清理崩溃报告弹窗(ReportCrash)"
    pkill -9 -if "crashreporter" 2>/dev/null && log "清理崩溃报告弹窗(CrashReporter)"
    sleep 1

    # 源头压制升级提示(2026-09-27): 设置里关的是"自动更新", 更新检查运行期照跑,
    # 查到新版照样弹提示窗。微信 XSparkle 单/复数两个键都写 0 (复数 SUEnableAutomaticChecks
    # 是微信自己写过的键, 更可能是它真读的那个)。此时微信必然未运行, 写容器内域安全;
    # 真要升级走 wechat-update 人工流程。
    WX_PLIST="$HOME/Library/Containers/com.tencent.xinWeChat/Data/Library/Preferences/com.tencent.xinWeChat.plist"
    su_write_ok=0
    for _try in 1 2; do
        if defaults write "$WX_PLIST" SUEnableAutomaticCheck -bool false 2>>"$LOG"; then su_write_ok=1; break; fi
        sleep 2   # 微信刚死, 其沙箱 cfprefd 可能还在 flush 容器 plist, 瞬态锁 (2026-09-27 实测)
    done
    if [ "$su_write_ok" = "1" ]; then
        defaults write "$WX_PLIST" SUEnableAutomaticChecks -bool false 2>>"$LOG"
        defaults write "$WX_PLIST" SUScheduledCheckInterval -int 31536000 2>>"$LOG"
        log "已确保微信更新检查关闭(SUEnableAutomaticCheck(s)=false)"
    fi

    log "微信未运行, 拉起..."
    open "$WECHAT_APP"
    if [ "$ENABLE_LOGIN_CLICK" = "1" ] && [ -n "$CLICCLICK" ]; then
        # 登录引导状态机(2026-09-22 加 TCC 兼容): 4.1.13 重签后每次拉起必弹
        # 两次 TCC 授权框(前台=com.apple.UserNotificationCenter), 挡在登录窗前面,
        # 不点"允许"回车永远被门禁跳过。3s 一轮, 上限 40 轮(120s):
        #   UNC 前台  → 首次截屏留证(shots/, 校准用) + 点"允许"(预算6次)
        #   微信前台  → 回车进入登录(预算3次, 间隔≥9s, 与旧版 8/6/6 节奏一致)
        #   其他前台  → 等待(只按应用切换记日志, 防刷屏)
        # 回车安全门禁不变: 只有微信本体在前台才回车, 更新弹窗/其他 App 永不误触
        ALLOW_BUDGET=6
        RETURN_BUDGET=3
        ACTIVATE_BUDGET=3
        MAX_ROUNDS=40
        # 开机窗口(uptime<15min)预算加倍(2026-09-27): 冷启动+系统刚稳, 弹窗/登录窗
        # 比平时慢, 引导提前放弃 → 微信停登录窗 → 落入存活分支不回车缺口
        if [ "$UPTIME" -lt 900 ]; then
            RETURN_BUDGET=6
            ACTIVATE_BUDGET=6
            MAX_ROUNDS=80
            log "开机窗口: 登录引导预算加倍 (轮${MAX_ROUNDS}/回车${RETURN_BUDGET}/激活${ACTIVATE_BUDGET})"
        fi
        SNAP_ON_TCC=1
        last_return_round=-9
        last_bid_log=""
        stale_rounds=0
        i=0
        while [ "$i" -lt "$MAX_ROUNDS" ]; do
            i=$((i+1))
            sleep 3
            if [ -z "$(wx_pid)" ]; then
                log "微信进程又消失, 放弃登录引导"
                break
            fi
            BID="$(frontmost_bundle)"
            # TCC 弹窗可能不抢前台(会话恢复场景实测), 进程在就按弹窗分支处理。
            # 但微信已前台时不要覆盖(2026-09-27 重启实测): 弹窗被点掉后 UNC 进程
            # 会僵尸残留数分钟, tcc_up 恒真 → 循环困死在弹窗分支, 站在登录窗的
            # 微信永远等不到回车。微信前台=弹窗已清(未清时微信无交互窗不会前台)。
            if tcc_up && [[ "$BID" != *UserNotificationCenter* ]] && [[ "$BID" != *xinWeChat* ]]; then
                BID="com.apple.UserNotificationCenter.detected"
            fi
            case "$BID" in
                *UserNotificationCenter*)
                    stale_rounds=0
                    if [ "$SNAP_ON_TCC" = "1" ]; then
                        SNAP_ON_TCC=0
                        snap >/dev/null 2>&1
                        log "检测到TCC授权弹窗(轮$i), 已截屏留证, 开始点允许"
                    fi
                    if [ "$ALLOW_BUDGET" -gt 0 ]; then
                        # 每次点击前现截现认: 第二个弹窗几何可能与第一个不同(加高
                        # 变体), OCR 每轮拿最新坐标。OCR 确认无弹窗(rc=2)不烧预算,
                        # 只累计 MISS 连击(满3杀僵尸UNC); 其余情况才算一次点击尝试
                        click_allow
                        rc=$?
                        if [ "$rc" = "0" ]; then
                            ALLOW_BUDGET=$((ALLOW_BUDGET-1))
                            note_ocr_miss 0
                            log "点允许完成 (轮$i, 余${ALLOW_BUDGET})"
                            sleep 2
                        elif [ "$rc" = "2" ]; then
                            note_ocr_miss 1
                        else
                            ALLOW_BUDGET=$((ALLOW_BUDGET-1))
                        fi
                    fi
                    ;;
                *xinWeChat*)
                    stale_rounds=0
                    if [ "$RETURN_BUDGET" -gt 0 ] && [ $((i - last_return_round)) -ge 3 ]; then
                        RETURN_BUDGET=$((RETURN_BUDGET-1))
                        last_return_round=$i
                        if [ "$CLICK_MODE" = "return" ]; then
                            if "$CLICCLICK" -r kp:return 2>>"$LOG"; then
                                log "已发回车(轮$i, 余${RETURN_BUDGET})"
                            else
                                log "clicclick 回车失败(辅助功能未授权?)"
                            fi
                        else
                            if "$CLICCLICK" -r "c:${CLICK_X},${CLICK_Y}" 2>>"$LOG"; then
                                log "已坐标点击 ${CLICK_X},${CLICK_Y} (轮$i, 余${RETURN_BUDGET})"
                            else
                                log "clicclick 点击失败(辅助功能未授权?)"
                            fi
                        fi
                    elif [ "$RETURN_BUDGET" -le 0 ]; then
                        log "回车预算用尽(轮$i), 登录引导结束"
                        break
                    fi
                    ;;
                *)
                    # 2026-09-22 演练实锤: 两个TCC弹窗点完后前台落到 Finder,
                    # 微信登录窗不自动抢前台 → 回车永远发不出 → 停登录窗躺尸。
                    # 对策: 非微信/非弹窗前台连续滞留 3 轮(~9s) 就激活微信
                    # (open -a 对已运行 app = 仅切前台, 不会重启), 预算 3 次
                    stale_rounds=$((stale_rounds+1))
                    if [ "$stale_rounds" -ge 3 ] && [ "$ACTIVATE_BUDGET" -gt 0 ]; then
                        ACTIVATE_BUDGET=$((ACTIVATE_BUDGET-1))
                        stale_rounds=0
                        if open -a "$WECHAT_APP" 2>>"$LOG"; then
                            log "前台滞留 ${BID:-未知}, 已激活微信到前台(轮$i, 余${ACTIVATE_BUDGET})"
                            sleep 2
                        fi
                    elif [ "$last_bid_log" != "$BID" ] && [ "$stale_rounds" = 1 ]; then
                        log "前台是 ${BID:-未知}, 等待弹窗/登录窗(轮$i)"
                    fi
                    last_bid_log="$BID"
                    ;;
            esac
        done
        [ "$i" -ge "$MAX_ROUNDS" ] && log "登录引导循环到上限(${MAX_ROUNDS}轮), 继续走链重启"
    else
        log "登录点击未启用, 等待人工登录"
    fi
    sleep 5   # 等登录落定
    restart_chain
    # 恢复告警: 文本立即发(链路已恢复, 必达); 截图延后补发
    # (onebot CdnManager 有登录稳定门禁: 脚本跑满60s或收到同步消息才解析, 过早发图必失败)
    if lsof -ti:58080 >/dev/null 2>&1; then
        if [ "$UPTIME" -lt 900 ]; then
            notify "🔄 开机自启动完成 (开机后${UPTIME}s, $DEAD_TS 发现微信未起, 已拉起+登录+链重启), 恢复截图稍后补发"
        else
            notify "✅ 微信死亡已自动恢复 (发现于 $DEAD_TS, 链路重启完成), 恢复截图稍后补发"
        fi
        sleep 50   # 过 CdnManager 门禁期(onebot 启动起算60s, restart 完成时已跑~10s)
        open -a "$WECHAT_APP" 2>/dev/null   # 截图前把微信切到前台, 否则拍到的可能只是空桌面
        sleep 2
        IMG="$(snap)"
        if notify_img "$IMG" "[看门狗] 恢复后屏幕状态"; then
            log "恢复告警文本+截图均已发送: $IMG"
        else
            log "恢复告警文本已发送, 截图补发失败已留档: $IMG"
        fi
    else
        log "链路未恢复, 本轮不发告警, 截图留档待下轮"
        snap >/dev/null
    fi
    exit 0
fi

# --- 2. 微信活着: 检测外部重启(PID 变化) ---
CURRENT_PID="$(wx_pid)"
if [ -f "$PID_FILE" ]; then
    LAST_PID="$(cat "$PID_FILE" 2>/dev/null)"
    if [ -n "$LAST_PID" ] && [ "$LAST_PID" != "$CURRENT_PID" ]; then
        log "微信进程变化 ${LAST_PID} -> ${CURRENT_PID} (外部重启), 需重启 bot 链"
        restart_chain
        notify "微信被外部重启(${LAST_PID}→${CURRENT_PID}), bot 链已跟随重启"
        exit 0
    fi
fi
echo "$CURRENT_PID" > "$PID_FILE"

# --- 2.5 开机窗口兜底(2026-09-27 重启实测后定稿): macOS 会话恢复可能在 t≈0 就把
# 微信拉起(早于开机缓冲门), TCC 弹窗/登录窗没人引导 → 微信卡死在登录前, 链路假活。
# 开机窗口(uptime<25min)内, 不依赖不可靠的登录态信号, 只按可观测状态动作:
#   UNC 进程在(弹窗在屏, 无论是否前台) → 点"允许"
#   前台是微信 → 回车(登录窗=登录, 主窗空输入=无害); 总预算10次防升级窗误触,
#               且更新检查已被 0 节源头禁用, 暴露窗口极低
#   前台是其他 → 激活微信到前台
# 全部 60s 限频(/tmp/wechat_watchdog.nudge, 开机自动清零)。
if [ "$UPTIME" -lt 1500 ]; then
    NOW_TS=$(date +%s)
    LAST_NUDGE=$(cat /tmp/wechat_watchdog.nudge 2>/dev/null || echo 0)
    if [ $((NOW_TS - LAST_NUDGE)) -ge 60 ]; then
        echo "$NOW_TS" > /tmp/wechat_watchdog.nudge
        if tcc_up; then
            if [ -n "$CLICCLICK" ]; then
                # OCR 现场定位(2026-09-28): 开机窗口主屏常是内置 Retina, 固定坐标
                # 失效的正是这个场景; rc=2 是 OCR 确认无弹窗(僵尸UNC), 记连击满3杀之
                click_allow
                rc=$?
                if [ "$rc" = "0" ]; then
                    note_ocr_miss 0
                    log "开机兜底: TCC弹窗在屏(进程探测), 已点允许"
                elif [ "$rc" = "2" ]; then
                    note_ocr_miss 1
                fi
            fi
        else
            BID2="$(frontmost_bundle)"
            case "$BID2" in
                *xinWeChat*)
                    RET_NUDGED=$(cat /tmp/wechat_watchdog.returns 2>/dev/null || echo 0)
                    if [ "$RET_NUDGED" -lt 10 ] && [ -n "$CLICCLICK" ]; then
                        echo $((RET_NUDGED+1)) > /tmp/wechat_watchdog.returns
                        "$CLICCLICK" -r kp:return 2>>"$LOG" \
                            && log "开机兜底: 微信前台, 发回车(第$((RET_NUDGED+1))/10)"
                    fi
                    ;;
                *)
                    open -a "$WECHAT_APP" 2>>"$LOG" \
                        && log "开机兜底: 前台是 ${BID2:-未知}, 激活微信到前台"
                    ;;
            esac
        fi
    fi
fi

# --- 3. onebot 端口检查 ---
if ! lsof -ti:58080 >/dev/null 2>&1; then
    log "onebot 58080 未监听"
    restart_chain
    if lsof -ti:58080 >/dev/null 2>&1; then
        notify "onebot 58080 未监听, bot 链已重启恢复"
    fi
    exit 0
fi
