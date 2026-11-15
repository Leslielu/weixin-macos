#!/usr/bin/env python3
"""voip stream 联调客户端(设计: docs/VOIP-STREAMING-DESIGN.md §16)

无 ASR/LLM/TTS 依赖。持续接收 audio.input 并校验 seq/sample_offset/gap,
按队列水位限速发送 20ms 测试音, 支持 commit/clear/挂断。

用法:
  export VOICE_STREAM_TOKEN=<token>
  python3 stream_client.py --url http://127.0.0.1:58080 --user-id wxid_xxx --start
  python3 stream_client.py --url http://127.0.0.1:36060 --user-id wxid_xxx --start   # 走 wxgate 代理, 路径自动加 /api

安全约定:
  - 不带 --start 绝不拨号; 必须显式指定 --user-id, 无默认值
  - token 从环境变量读取, 不进 shell 历史
  - 默认不保存远端音频; --record 才落盘(注意: 这是敏感的通话音频)
  - 日志不打印 base64/token
依赖: pip3 install websockets
"""

import argparse
import asyncio
import base64
import json
import math
import os
import struct
import sys
import time

try:
    import websockets
except ImportError:
    sys.exit("缺少依赖: pip3 install websockets")

import urllib.request
import urllib.error


def http_json(method, url, body=None, token="", headers=None):
    req = urllib.request.Request(url, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(req, data=data, timeout=15) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, {}


def make_tone_pcm(ms, rate, freq=440.0, amp=8000):
    """20ms 正弦测试音(s16le mono); 幅度刻意压低, 避免吵到对端"""
    n = int(rate * ms / 1000)
    return struct.pack("<%dh" % n,
                       *[int(amp * math.sin(2 * math.pi * freq * i / rate))
                         for i in range(n)])


class Client:
    def __init__(self, args):
        self.args = args
        base = args.url.rstrip("/")
        self.api = base + "/api" if base.endswith(":36060") else base
        self.token = os.environ.get("VOICE_STREAM_TOKEN", "")
        self.call_id = None
        self.in_seq_last = -1
        self.in_off_last = -1
        self.in_frames = 0
        self.gap_frames = 0
        self.record_file = None
        self.record_bytes = 0

    def log(self, *a):
        msg = (a[0] % a[1:]) if (len(a) > 1 and "%" in str(a[0])) else " ".join(map(str, a))
        print(time.strftime("[%H:%M:%S]"), msg, flush=True)

    def create(self):
        body = {
            "user_id": self.args.user_id,
            "source": "stream-client",
            "mode": "stream",
            "ring_timeout_s": self.args.ring_timeout,
            "max_duration_s": self.args.max_duration,
            "input_format": {"codec": "pcm_s16le",
                             "sample_rate": self.args.rate, "channels": 1},
            "output_format": {"codec": "pcm_s16le",
                              "sample_rate": self.args.out_rate, "channels": 1},
        }
        code, resp = http_json("POST", self.api + "/voice_calls", body,
                               self.token, {"Idempotency-Key": self.args.idem_key or ""})
        if code != 201:
            self.log("创建失败", code, json.dumps(resp, ensure_ascii=False))
            sys.exit(1)
        d = resp["data"]
        self.call_id = d["call_id"]
        self.log("已预留 call_id=%s state=%s attach_deadline_ms=%s",
                 self.call_id, d["state"], d.get("attach_deadline_ms"))
        ws_path = d["stream_path"]
        if self.api.endswith("/api") and ws_path.startswith("/voice_calls"):
            ws_path = "/api" + ws_path
        return ws_path

    async def run(self):
        if not self.args.start:
            ws_path = self.create()
            self.log("未带 --start, 不拨号。stream_path:", ws_path,
                     "(10s 后预留自动释放)")
            return

        ws_path = self.create()
        ws_url = self.args.url.rstrip("/").replace("http", "ws", 1) + ws_path
        hdrs = {}
        if self.token:
            hdrs["Authorization"] = "Bearer " + self.token
        async with websockets.connect(ws_url, additional_headers=hdrs,
                                      max_size=1 << 20, open_timeout=10) as ws:
            hello = json.loads(await ws.recv())
            self.log("hello: ver=%s state=%s in=%s out=%s clear=%s",
                     hello.get("protocol_version"), hello.get("state"),
                     hello.get("input_format"), hello.get("output_format"),
                     hello.get("clear"))
            await ws.send(json.dumps({"type": "call.start",
                                      "request_id": "c-start"}))
            await self.pump(ws)

    async def pump(self, ws):
        tone = make_tone_pcm(20, self.args.rate)
        b64 = base64.b64encode(tone).decode()
        self.send_seq = 0        # ack 驱动: 仅在 accepted(seq) 后前进
        self.expect_seq = None   # invalid_seq 时按 expected_seq 重同步
        gen = 1
        seg = 0
        seg_open = False
        send_task = None
        start_ts = None

        async def sender():
            nonlocal gen, seg, seg_open
            # 队列目标 ~150ms: 20ms/块; seq 由 accepted 驱动(buffer_full/在途确认
            # 都不前进, 同 seq 自动重试 — 与服务端在途窗口语义配合)
            # --audio 模式: 流式播文件, 播完 commit 本段, 停顿 --gap 秒后从头再播
            audio = None
            audio_pos = 0
            gap_until = 0.0
            if self.args.audio:
                audio = open(self.args.audio, "rb").read()
                self.log("TTS 载荷 %d 字节 (%.1fs @%dHz), 停顿 %ds/遍",
                         len(audio), len(audio)/2/(self.args.rate),
                         self.args.rate, self.args.gap)
            chunk = 640  # 20ms @16k mono s16le
            while True:
                await asyncio.sleep(0.02)
                if self.queued_ms > 400:
                    continue
                seq = self.send_seq
                if self.expect_seq is not None and seq != self.expect_seq:
                    self.log("按 expected_seq 重同步 %d→%d", seq, self.expect_seq)
                    self.send_seq = seq = self.expect_seq
                    self.expect_seq = None
                if audio is not None:
                    now = time.monotonic()
                    if now < gap_until:
                        continue  # 停顿期不喂帧
                    if audio_pos >= len(audio):
                        await ws.send(json.dumps({
                            "type": "audio.commit", "request_id": "c-%d" % seg,
                            "generation": gen, "segment_id": "seg-%d" % seg,
                            "last_seq": seq - 1}))
                        self.log("已 commit seg-%d, 停顿 %ds", seg, self.args.gap)
                        seg_open = False
                        gap_until = now + self.args.gap
                        audio_pos = 0
                        continue
                    if not seg_open:
                        seg += 1
                        seg_open = True
                        self.log("开始播报 segment #%d (seq=%d)", seg, seq)
                    take = min(chunk, len(audio) - audio_pos)
                    payload = base64.b64encode(
                        audio[audio_pos:audio_pos + take]).decode()
                    audio_pos += take
                else:
                    if not seg_open:
                        seg += 1
                        seg_open = True
                        self.log("开始 segment #%d (seq=%d)", seg, seq)
                    payload = b64
                msg = {"type": "audio.append", "request_id": "a-%d" % seq,
                       "generation": gen, "segment_id": "seg-%d" % seg,
                       "seq": seq, "audio_b64": payload}
                await ws.send(json.dumps(msg))

        async def recv_loop():
            async for raw in ws:
                ev = json.loads(raw)
                t = ev.get("type")
                if t == "call.state":
                    self.log("state=%s detection=%s engine=%s",
                             ev.get("state"), ev.get("answer_detection"),
                             json.dumps(ev.get("engine_format")))
                    if ev.get("state") == "connected" and conn_evt is not None:
                        conn_evt.set()
                elif t == "audio.accepted":
                    self.queued_ms = ev.get("queued_ms", 0)
                    acc = int(ev.get("seq", -1))
                    if acc >= self.send_seq:
                        self.send_seq = acc + 1
                elif t == "audio.progress":
                    if self.args.verbose:
                        self.log("progress gen=%s seg=%s consumed=%s "
                                 "native=%s queued=%sms scope=%s",
                                 ev.get("generation"), ev.get("segment_id"),
                                 ev.get("consumed_samples"),
                                 ev.get("submitted_native_samples"),
                                 ev.get("queued_ms"), ev.get("scope"))
                elif t == "audio.input":
                    seq_n = ev["seq"]
                    off = ev["sample_offset"]
                    n = ev.get("samples", 0)
                    gap = ev.get("gap") or {}
                    self.in_frames += 1
                    if self.in_seq_last >= 0 and seq_n != self.in_seq_last + 1:
                        self.log("⚠️ input seq 跳号 %d→%d",
                                 self.in_seq_last, seq_n)
                    # 重采样器首帧有滤波器预热(略少于标称样本数), 从第2帧起校验连续
                    if self.in_off_last is not None and \
                            self.prev_samples and \
                            off != self.in_off_last + self.prev_samples:
                        self.log("⚠️ sample_offset 不连续 %d+%d≠%d",
                                 self.in_off_last, self.prev_samples, off)
                    self.prev_samples = n
                    self.in_seq_last = seq_n
                    self.in_off_last = off
                    self.gap_frames = max(self.gap_frames,
                                          gap.get("frames", 0))
                    if self.args.record:
                        if self.record_file is None:
                            path = "/tmp/stream_client_%d.pcm" % int(time.time())
                            self.record_file = open(path, "wb")
                            self.log("录音 → %s (敏感音频, 注意保管)", path)
                        raw_b = base64.b64decode(ev["audio_b64"])
                        self.record_file.write(raw_b)
                        self.record_bytes += len(raw_b)
                elif t == "audio.segment_done":
                    self.log("segment_done seg=%s consumed=%s scope=%s",
                             ev.get("segment_id"), ev.get("consumed_samples"),
                             ev.get("scope"))
                elif t == "audio.cleared":
                    self.log("cleared old=%s new=%s dropped=%s",
                             ev.get("old_generation"), ev.get("new_generation"),
                             ev.get("dropped_samples"))
                elif t == "error":
                    ee = ev.get("error", {})
                    code = ee.get("code")
                    if code == "invalid_seq" and \
                            ee.get("expected_seq") is not None:
                        self.expect_seq = int(ee["expected_seq"])
                    self.log("error code=%s retryable=%s req=%s expected=%s",
                             code, ee.get("retryable"), ev.get("request_id"),
                             ee.get("expected_seq"))
                elif t == "call.ended":
                    self.log("ended reason=%s stats=%s",
                             ev.get("reason"),
                             json.dumps(ev.get("stats"), ensure_ascii=False))
                    self.stop_evt.set()
                    return
                elif t == "hello":
                    pass
                else:
                    self.log("事件:", t)

        self.queued_ms = 0
        self.in_off_last = None
        self.prev_samples = 0
        conn_evt = asyncio.Event()
        self.stop_evt = asyncio.Event()
        recv_task = asyncio.ensure_future(recv_loop())
        try:
            # 等接通(ring 超时兜底)
            try:
                await asyncio.wait_for(conn_evt.wait(),
                                       timeout=self.args.ring_timeout + 15)
            except asyncio.TimeoutError:
                self.log("等接通超时, 放弃")
                return
            self.log("已接通, 双向流 %ds (测试音 %dHz)",
                     self.args.hold, self.args.tone_freq)
            start_ts = time.monotonic()
            send_task = asyncio.ensure_future(sender())
            deadline = start_ts + self.args.hold
            clear_at = start_ts + self.args.clear_after \
                if self.args.clear_after else None
            while not self.stop_evt.is_set():
                now = time.monotonic()
                if clear_at and now >= clear_at and gen == 1:
                    gen += 1
                    clear_at = None
                    await ws.send(json.dumps({"type": "audio.clear",
                                              "request_id": "clear-1",
                                              "generation": gen}))
                    self.log("已发 clear → gen %d", gen)
                    seg_open = False
                    self.send_seq = 0       # 新代序号从 0 重启
                    self.expect_seq = None
                if now >= deadline:
                    seg_id = "seg-%d" % seg
                    await ws.send(json.dumps({"type": "audio.commit",
                                              "request_id": "commit-1",
                                              "generation": gen,
                                              "segment_id": seg_id,
                                              "last_seq": self.send_seq - 1}))
                    self.log("已发 commit(%s last_seq=%d)", seg_id,
                             self.send_seq - 1)
                    await asyncio.sleep(0.3)
                    await ws.send(json.dumps({"type": "call.hangup",
                                              "request_id": "bye"}))
                    self.log("已发 hangup")
                    break
                await asyncio.sleep(0.1)
            # 等 call.ended(远端挂断等场景 recv 已收)
            try:
                await asyncio.wait_for(self.stop_evt.wait(), timeout=15)
            except asyncio.TimeoutError:
                self.log("未收到 call.ended(超时)")
        finally:
            for task in (recv_task, send_task):
                if task:
                    task.cancel()
            if self.record_file:
                self.record_file.close()
                self.log("录音 %d 字节已保存", self.record_bytes)
            self.log("输入帧=%d gap_frames=%d", self.in_frames, self.gap_frames)


def main():
    ap = argparse.ArgumentParser(description="voip stream 联调客户端")
    ap.add_argument("--url", required=True, help="onebot 或 wxgate 基址")
    ap.add_argument("--user-id", required=True, help="被叫 wxid(必填, 无默认)")
    ap.add_argument("--start", action="store_true",
                    help="显式拨号; 不带则只创建预留, 10s 自动释放")
    ap.add_argument("--hold", type=int, default=15, help="接通后保持秒数")
    ap.add_argument("--rate", type=int, default=16000, help="上行采样率")
    ap.add_argument("--out-rate", type=int, default=24000, help="下行采样率")
    ap.add_argument("--tone-freq", type=float, default=440.0, help="测试音频率")
    ap.add_argument("--ring-timeout", type=int, default=60)
    ap.add_argument("--max-duration", type=int, default=300)
    ap.add_argument("--clear-after", type=float, default=0,
                    help="接通 N 秒后发一次 clear(打断演练)")
    ap.add_argument("--audio", default="", help="s16le mono 原始 PCM 文件, 流式播放")
    ap.add_argument("--gap", type=int, default=5,
                    help="--audio 播完后的停顿秒数, 之后从头重播(0=只播一遍)")
    ap.add_argument("--record", action="store_true",
                    help="保存远端音频到 /tmp(敏感!)")
    ap.add_argument("--idem-key", default="", help="Idempotency-Key")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()
    asyncio.run(Client(args).run())


if __name__ == "__main__":
    main()
