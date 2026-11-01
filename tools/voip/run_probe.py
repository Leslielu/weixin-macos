#!/usr/bin/env python3
"""跑一个 voip 探针并实时落盘日志（每行立即 flush）。

用法: python3 run_probe.py <probe.js> <log 文件> [gadget 地址]
日志格式与 frida CLI 输出一致:  "HH:MM:SS.mmm {json}"
"""
import datetime
import json
import signal
import sys
import time

import frida

probe = sys.argv[1]
logfile = sys.argv[2]
addr = sys.argv[3] if len(sys.argv) > 3 else "127.0.0.1:27042"

dev = frida.get_device_manager().add_remote_device(addr)
session = dev.attach("Gadget")
script = session.create_script(open(probe).read())

out = open(logfile, "w", buffering=1)


def on_message(message, data):
    now = datetime.datetime.now()
    out.write(f"{now:%H:%M:%S}.{now.microsecond // 1000:03d} "
              f"{json.dumps(message, ensure_ascii=False)}\n")


script.on("message", on_message)
script.load()
print(f"LOADED {probe} -> {logfile}", flush=True)


def bye(*_):
    print("DETACH", flush=True)
    try:
        session.detach()
    finally:
        out.close()
        sys.exit(0)


signal.signal(signal.SIGTERM, bye)
signal.signal(signal.SIGINT, bye)
while True:
    time.sleep(0.5)
