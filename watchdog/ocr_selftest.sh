#!/bin/bash
# OCR 点允许链路自检(launchd 上下文跑): 只截屏 + OCR 定位, 不点击。
# 当前屏上没有 TCC 弹窗, 期望结果是 MISS —— 验证的是链路本身:
# clicclick 合成 ⌘⇧3 → find -newer 检出新文件(多屏多张) → ocr_allow.py 输出格式。
OUT=/tmp/ocr_selftest.out
{
echo "=== $(date '+%F %T') selftest 开始"
SHOTS_DIR="$HOME/Prog/wxgate/shots"
CLICCLICK="$(ls "$HOME"/Applications/*clic*.app/Contents/MacOS/* 2>/dev/null | head -1)"
OCR_PY="$HOME/Prog/mumble/.venv/bin/python"
OCR_ALLOW="$HOME/Prog/wxgate/ocr_allow.py"
echo "CLICCLICK=$CLICCLICK"
echo "OCR_PY=$OCR_PY  OCR_ALLOW=$OCR_ALLOW"
# 从已部署 watchdog 原文提取 snap_new —— 测的就是线上代码
eval "$(sed -n '/^snap_new()/,/^}/p' "$HOME/Prog/wxgate/wechat-watchdog.sh")"
t0=$(date +%s)
files=()
while IFS= read -r f; do [ -n "$f" ] && files+=("$f"); done < <(snap_new)
t1=$(date +%s)
echo "snap_new 用时 $((t1-t0))s, 收到 ${#files[@]} 张:"
printf '  %s\n' "${files[@]}"
if [ "${#files[@]}" -gt 0 ]; then
    t0=$(date +%s)
    "$OCR_PY" "$OCR_ALLOW" "${files[@]}"
    echo "ocr_allow 用时 $(( $(date +%s) - t0 ))s (当前无弹窗, 期望 MISS)"
else
    echo "!! snap_new 没收到任何新截图 — 链路有问题"
fi
echo "=== selftest 完成"
} > "$OUT" 2>&1
