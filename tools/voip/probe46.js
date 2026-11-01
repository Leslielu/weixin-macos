// 探针 v46 — 下行 PCM 出口堵截: CoreAudio 层(系统框架, 不在 PAC 禁区)
//
// 依据:
//   - ConfSDKdyn 不链音频框架 → 解码/播放全在 wechat.dylib 的 CoreAudio 栈
//   - probe45 教训: mv 引擎对象每通电话新建, 槽位钩子挂旧对象 = 零覆盖
//   - 用户实证: 通话中本机喇叭不出声 → render 是否有数据本身就是定位信息
//
// 堵两层:
//   1. AudioUnitRender(unit, flags*, ts*, bus, frames, ioData*) onLeave 读 ioData
//   2. AudioDeviceCreateIOProcID/AddIOProcID 注册钩: 抓到 IOProc 回调地址就地 attach,
//      IOProc(unit, now*, inData*, inTime*, outData*, outTime*, client*) 的 x4=outData
//
// 落盘: /tmp/voip46_au.pcm (AudioUnitRender) / /tmp/voip46_ioproc.pcm (IOProc)
//       原始 buffer 字节, 格式未知(可能 float32/48k/2ch), 事后 ffprobe/听
// 触发: /tmp/voip_uidial.req 拨号  /tmp/voip_hangup.req 挂断
var REAL_MOD = Process.enumerateModules().filter(function (m) {
    return /wechat\.dylib/i.test(m.name) && m.size > 100 * 1024 * 1024;
})[0];
if (!REAL_MOD) throw new Error("wechat.dylib real image not found");
var BASE = REAL_MOD.base;
var CLIENT = BASE.add("0x9b93ab8");
var KEEP = [];

function log(s, extra) {
    var m = { type: "log", msg: s, ts: Date.now() };
    if (extra) for (var k in extra) m[k] = extra[k];
    send(m);
}
function readText(p) {
    try { var f = new File(p, "r"); var t = f.readText(); f.close(); return t; } catch (e) { return null; }
}
function buildVec(wxid) {
    var sb = Memory.alloc(24);
    KEEP.push(sb);
    var bytes = new Array(24);
    for (var i = 0; i < 24; i++) bytes[i] = 0;
    if (wxid.length <= 22) {
        for (i = 0; i < wxid.length; i++) bytes[i] = wxid.charCodeAt(i) & 0xff;
        bytes[0x17] = wxid.length;
    } else {
        var data = Memory.allocUtf8String(wxid);
        KEEP.push(data);
        sb.writePointer(data);
        sb.add(8).writeU64(wxid.length);
        sb.add(0x17).writeU8(0x80);
        var vecLong = Memory.alloc(24);
        KEEP.push(vecLong);
        vecLong.writePointer(sb);
        vecLong.add(8).writePointer(sb.add(24));
        vecLong.add(16).writePointer(sb.add(24));
        return vecLong;
    }
    sb.writeByteArray(bytes);
    var vec = Memory.alloc(24);
    KEEP.push(vec);
    vec.writePointer(sb);
    vec.add(8).writePointer(sb.add(24));
    vec.add(16).writePointer(sb.add(24));
    return vec;
}
var CONF = Process.enumerateModules().filter(function (m) {
    return m.name.indexOf("ConfSDKdyn") !== -1 && m.size > 100 * 1024;
})[0];
var getter = CONF.enumerateExports().filter(function (e) {
    return e.name === "GetWXConfService";
})[0];
var svc = new NativeFunction(getter.address, "pointer", ["int"])(0x1352707);
var dialFn = new NativeFunction(BASE.add("0x1fc07f4"), "int",
    ["pointer", "pointer", "pointer", "pointer", "int", "pointer"]);
var hangupFn = new NativeFunction(svc.readPointer().add(12 * 8).readPointer(), "int",
    ["pointer", "int", "int"]);

function ceAddr() { try { return svc.add(8).readPointer().add(0xa10); } catch (e) { return ptr(0); } }
function flags() {
    try {
        var c = ceAddr();
        return { startTalk: c.add(0x2c).readU32(), extStreams: c.add(0x7f4).readU32() };
    } catch (e) { return { error: String(e) }; }
}

// ---------- AudioBufferList 读出 ----------
function readABL(abl, maxTotal) {
    // AudioBufferList: u32 nBufs; [pad4] AudioBuffer{ u32 ch; u32 size; ptr data } ×n
    try {
        var n = abl.readU32();
        if (n < 1 || n > 8) return { n: n };
        var bufs = [];
        var total = 0;
        for (var i = 0; i < n; i++) {
            var b = abl.add(8 + i * 16);
            var ch = b.readU32(), size = b.add(4).readU32(), data = b.add(8).readPointer();
            if (size > maxTotal) return { n: n, oversize: size };
            bufs.push({ ch: ch, size: size, data: data });
            total += size;
        }
        return { n: n, bufs: bufs, total: total };
    } catch (e) { return { err: String(e) }; }
}

var auFile = null, ioprocFile = null;
var auBytes = 0, ioprocBytes = 0;
var auN = 0, ioprocN = 0;
var auDumps = {}, ioprocDumps = {};   // 按 "ch/size" 分桶计数, 只落前若干桶
var DUMP_LIMIT = 12 * 1024 * 1024;    // 每文件上限

function dumpABL(file, info, tag) {
    for (var i = 0; i < info.bufs.length; i++) {
        var b = info.bufs[i];
        if (b.size === 0 || b.data.isNull()) continue;
        var key = tag + "/" + b.ch + "ch/" + b.size;
        var cnt = (auDumps[key] || 0) + 1;
        auDumps[key] = cnt;
        if (file === auFile && cnt <= 400000 && auBytes < DUMP_LIMIT) {
            try { file.write(b.data.readByteArray(b.size)); auBytes += b.size; } catch (e) { }
        }
    }
}

// ---------- 1) AudioUnitRender ----------
// frida 17 移除了静态 Module.findExportByName, 用枚举式取址
function exportOf(fw, name) {
    var m = Process.enumerateModules().filter(function (x) {
        return x.name.toLowerCase().indexOf(fw) !== -1;
    })[0];
    if (!m) return null;
    var e = m.enumerateExports().filter(function (x) { return x.name === name; })[0];
    return e ? e.address : null;
}
var aur = exportOf("audiotoolbox", "AudioUnitRender");
if (aur) {
    Interceptor.attach(aur, {
        onEnter: function (args) {
            this.frames = args[4].toInt32();
            this.abl = args[5];
            this.bus = args[3].toInt32();
        },
        onLeave: function (retval) {
            var r = retval.toInt32();
            if (r !== 0 || this.frames <= 0) return;
            var info = readABL(this.abl, 65536);
            if (!info.bufs) return;
            auN++;
            var nz = -1;
            try {
                var b0 = info.bufs[0];
                var head = new Uint8Array(b0.data.readByteArray(Math.min(b0.size, 64)));
                nz = 0;
                for (var i = 0; i < head.length; i++) if (head[i] !== 0) nz++;
            } catch (e) { nz = -2; }
            if (auN <= 10 || auN % 500 === 0) {
                send({ type: "auRender", n: auN, bus: this.bus, frames: this.frames,
                       info: info, headNz: nz, ret: r, ts: Date.now() });
            }
            if (!auFile) { try { auFile = new File("/tmp/voip46_au.pcm", "wb"); } catch (e) { return; } }
            dumpABL(auFile, info, "au" + this.bus);
        }
    });
    log("AudioUnitRender hooked @ " + aur);
} else log("AudioUnitRender 找不到!");

// ---------- 2) IOProc 注册钩 ----------
function hookIOProc(fnAddr, name) {
    Interceptor.attach(fnAddr, {
        onEnter: function (args) {
            // CreateIOProcID(dev, proc, clientData, dispatcher*) proc=x1
            // AddIOProc(dev, proc, clientData) proc=x1
            var proc = args[1];
            if (proc.isNull()) return;
            send({ type: "ioProcReg", name: name, proc: String(proc), ts: Date.now() });
            if (this.__armed) return;
            this.__armed = true;
            try {
                Interceptor.attach(proc, {
                    onEnter: function (a) { this.out = a[4]; },
                    onLeave: function () {
                        var info = readABL(this.out, 65536);
                        if (!info.bufs) return;
                        ioprocN++;
                        if (ioprocN <= 10 || ioprocN % 500 === 0) {
                            send({ type: "ioProc", n: ioprocN, info: info, ts: Date.now() });
                        }
                        if (!ioprocFile) {
                            try { ioprocFile = new File("/tmp/voip46_ioproc.pcm", "wb"); }
                            catch (e) { return; }
                        }
                        for (var i = 0; i < info.bufs.length; i++) {
                            var b = info.bufs[i];
                            if (b.size === 0 || b.data.isNull()) continue;
                            if (ioprocBytes < DUMP_LIMIT) {
                                try { ioprocFile.write(b.data.readByteArray(b.size)); ioprocBytes += b.size; } catch (e) { }
                            }
                        }
                    }
                });
                log("IOProc 回调已挂: " + proc);
            } catch (e) { log("IOProc 挂载失败: " + e); }
        }
    });
}
["AudioDeviceCreateIOProcID", "AudioDeviceCreateIOProcIDWithBlock",
 "AudioDeviceAddIOProc"].forEach(function (n) {
    var a = exportOf("coreaudio", n);
    if (a) { try { hookIOProc(a, n); log(n + " reg-hooked @ " + a); } catch (e) { log(n + " hook失败 " + e); } }
    else log(n + " 未找到(跳过)");
});

log("=== v46 就绪(AU + IOProc 双路) ===", { flags: flags() });

var lastFlags = "";
setInterval(function () {
    var f = flags();
    var key = JSON.stringify(f);
    if (key !== lastFlags) {
        lastFlags = key;
        send({ type: "flagsChanged", flags: f, ts: Date.now() });
    }
    var tag = readText("/tmp/voip_uidial.req");
    if (tag && (tag = tag.trim()) && tag !== lastDial) {
        lastDial = tag;
        var target = (readText("/tmp/voip_target.txt") || "").trim();
        if (!target) { send({ type: "skip", reason: "no target" }); return; }
        var init = CLIENT.add(0x28).readU8();
        if (init !== 1) { send({ type: "skip", reason: "client not initialized", init: init }); return; }
        var cstr = Memory.allocUtf8String(target); KEEP.push(cstr);
        var vec = buildVec(target);
        var ret = null, err = null;
        try { ret = dialFn(CLIENT, cstr, vec, ptr(1), 0, ptr("0x2e6981b3")); }
        catch (e) { err = String(e); }
        send({ type: "dial", wxid: target, ret: ret, err: err, ts: Date.now() });
    }
    var h = readText("/tmp/voip_hangup.req");
    if (h && (h = h.trim()) && h !== lastHang) {
        lastHang = h;
        if (auFile) { try { auFile.close(); } catch (e) { } auFile = null; }
        if (ioprocFile) { try { ioprocFile.close(); } catch (e) { } ioprocFile = null; }
        var hr = null, he = null;
        try { hr = hangupFn(svc, 1, 0); } catch (e) { he = String(e); }
        send({ type: "hangup", ret: hr, err: he, ts: Date.now() });
    }
}, 1000);
var lastDial = "", lastHang = "";
