// 探针 v45 — Hundun 被叫自动化: 来话自动接听 + 下行数字侧落盘
// 部署: mac-m1 (生产微信, 同版本 4.1.13.63, gadget 127.0.0.1:27042)
// 行为:
//   vt[7]  来话事件 → 记录 roomid → 1.5s 后 vt[10](svc,1,0,0x22) 自动接听
//   vt[14] 下行泵   → 每帧 640B 追加到 /tmp/hundun_rx_<ts>.pcm (纯数字接收流)
//   vt[12] 挂断     → 关闭 pcm 文件
// 注意: v1 无白名单, 来话全接(测试窗口内勿真呼)。
var CONF = Process.enumerateModules().filter(function (m) {
    return m.name.indexOf("ConfSDKdyn") !== -1 && m.size > 100 * 1024;
})[0];
if (!CONF) throw new Error("ConfSDKdyn not found");
var getter = CONF.enumerateExports().filter(function (e) { return e.name === "GetWXConfService"; })[0];
var svc = new NativeFunction(getter.address, "pointer", ["int"])(0x1352707);
var vt = svc.readPointer();

function hexs(b) { return Array.from(b).map(function (x) { return ("0" + x.toString(16)).slice(-2); }).join(""); }

var answerFn = new NativeFunction(vt.add(10 * 8).readPointer(), "int",
    ["pointer", "int", "int", "int"]);
var rxFile = null, rxBytes = 0, rxPath = null, callStartTs = 0;

function rxClose() {
    if (rxFile !== null) {
        try { rxFile.close(); } catch (e) {}
        send({ type: "rxClose", path: rxPath, bytes: rxBytes, secs: (Date.now() - callStartTs) / 1000, ts: Date.now() });
        rxFile = null; rxBytes = 0;
    }
}

// 来话 → 自动接听
Interceptor.attach(vt.add(7 * 8).readPointer(), {
    onEnter: function (args) {
        callStartTs = Date.now();
        var room = "";
        try { room = hexs(new Uint8Array(args[1].readByteArray(48))); } catch (e) {}
        send({ type: "incoming", room: room, ts: callStartTs });
        rxClose();
        rxPath = "/tmp/hundun_rx_" + callStartTs + ".pcm";
        try { rxFile = new File(rxPath, "wb"); } catch (e) { send({ type: "err", msg: "open rx: " + e }); rxFile = null; }
        setTimeout(function () {
            var r = null;
            try { r = answerFn(svc, 1, 0, 0x22); } catch (e) { r = "err:" + e; }
            send({ type: "answered", ret: String(r), ts: Date.now() });
        }, 1500);
    }
});

// 下行泵 → 延迟一行落盘: 缓冲异步填充(onEnter/onLeave 均为空), onEnter 时
// 读到的是上一次调用的数据, 通话期间即有效音频(1帧=20ms 延迟, 无碍分析)
var nonzero = 0, totalFrames = 0;
Interceptor.attach(vt.add(14 * 8).readPointer(), {
    onEnter: function (args) {
        if (rxFile === null) return;
        var n = args[2].toInt32();
        if (n <= 0 || n > 4096) return;
        try {
            var b = new Uint8Array(args[1].readByteArray(n));
            rxFile.write(b);
            rxBytes += n;
            totalFrames++;
            for (var i = 0; i < b.length; i++) if (b[i] !== 0) { nonzero++; break; }
            if (totalFrames % 50 === 0)
                send({ type: "rxStats", frames: totalFrames, nonZeroFrames: Math.round(nonzero/2), bytes: rxBytes, ts: Date.now() });
        } catch (e) {}
    }
});

// 挂断 → 收尾
Interceptor.attach(vt.add(12 * 8).readPointer(), {
    onEnter: function () { setTimeout(rxClose, 300); }
});

send({ type: "log", msg: "v45 callee ready svc=" + svc + " vt=" + vt, ts: Date.now() });
