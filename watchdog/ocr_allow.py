#!/usr/bin/env python3
"""TCC 弹窗「允许」按钮定位: 截图 -> OCR -> clicclick 可用的点击坐标(逻辑点)。

用法: ocr_allow.py <截图路径>...   (一次 ⌘⇧3 可能产多张, 多屏各一张, 全传进来)
stdout:  OK <x> <y> <命中文件名> <scale> <conf>   找到, 坐标已按 scale 折算成逻辑点
         MISS <原因>                             没找到, 调用方走固定坐标兜底
必须用 mumble venv 解释器运行(rapidocr/onnxruntime 装在那里), 见 wechat-watchdog.sh。

判定规则(2026-09-28 用 shots/ 88 张历史截图全量标定, 26 张含弹窗全部命中/零误报):
  - 文本恰为「允许」: 排除「不允许」(独立文本块)和正文里的部分匹配(如"允许控制将…")
  - conf >= 0.8(实测全部 1.00)
  - scale 只可能 1(dummy 1080p) 或 2(内置 Retina): 由 y/scale∈[280,480] 唯一确定。
    历史弹窗逻辑 y∈[334,411], 1x 候选与 2x 候选区间不重叠, 不会歧义;
    Retina 图 y≈711 → /2 才落进区间。
  - x 需在屏幕中线右侧 20~150pt(历史 58~88), 兜住误命中背景窗口里的「允许」。
"""
import logging
import os
import sys

logging.disable(logging.INFO)

import cv2
import numpy as np

MIN_CONF = 0.8
Y_MIN, Y_MAX = 280, 480
XOFF_MIN, XOFF_MAX = 20, 150


def find_allow(img_path, engine):
    """在一张截图里找「允许」按钮, 返回 (x逻辑, y逻辑, 文件名, scale, conf) 或 None。"""
    img = cv2.imdecode(np.fromfile(img_path, dtype=np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        return None
    h, w = img.shape[:2]
    res = engine(img)
    if res.boxes is None:
        return None
    best = None
    for box, txt, score in zip(res.boxes, res.txts, res.scores):
        t = str(txt).strip()
        if t != "允许" or float(score) < MIN_CONF:
            continue
        xs = [float(p[0]) for p in box]
        ys = [float(p[1]) for p in box]
        cx = (min(xs) + max(xs)) / 2
        cy = (min(ys) + max(ys)) / 2
        for s in (1, 2):
            y = cy / s
            if not (Y_MIN <= y <= Y_MAX):
                continue
            xoff = (cx - w / 2) / s
            if not (XOFF_MIN <= xoff <= XOFF_MAX):
                continue
            if best is None or float(score) > best[4]:
                best = (int(round(cx / s)), int(round(y)), os.path.basename(img_path),
                        s, float(score))
    return best


def main():
    if len(sys.argv) < 2:
        print("MISS no-input")
        return 0
    from rapidocr import RapidOCR
    engine = RapidOCR()
    for p in sys.argv[1:]:
        if not os.path.isfile(p):
            continue
        r = find_allow(p, engine)
        if r:
            print(f"OK {r[0]} {r[1]} {r[2]} {r[3]} {r[4]:.2f}")
            return 0
    print("MISS no-exact-hit")
    return 0


if __name__ == "__main__":
    sys.exit(main())
