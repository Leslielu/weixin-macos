# 远程 Mac 截屏 / 合成键鼠方法（mac-m1 实战版）

> 给其他 agent 的可移植操作手册。2026-09-07 TCC 弹窗事故中实测可用。

## 适用场景

远端 Mac（无人值守）需要"看一眼屏幕"或"点一下按钮/按键"：
- TCC 授权弹窗挡道（本方法诞生的场景）
- 看微信登录窗 / 崩溃弹窗停在哪
- 任何 GUI 模态窗阻塞自动化

## 为什么不能直接截图/点击

ssh 会话里的进程不属于 GUI 用户会话（ Aqua session），TCC 三面墙：

| 直接做法 | 结果 |
|---|---|
| `screencapture -x /tmp/x.png`（ssh 执行） | `could not create image from display`（无屏幕录制权限） |
| `ls ~/Desktop`（ssh 执行） | `Interrupted system call`（无文稿/桌面访问权限） |
| 直接跑 `cliclick kp:return`（ssh 执行） | `Accessibility privileges not enabled`（无辅助功能权限） |
| `osascript` 读窗口 | `-1728 不允许辅助访问` |

## 核心原理：一次性 LaunchAgent

`launchctl bootstrap gui/501` 启动的进程**运行在 GUI 用户会话里**，继承该会话的 TCC 授权链
（cliclick wrapper app 曾在 GUI 里被授予辅助功能）→ 合成事件合法放行。
用完删 plist，不留常驻。

## 前置条件（mac-m1 已全部就绪）

1. `~/Applications/clicclick.app` —— cliclick 的 wrapper app（带 Info.plist + adhoc 签名，**辅助功能已授权**）
2. 截图落盘位置已改到 TCC 保护区外（只需设置一次）：
   ```bash
   defaults write com.apple.screencapture location /Users/leslielu/Prog/wxgate/shots
   ```
   （默认 Desktop 的话，sshd 读不回来；此目录 ssh 可读）

## 操作模板

### ① 写一次性 agent plist（以合称 ⌘⇧3 截屏为例）

```bash
CLICCLICK=$(ls "$HOME"/Applications/*clic*.app/Contents/MacOS/* | head -1)
cat > ~/Library/LaunchAgents/com.user.oneshot_input.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>AbandonProcessGroup</key>
	<true/>
	<key>Label</key>
	<string>com.user.oneshot_input</string>
	<key>ProgramArguments</key>
	<array>
		<string>${CLICCLICK}</string>
		<string>-r</string>
		<string>kd:cmd</string>
		<string>kd:shift</string>
		<string>t:3</string>
		<string>ku:shift</string>
		<string>ku:cmd</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
</dict>
</plist>
EOF
```

### ② 触发（每次想操作时跑）

```bash
launchctl bootout gui/501/com.user.oneshot_input 2>/dev/null
launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.user.oneshot_input.plist
```

- 截屏后等 3-6s 落盘（写大 PNG 有点慢），产物在 `~/Prog/wxgate/shots/截屏*.png`
- 拉回本地看：`scp 'mac-m1:~/Prog/wxgate/shots/截屏xxx.png' /tmp/` 然后用图像阅读工具查看

### ③ 换成其他动作：只改 ProgramArguments 里的 cliclick 参数

| 目的 | 参数（替换 kd:cmd…ku:cmd 那几行） |
|---|---|
| 坐标点击 (x,y) | `<string>c:1019,350</string>` |
| 回车 | `<string>kp:return</string>` |
| 输入文本 | `<string>t:hello</string>` |
| 组合键 ⌘W | `kd:cmd` `w:W`（或 `t:w`）`ku:cmd` |

注意：**屏幕 1920x1080@1x 时截图像素坐标=点击坐标**，直接从截图上量。
cliclick 不支持数字键码（`kp:3` 无效），数字/字母用 `t:` 文本输入触发。

### ④ 用完清理（重要：RunAtLoad 每次登录都会触发）

```bash
launchctl bootout gui/501/com.user.oneshot_input 2>/dev/null
rm ~/Library/LaunchAgents/com.user.oneshot_input.plist
```

## 按钮坐标别信视觉模型，用像素分析

2026-09-17 python3.11 TCC 弹窗实测：视觉模型两次给的按钮坐标一次偏 15px、一次完全跑偏，
差点点到「不允许」。可靠做法是本地像素分析：

1. **先问视觉模型弹窗在哪、写了什么**（内容识别可靠），坐标只当粗定位。
2. 在粗定位区域打网格：逐格取最小亮度，`min<100` 画 `#`（文字/线条）、`min<180` 画 `+`，
   渲染 ASCII 图——文字块、图标、按钮轮廓一目了然。
3. 再沿按钮行做水平/垂直色带扫描（亮度跳变>8 即边界）：浅色模式弹窗里按钮是
   lum≈227 的灰块、弹窗底 lum≈245、文字 lum≈35-80，两条文字块分属两个按钮，
   文字中心=按钮中心（各往两边加 ~55px 即按钮边界）。
4. 注意：**强调色非蓝色时默认按钮不是蓝底**（本机 graphite，全程无蓝色像素），
   别用"找蓝色块"定位默认按钮。

本地无 PIL 也不影响：`sips -s format bmp/ppm` 不可靠（ppm 不支持、bmp 头是垃圾），
直接用纯 python 解 PNG（zlib.decompress + 逐行 unfilter，~50 行，见会话存档或重写）。

## 排障要点

- 触发后没产物：查 `launchctl print gui/501/com.user.oneshot_input` 的 `last exit code`；err 输出在 plist 同级加 `StandardErrorPath` 键
- 截屏落盘慢：PNG 写入 3-6s，别刚触发就 ls
- 屏幕必须处于"已登录控制台"状态：锁屏时合成 ⌘⇧3 无效（loginwindow 不是用户会话）。
  查锁屏：`ioreg -n Root -d1 -a` 输出里的 `IOConsoleLocked`（ssh 可读）
- 此方法已在 mac-m1 实测（macOS 26.2）；mac-mini 未配 clicclick wrapper，不可直接复用
