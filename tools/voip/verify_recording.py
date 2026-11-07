#!/usr/bin/env python3
"""VoIP 下行录音验收: 空洞结构(洞数/占空比) + 与源文件的内容相关性。

背景见 docs/VOIP-CALL-STATUS.md §17.9:
- 接听方播放时的"每 40ms 一个 ~19ms 洞"来自原生麦克风 20ms 数字静音帧与外部注入帧
  交替, 不是 M1 录音器伪影。mic_gate 打开后应为 0 洞 / 100% 占空比。
- **洞数只说明连续性, 不说明内容**: 录到别的信号(如噪声)同样是 0 洞。
  所以验收必须同时看占空比与源包络相关(≥0.7 才算内容正确)。

用法:
  python3 -I verify_recording.py rec.wav [--src test-assets/test-voice.wav]

输出示例(4.1.15.55 开发副本, mic_gate 开/关):
  rec=... dur=9.48s holes=0   total=0.00s duty=100.0%   env_corr=0.770 lag=0.40s
  rec=... dur=11.12s holes=271 total=4.54s duty=59.2%   env_corr=0.508

依赖: numpy(本机用 ~/.venvs/wechat-re/bin/python3 -I 跑)。
"""
import sys
import wave

import numpy as np


def load(path):
    w = wave.open(path, "rb")
    sr, ch = w.getframerate(), w.getnchannels()
    x = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768.0
    w.close()
    if ch > 1:
        x = x.reshape(-1, ch).mean(axis=1)
    return sr, x


def envelope(x, sr, hop_s):
    n = max(1, int(hop_s * sr))
    m = len(x) // n
    if m == 0:
        return np.zeros(1)
    return np.sqrt((x[: m * n].reshape(m, n) ** 2).mean(axis=1))


def holes(path):
    sr, x = load(path)
    dur = len(x) / sr
    # 1ms 分辨率包络, 阈值 = 峰值(取 >max-40dB 的 90 分位) - 20dB
    win = max(1, int(0.001 * sr))
    m = len(x) // win
    env = np.sqrt((x[: m * win].reshape(m, win) ** 2).mean(axis=1))
    db = 20 * np.log10(np.maximum(env, 1e-7))
    peak = np.percentile(db[db > db.max() - 40], 90)
    thr = peak - 20
    quiet = db < thr
    runs, i = [], 0
    while i < len(quiet):
        if quiet[i]:
            j = i
            while j < len(quiet) and quiet[j]:
                j += 1
            runs.append((i * win / sr, (j - i) * win / sr))
            i = j
        else:
            i += 1
    # 去掉头部(未开播)与尾部(挂断), 只统计 ≥2ms 的洞
    runs = [r for r in runs if 0.3 < r[0] < dur - 0.5 and r[1] >= 0.002]
    total = sum(r[1] for r in runs)
    duty = 100 * (1 - total / dur) if dur > 0 else 0.0
    return sr, dur, runs, total, duty


def env_corr(src_path, rec_path):
    s_sr, s = load(src_path)
    r_sr, r = load(rec_path)
    es = envelope(s, s_sr, 0.02)
    er = envelope(r, r_sr, 0.02)
    es = (es - es.mean()) / (es.std() + 1e-9)
    er = (er - er.mean()) / (er.std() + 1e-9)
    best_c, best_lag = -2.0, 0
    for lag in range(-len(es) + 8, len(er) - 8):
        a0 = max(0, lag)
        a1 = min(len(es), len(er) + lag)
        if a1 - a0 < 20:
            continue
        seg = er[a0 - lag: a1 - lag]
        c = float(np.dot(es[a0:a1], seg) / (a1 - a0))
        if c > best_c:
            best_c, best_lag = c, lag
    return best_c, best_lag * 0.02


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    rec = sys.argv[1]
    src = None
    if "--src" in sys.argv:
        src = sys.argv[sys.argv.index("--src") + 1]
    sr, dur, runs, total, duty = holes(rec)
    line = f"rec={rec} sr={sr} dur={dur:.2f}s holes={len(runs)} total={total:.2f}s duty={duty:.1f}%"
    if runs:
        lens = np.array([r[1] * 1000 for r in runs])
        gaps = np.diff([r[0] * 1000 for r in runs])
        line += (f" | hole_len p50={np.percentile(lens, 50):.1f}ms"
                 f" | spacing p50={np.percentile(gaps, 50):.0f}ms" if len(gaps) else "")
    if src:
        c, lag = env_corr(src, rec)
        line += f" | env_corr={c:.3f} lag={lag:.2f}s"
    print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
