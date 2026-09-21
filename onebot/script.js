var targetPath = "/Applications/WeChat.app/Contents/MacOS/WeChat";
var module = Process.enumerateModules().find(function(m) {
    return m.path === targetPath || m.name === "WeChat";
});
if (!module) {
    throw new Error("[-] Cannot find module: " + targetPath);
}
var moduleBase = module.base;
console.log("[+] WeChat module base: " + moduleBase);

// 基址解析(2026-09-20 E类事故修正): 模块表优先。真身 wechat.dylib 是全进程唯一
// >50MB 的同名模块(Frameworks/下是16KB stub), 基址确定无竞态。
// 原 "req2buf字符串+>100MB range" 扫描存在竞态误命中: 堆里 MallocHelperZone
// (合并range>100MB, rw-) 也有 "req2buf" 字符串拷贝, 扫描回调先到就赢 →
// 基址定到堆上, 全部 hook 挂空, 登录后零事件(静默死亡, 无报错)。
var searchSize = 1000 * 1024 * 1024;
var searchEnd = moduleBase.add(searchSize);
var _req2bufSearchAddr = null;
var baseAddr = null;

// 结构版本开关: 4.1.12 起上传完成结构 +0x08、下载任务结构 +0x18、寄存器漂移。
// JSON 里 "structVer": "2" = 4.1.12 布局; 旧版 JSON 无此键(渲染为 <no value>),
// 不等于 "2", 自动走 4.1.11 及以前的原路径。
var structVer = "{{.structVer}}";

function resolveBaseFromModuleTable() {
    var wechatModules = Process.enumerateModules().filter(function(m) {
        return m.name === "wechat.dylib";
    });
    wechatModules.sort(function(a, b) { return b.size - a.size; });
    if (wechatModules.length > 0 && wechatModules[0].size > 50 * 1024 * 1024) {
        return wechatModules[0];
    }
    return null;
}

// 必须 setImmediate 派发: initAddresses 内部依赖脚本中部 var 全局的初始化
// (fakeVtable 等)。同步调用会抢在 var 初始化前执行, var 随后又把已赋值的
// 全局重置回 ptr(0) —— 2026-09-20 D类 文本发送崩溃(fakeVtable=0 虚调用)即此因。
setImmediate(function () {
    var realModule = resolveBaseFromModuleTable();
    if (realModule) {
        baseAddr = realModule.base;
        console.log("[+] 基址解析(模块表): " + realModule.path + " base=" + baseAddr + " size=" + realModule.size);
        initAddresses();
    } else {
        console.log("[!] 模块表未找到真身 wechat.dylib, 回退 req2buf 字符串扫描");
        resolveBaseByScan();
    }
});

function resolveBaseByScan() {
var ranges = Process.enumerateRanges("r--").filter(function(r) {
    var rangeEnd = r.base.add(r.size);
    return r.base.compare(searchEnd) < 0 && rangeEnd.compare(moduleBase) > 0;
});

console.log("[+] Found " + ranges.length + " readable ranges within 1000MB window");

var pending = ranges.length;
if (pending === 0) {
    throw new Error("[-] No readable ranges found within 1000MB from module base");
}

ranges.forEach(function(r) {
    Memory.scan(r.base, r.size, "72 65 71 32 62 75 66", {
        onMatch: function(address, size) {
            if (_req2bufSearchAddr === null) {
                var rangeInfo = Process.findRangeByAddress(address);
                if (rangeInfo) {
                    // 必须是可执行映射: 排除堆区(MallocHelperZone等)里的字符串拷贝
                    if (rangeInfo.size > 100 * 1024 * 1024 && rangeInfo.protection.indexOf("x") !== -1) {
                        _req2bufSearchAddr = address;
                        console.log("[+] Range size > 100MB & executable, accepted as base address");
                    }
                }
            }
        },
        onError: function(reason) {
            // skip unreadable sub-pages
        },
        onComplete: function() {
            pending--;
            if (pending === 0) {
                if (_req2bufSearchAddr === null) {
                    throw new Error("[-] Cannot find 'req2buf' keyword in an executable range > 100MB");
                }

                var foundRange = Process.findRangeByAddress(_req2bufSearchAddr);
                baseAddr = foundRange.base;
                console.log("[+] Base address from range: " + baseAddr);
                console.log("[+] Range size: " + foundRange.size);

                initAddresses();
            }
        }
    });
});
}

function initAddresses() {
    // 文本消息全局变量 (new_text.js approach)
    blrX8Addr = baseAddr.add({{.blrX8Addr}});
    autoBufferWriteFunc = baseAddr.add({{.autoBufferWriteFunc}});

    // 双方公共使用的地址
    req2bufEnterAddr = baseAddr.add({{.req2bufEnterAddr}});
    req2bufExitAddr = baseAddr.add({{.req2bufExitAddr}});
    sendFuncAddr = baseAddr.add({{.sendFuncAddr}});
    buf2RespAddr = baseAddr.add({{.buf2RespAddr}});

    uploadImageAddr = baseAddr.add({{.uploadImageAddr}});
    cndOnCompleteAddr = baseAddr.add({{.cndOnCompleteAddr}});
    // 冷启动 CdnManager 解析(可选, 旧版本 JSON 无此键则保持 ptr(0), 走 hook 捕获老路)
    {{if .cdnGetServiceAddr}}cdnGetServiceAddr = baseAddr.add({{.cdnGetServiceAddr}});{{end}}
    {{if .cdnManagerGetterAddr}}cdnManagerGetterAddr = baseAddr.add({{.cdnManagerGetterAddr}});{{end}}

    // 4.1.13(structVer=3) manager 捕获点(可选键, 旧版 JSON 无此键则 ptr(0) 禁用)
    {{if .mgrCaptureAddr}}mgrCaptureAddr = baseAddr.add({{.mgrCaptureAddr}});{{end}}
    // 4.1.13(structVer=3) H 尾部响应分发点(可选键): resp(msg=x22, ab=x1) 前的 mov,
    // 收消息(protobuf_msg)与发送 ack(buf2resp)统一走这里, 取代 4.1.11 的 buf2RespAddr
    {{if .respDispatchAddr}}respDispatchAddr = baseAddr.add({{.respDispatchAddr}});{{end}}
    // 4.1.13(structVer=3) 长链 push 入口(可选键): stn.cc __OnPush 函数头。稳态
    // (登录后短链 CGI 窗口关闭) newsync 全以长链 push 到达, 此处=收消息主路+第4出队点
    {{if .onPushAddr}}onPushAddr = baseAddr.add({{.onPushAddr}});{{end}}

    uploadGetCallbackWrapperAddr = baseAddr.add({{.uploadGetCallbackWrapperAddr}});
    uploadGetCallbackWrapperFuncAddr = baseAddr.add({{.uploadGetCallbackWrapperFuncAddr}});
    uploadOnCompleteAddr = baseAddr.add({{.uploadOnCompleteAddr}});
    uploadOnCompleteFuncAddr = baseAddr.add({{.uploadOnCompleteFuncAddr}});
    downloadImagAddr = baseAddr.add({{.downloadImagAddr}});
    startDownloadMedia = baseAddr.add({{.startDownloadMedia}});
    downloadFileAddr = baseAddr.add({{.downloadFileAddr}});
    downloadVideoAddr = baseAddr.add({{.downloadVideoAddr}});

	sendMessageCallbackFunc = baseAddr.add(0x0);
	imgMessageCallbackFunc = baseAddr.add(0x0);
	videoMessageCallbackFunc = baseAddr.add(0x0);
    replyMessageCallbackFunc = baseAddr.add(0x0);
    voiceMessageCallbackFunc = baseAddr.add(0x0);

    setupRetOneStub();  // 必须同步先执行，初始化fakeVtable
    setImmediate(setupSendTextMessageDynamic);
    setImmediate(setupSendFileMessageDynamic);
    setImmediate(setupSendFileUploadMessageDynamic);
    setImmediate(setupSendAppAttachMessageDynamic);
    setImmediate(attachBlrX8Hook);
    setImmediate(AttachSendFunc);
    setImmediate(attachReq2buf);
    setImmediate(setupSendImgMessageDynamic);
    setImmediate(attachUploadMedia);
    setImmediate(patchCdnOnComplete);
    setImmediate(attachGetCallbackFromWrapper);
    setImmediate(setupSendReplyMessageDynamic);
    setImmediate(setupDownloadFileDynamic);
    setImmediate(setReceiver);
}

// -------------------------基础函数分区-------------------------
function hexToByteArray(hexStr) {
    var bytes = [];
    for (var i = 0; i < hexStr.length; i += 2) {
        bytes.push(parseInt(hexStr.substr(i, 2), 16));
    }
    return bytes;
}

function patchString(addr, plainStr) {
    const bytes = [];
    for (let i = 0; i < plainStr.length; i++) {
        bytes.push(plainStr.charCodeAt(i));
    }

    addr.writeByteArray(bytes);
    addr.add(bytes.length).writeU8(0);
}

function generateAESKey() {
    const chars = 'abcdef0123456789';
    let key = '';
    for (let i = 0; i < 32; i++) {
        key += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return key;
}

const MAX_FRIDA_MESSAGE_BYTES = 4 * 1024 * 1024;

function isReadablePointer(addr) {
    try {
        if (!addr || addr.isNull()) {
            return false;
        }
        const range = Process.findRangeByAddress(addr);
        return range !== null && range.protection.indexOf('r') !== -1;
    } catch (e) {
        return false;
    }
}

function readPointerIfReadable(addr) {
    try {
        if (!isReadablePointer(addr)) {
            return ptr(0);
        }
        const value = addr.readPointer();
        if (!isReadablePointer(value)) {
            return ptr(0);
        }
        return value;
    } catch (e) {
        return ptr(0);
    }
}

function readUtf8StringIfReadable(addr) {
    try {
        if (!isReadablePointer(addr)) {
            return "";
        }
        return addr.readUtf8String();
    } catch (e) {
        return "";
    }
}

function readByteArrayIfReadable(addr, len) {
    try {
        if (len <= 0 || !isReadablePointer(addr)) {
            return null;
        }
        return addr.readByteArray(len);
    } catch (e) {
        return null;
    }
}

function sendDownloadChunks(dataPtr, dataLen, fileId, cdnUrl) {
    if (!cdnUrl || dataLen <= 0) {
        return;
    }

	if (dataLen > 0 && dataLen <= 10 * 1024 * 1024) {
		var buffer = dataPtr.readByteArray(dataLen);
		var uint8Array = new Uint8Array(buffer);

		send({
			type: "download",
			media: Array.from(uint8Array),
			file_id: fileId,
			cdn_url: cdnUrl,
		})
	}
}

// mars::cdn::CdnManager 单例解析: 上传(uploadGlobalX0)/下载(downloadGlobalX0)共用的 this。
// 2026-09-02 静态分析 4.1.10: 上传/下载分发链(0x4e5a6e4/0x4e5a7f4)都走
// GetService("default")[0x4ca2130] -> 按类型名 "N4mars3cdn10CdnManagerE" getter[0x4e59dec]
// -> [ctx+0x40]。该单例登录后即注册进全局服务表, 不需要先发一张图片触发。
// ⚠️ 2026-09-03 事故教训: 登录未完成时服务表锁被登录流程持有, 此时在 Frida 线程调
// GetService 会与微信主线程死锁, 微信整个冻结。因此必须有"登录稳定门禁":
// 只在 (收到过任意同步消息 = 确已登录) 或 (脚本已跑 60s) 之后才允许解析。
var scriptLoadTime = Date.now();
var incomingTrafficSeen = false;
function loginSettled() {
    if (incomingTrafficSeen) return true;
    if (Date.now() - scriptLoadTime > 60 * 1000) return true;
    return false;
}
function resolveCdnManager() {
    if (cdnGetServiceAddr.equals(ptr(0)) || cdnManagerGetterAddr.equals(ptr(0))) {
        return ptr(0);
    }
    if (!loginSettled()) {
        console.log("[!] 登录尚未稳定, 暂缓 CdnManager 解析(防死锁), 稍后任务重试");
        return ptr(0);
    }
    try {
        // libc++ SSO 短字符串: 数据在 +0, 长度写在 +0x17 (对照 wechat.dylib std::string ctor)
        var strDefault = Memory.alloc(24);
        strDefault.writeUtf8String("default");
        strDefault.add(0x17).writeU8(7);

        var getService = new NativeFunction(cdnGetServiceAddr, 'pointer', ['pointer']);
        var svc = getService(strDefault);
        if (!isReadablePointer(svc)) {
            console.error("[!] GetService(\"default\") 返回不可读: " + svc);
            return ptr(0);
        }
        var getCtx = new NativeFunction(cdnManagerGetterAddr, 'pointer', ['pointer']);
        var ctx = getCtx(svc);
        if (!isReadablePointer(ctx)) {
            console.error("[!] CdnManager getter 返回不可读: " + ctx);
            return ptr(0);
        }
        var mgr = readPointerIfReadable(ctx.add(0x40));
        if (!isReadablePointer(mgr)) {
            console.error("[!] ctx+0x40 管理器指针不可读: ctx=" + ctx);
            return ptr(0);
        }
        return mgr;
    } catch (e) {
        console.error("[!] resolveCdnManager 异常: " + e);
        return ptr(0);
    }
}

// CdnManager 兜底: 1) hook 已捕获的互回填(同一单例) 2) 都没有则走服务定位器解析
function ensureCdnManagerX0() {
    if (uploadGlobalX0.equals(ptr(0)) && downloadGlobalX0) {
        uploadGlobalX0 = downloadGlobalX0;
        console.log("[+] downloadGlobalX0 回填 uploadGlobalX0: " + uploadGlobalX0);
    }
    if (!downloadGlobalX0 && !uploadGlobalX0.equals(ptr(0))) {
        downloadGlobalX0 = uploadGlobalX0;
        console.log("[+] uploadGlobalX0 回填 downloadGlobalX0: " + downloadGlobalX0);
    }
    if (uploadGlobalX0.equals(ptr(0))) {
        var mgr = resolveCdnManager();
        if (!mgr.equals(ptr(0))) {
            uploadGlobalX0 = mgr;
            if (!downloadGlobalX0) {
                downloadGlobalX0 = mgr;
            }
            console.log("[+] 冷启动服务定位器解析 CdnManager: " + mgr);
        }
    }
    return !uploadGlobalX0.equals(ptr(0));
}

function fillUploadX1AndStart(idAddr, pathAddr, x1Buffer, receiver, md5, filePath, payloadHex) {
    if (uploadGlobalX0.equals(ptr(0))) {
        ensureCdnManagerX0();
    }
    if (uploadGlobalX0.equals(ptr(0))) {
        console.error("[!] uploadGlobalX0 尚未初始化，请等待 hook 捕获");
        return "fail";
    }

    const payload = hexToByteArray(payloadHex);
    patchString(idAddr, receiver + "_" + String(Math.floor(Date.now() / 1000)) + "_" + Math.floor(Math.random() * 1001) + "_1");
    patchString(md5Addr, md5);
    patchString(uploadAesKeyAddr, generateAESKey());
    patchString(pathAddr, filePath);

    x1Buffer.writeByteArray(payload);
    x1Buffer.writePointer(uploadFunc1Addr);
    x1Buffer.add(0x08).writePointer(uploadFunc2Addr);
    x1Buffer.add(0x48).writePointer(idAddr);
    x1Buffer.add(0x68).writeUtf8String(receiver);
    x1Buffer.add(0xa8).writePointer(md5Addr);
    x1Buffer.add(0xe8).writePointer(pathAddr);
    x1Buffer.add(0x118).writePointer(pathAddr);
    x1Buffer.add(0x148).writePointer(pathAddr);
    x1Buffer.add(0x200).writePointer(uploadAesKeyAddr);

    const startUploadMedia = new NativeFunction(uploadImageAddr, 'int64', ['pointer', 'pointer']);
    return startUploadMedia(uploadGlobalX0, x1Buffer);
}

// -------------------------基础函数分区-------------------------

// -------------------------全局变量分区-------------------------

// 文本消息全局变量 (new_text.js approach)
var blrX8Addr;
var autoBufferWriteFunc;
var textCgiAddr = ptr(0);
var sendTextMessageAddr = ptr(0);
var textMessageAddr = ptr(0);
var sendMessageCallbackFunc;
var retOneStub = ptr(0);
var fakeVtable = ptr(0);
// 等待buf2resp的任务表: taskId -> { addr, msgType, timerId }
// 支持多任务并存 + 超时兜底: ack迟迟不来时提前清零 X24+0x60, 避免mars
// 回收死任务时对伪造结构体做虚调用/delete导致SIGSEGV (2026-08-17 crash)
var pendingBuf2RespTasks = {};
// 正常ack在1s内返回; 3s未回视为失败。必须赶在mars短链CGI失败窗口(~5s)之前
// 复原原始指针: 8/20崩溃即任务无ack, ~5s失败回调在协程线程erase任务map时踩坏
// 节点, 10s兜底来不及。original指针本就是sendFunc构造的合法消息, 提前复原=
// 回到原生行为; 迟到ack仍能命中(entry保留30s), 只是entry.addr已空不再清理
var PENDING_CLEANUP_TIMEOUT_MS = 3 * 1000;
var textProtoDataAddr = ptr(0);


// 双方公共使用的地址
var triggerX1Payload;
var triggerTaskSnapshot = null;
var triggerX0;
var req2bufEnterAddr;
var req2bufExitAddr;
var sendFuncAddr;
var insertMsgAddr = ptr(0);
var originalInsertMsgPtr = ptr(0);  // hook前X24+0x60的原始消息指针, 超时兜底时复原
var sendMsgType = "";
var buf2RespAddr;

var uploadImageAddr;
var cdnGetServiceAddr = ptr(0);      // GetService(std::string) 服务定位器, 冷启动解析 CdnManager 用
var cdnManagerGetterAddr = ptr(0);   // 按类型名 "N4mars3cdn10CdnManagerE" 取 ctx 的 getter
var msgMapMgrGlobal = ptr(0);        // 4.1.13: msg-map manager this, 捕获点 hook 顺手捕获
var mgrCaptureAddr = ptr(0);         // 4.1.13: manager 捕获 hook 点(0x42e4c2c, H found 路径)
var respDispatchAddr = ptr(0);       // 4.1.13: H 尾部响应分发点(0x42e5044, mov x0,x22)
var onPushAddr = ptr(0);             // 4.1.13: 长链 push 入口(stn.cc __OnPush 头 0x59b0e94)
var cndOnCompleteAddr;
var imgMessageCallbackFunc;
var videoMessageCallbackFunc;

var uploadGetCallbackWrapperAddr;
var uploadGetCallbackWrapperFuncAddr;
var uploadOnCompleteAddr;
var uploadOnCompleteFuncAddr;
var downloadImagAddr;
var startDownloadMedia;
var downloadFileAddr;
var downloadVideoAddr;

var downloadGlobalX0;
var downloadFileX1 = ptr(0)
var fileIdAddr = ptr(0)
var downloadAesKeyAddr = ptr(0)
var filePathAddr = ptr(0)
var fileCdnUrlAddr = ptr(0)
var uploadImageX1 = ptr(0);
var imgCgiAddr = ptr(0);
var sendImgMessageAddr = ptr(0);
var imgMessageAddr = ptr(0);
var uploadGlobalX0 = ptr(0)
var uploadFunc1Addr = ptr(0)
var uploadFunc2Addr = ptr(0)
var imageIdAddr = ptr(0)
var md5Addr = ptr(0)
var uploadAesKeyAddr = ptr(0)
var ImagePathAddr1 = ptr(0)
var uploadCallback = ptr(0)

var videoCgiAddr = ptr(0);
var sendVideoMessageAddr = ptr(0);
var videoMessageAddr = ptr(0);
var uploadVideoX1 = ptr(0);
var videoIdAddr = ptr(0);
var videoPathAddr1 = ptr(0)

// 语音消息全局变量
var voiceMessageCallbackFunc;
var voiceCgiAddr = ptr(0);
var sendVoiceMessageAddr = ptr(0);
var voiceMessageAddr = ptr(0);
var uploadVoiceX1 = ptr(0);
var voiceIdAddr = ptr(0);
var voicePathAddr1 = ptr(0);
var voiceProtoHexGlobal = "";
var voiceDurationGlobal = 0;
var voiceSilkDataLenGlobal = 0;
var voiceAudioDataAddr = ptr(0);


// 发送消息的全局变量
var taskIdGlobal = 0x20000090 // 最好比较大，不和原始的微信消息重复

// 文本消息protobuf全局变量 (从Go直接传入hex编码)
var textProtoHexGlobal = "";
// 图片消息protobuf全局变量 (从Go直接传入hex编码)
var imgProtoHexGlobal = "";
// 视频消息protobuf全局变量 (从Go直接传入hex编码)
var videoProtoHexGlobal = "";
// 回复消息protobuf全局变量 (从Go直接传入hex编码)
var replyProtoHexGlobal = "";
// 文件消息protobuf全局变量 (从Go直接传入hex编码)
var fileProtoHexGlobal = "";
var fileUploadProtoHexGlobal = "";
// uploadappattach protobuf全局变量 (从Go直接传入hex编码)
var appAttachProtoHexGlobal = "";

// 文件消息全局变量
var fileCgiAddr = ptr(0);
var sendFileMessageAddr = ptr(0);
var fileMessageAddr = ptr(0);
var uploadFileIdAddr = ptr(0);
var uploadFileX1 = ptr(0);

// sendfileuploadmsg 全局变量
var fileUploadCgiAddr = ptr(0);
var sendFileUploadMessageAddr = ptr(0);
var fileUploadMessageAddr = ptr(0);

// uploadappattach 全局变量
var appAttachCgiAddr = ptr(0);
var sendAppAttachMessageAddr = ptr(0);
var appAttachMessageAddr = ptr(0);

// 回复消息全局变量
var replyMessageCallbackFunc;
var replyCgiAddr = ptr(0);
var sendReplyMessageAddr = ptr(0);
var replyMessageAddr = ptr(0);

// -------------------------全局变量分区-------------------------


// -------------------------发送文本消息分区-------------------------
// 初始化进行内存的分配
function setupSendTextMessageDynamic() {
    // 动态分配内存

    textCgiAddr = Memory.alloc(128);
    sendTextMessageAddr = Memory.alloc(256);
    textMessageAddr = Memory.alloc(256);
    textProtoDataAddr = Memory.alloc(64 * 1024); // 支持 50KB 分片(uploadappattach)的 protobuf

    // A. 写入字符串内容
    patchString(textCgiAddr, "/cgi-bin/micromsg-bin/newsendmsg");

    // B. 构建 sendTextMessageAddr 结构体 (X24 基址位置)
    sendTextMessageAddr.add(0x00).writeU64(0);
    sendTextMessageAddr.add(0x08).writeU64(0);
    sendTextMessageAddr.add(0x10).writeU64(0);
    sendTextMessageAddr.add(0x18).writeU64(1);
    sendTextMessageAddr.add(0x20).writeU32(taskIdGlobal);
    sendTextMessageAddr.add(0x28).writePointer(textMessageAddr);

    // C. 构建 Message 结构体
    textMessageAddr.add(0x00).writePointer(fakeVtable);
    textMessageAddr.add(0x08).writeU32(taskIdGlobal);
    textMessageAddr.add(0x0c).writeU32(0x20a);
    textMessageAddr.add(0x10).writeU64(0x3);
    textMessageAddr.add(0x18).writePointer(textCgiAddr);
    textMessageAddr.add(0x20).writeU64(uint64("0x20"));

    console.log("[+] Dynamic Text Message Setup Complete.");
}


// -------------------------发送文件消息分区-------------------------
function setupSendFileMessageDynamic() {
    fileCgiAddr = Memory.alloc(128);
    sendFileMessageAddr = Memory.alloc(256);
    fileMessageAddr = Memory.alloc(256);
    uploadFileIdAddr = Memory.alloc(128);
    uploadFileX1 = Memory.alloc(1024);
    patchString(uploadFileIdAddr, "file_upload_not_init");

    patchString(fileCgiAddr, "/cgi-bin/micromsg-bin/sendappmsg");

    sendFileMessageAddr.add(0x00).writeU64(0);
    sendFileMessageAddr.add(0x08).writeU64(0);
    sendFileMessageAddr.add(0x10).writeU64(0);
    sendFileMessageAddr.add(0x18).writeU64(1);
    sendFileMessageAddr.add(0x20).writeU32(taskIdGlobal);
    sendFileMessageAddr.add(0x28).writePointer(fileMessageAddr);

    fileMessageAddr.add(0x00).writePointer(fakeVtable);
    fileMessageAddr.add(0x08).writeU32(taskIdGlobal);
    fileMessageAddr.add(0x0c).writeU32(0x6e);
    fileMessageAddr.add(0x10).writeU64(0x3);
    fileMessageAddr.add(0x18).writePointer(fileCgiAddr);
    fileMessageAddr.add(0x20).writeU64(0x20);
    fileMessageAddr.add(0x28).writeU64(uint64("0x8000000000000030"));
    fileMessageAddr.add(0x30).writeU64(uint64("0x0000000001010100"));
}

function triggerSendFileMessage(taskId, sender, receiver, protoHex, payloadHex) {
    return triggerSendMediaMessage(taskId, sender, receiver, protoHex, payloadHex, "file");
}

function triggerUploadFile(receiver, md5, filePath, payloadHex) {
    return fillUploadX1AndStart(uploadFileIdAddr, ImagePathAddr1, uploadFileX1, receiver, md5, filePath, payloadHex);
}

// -------------------------sendfileuploadmsg分区-------------------------
function setupSendFileUploadMessageDynamic() {
    fileUploadCgiAddr = Memory.alloc(128);
    sendFileUploadMessageAddr = Memory.alloc(256);
    fileUploadMessageAddr = Memory.alloc(256);

    patchString(fileUploadCgiAddr, "/cgi-bin/micromsg-bin/sendfileuploadmsg");

    sendFileUploadMessageAddr.add(0x00).writeU64(0);
    sendFileUploadMessageAddr.add(0x08).writeU64(0);
    sendFileUploadMessageAddr.add(0x10).writeU64(0);
    sendFileUploadMessageAddr.add(0x18).writeU64(1);
    sendFileUploadMessageAddr.add(0x20).writeU32(taskIdGlobal);
    sendFileUploadMessageAddr.add(0x28).writePointer(fileUploadMessageAddr);

    fileUploadMessageAddr.add(0x00).writePointer(fakeVtable);
    fileUploadMessageAddr.add(0x08).writeU32(taskIdGlobal);
    fileUploadMessageAddr.add(0x0c).writeU32(0x6e);
    fileUploadMessageAddr.add(0x10).writeU64(0x3);
    fileUploadMessageAddr.add(0x18).writePointer(fileUploadCgiAddr);
    fileUploadMessageAddr.add(0x20).writeU64(0x20);
    fileUploadMessageAddr.add(0x28).writeU64(uint64("0x8000000000000030"));
    fileUploadMessageAddr.add(0x30).writeU64(uint64("0x0000000001010100"));
}

function triggerSendFileUploadMessage(taskId, sender, receiver, protoHex, payloadHex) {
    return triggerSendMediaMessage(taskId, sender, receiver, protoHex, payloadHex, "fileupload");
}

// -------------------------uploadappattach分区-------------------------
function setupSendAppAttachMessageDynamic() {
    appAttachCgiAddr = Memory.alloc(128);
    sendAppAttachMessageAddr = Memory.alloc(256);
    appAttachMessageAddr = Memory.alloc(256);

    patchString(appAttachCgiAddr, "/cgi-bin/micromsg-bin/uploadappattach");

    sendAppAttachMessageAddr.add(0x00).writeU64(0);
    sendAppAttachMessageAddr.add(0x08).writeU64(0);
    sendAppAttachMessageAddr.add(0x10).writeU64(0);
    sendAppAttachMessageAddr.add(0x18).writeU64(1);
    sendAppAttachMessageAddr.add(0x20).writeU32(taskIdGlobal);
    sendAppAttachMessageAddr.add(0x28).writePointer(appAttachMessageAddr);

    appAttachMessageAddr.add(0x00).writePointer(fakeVtable);
    appAttachMessageAddr.add(0x08).writeU32(taskIdGlobal);
    appAttachMessageAddr.add(0x0c).writeU32(0x6e);
    appAttachMessageAddr.add(0x10).writeU64(0x3);
    appAttachMessageAddr.add(0x18).writePointer(appAttachCgiAddr);
    appAttachMessageAddr.add(0x20).writeU64(0x25);
    appAttachMessageAddr.add(0x28).writeU64(uint64("0x8000000000000030"));
    appAttachMessageAddr.add(0x30).writeU64(uint64("0x0000000001010100"));
}

function triggerUploadAppAttach(taskId, sender, receiver, protoHex, payloadHex) {
    return triggerSendMediaMessage(taskId, sender, receiver, protoHex, payloadHex, "appattach");
}

// -------------------------发送文件消息分区-------------------------



// 创建一个只返回1的小函数stub
function setupRetOneStub() {
    retOneStub = Memory.alloc(Process.pageSize);
    Memory.patchCode(retOneStub, 8, code => {
        // MOV W0, #1 = 0x52800020, RET = 0xD65F03C0 (little-endian)
        code.writeByteArray([0x20, 0x00, 0x80, 0x52, 0xC0, 0x03, 0x5F, 0xD6]);
    });
    // ⚠️ 2026-09-20 22:35 实锤: Memory.alloc 返回 rw- 页, patchCode 改完代码后
    // "恢复原保护"仍是 rw-(不可执行) → 原生 blr 进 stub = AV + mgr+0x80 毒锁。
    // 旧两代 retOneStub "能跑"是当时 gadget alloc 即 RWX 的历史行为,不可依赖;
    // 显式提权 r-x 一劳永逸, 失败则拒绝继续(虚调用必崩)。
    if (!Memory.protect(retOneStub, Process.pageSize, 'r-x')) {
        throw new Error("[-] retOneStub 页提权 r-x 失败, 原生虚调用必崩, 拒绝继续");
    }
    console.log("[+] Return-1 stub created at: " + retOneStub);

    // 构造假vtable：所有槽位指向retOneStub，这样mars对我们伪造结构做虚调用时不会崩溃
    fakeVtable = Memory.alloc(512);
    for (var i = 0; i < 64; i++) {
        fakeVtable.add(i * 8).writePointer(retOneStub);
    }
    console.log("[+] Fake vtable created at: " + fakeVtable);
}

function attachBlrX8Hook() {
    console.log("[+] Hooking BLR X8 at: " + blrX8Addr);

    var nativeAutoBufferWrite = new NativeFunction(autoBufferWriteFunc, 'int', ['pointer', 'pointer', 'int']);

    if (structVer === "3") {
        setupV3SendCallbacks(); // 序列化注入 = CModule serialize_stub(见函数内注释)
        return;
    }

    Interceptor.attach(blrX8Addr, {
        onEnter: function(args) {
            var currentTaskId = this.context.x20.toUInt32();
            if (currentTaskId !== taskIdGlobal) {
                return;
            }

            console.log("[+] BLR X8 命中! taskId=" + currentTaskId + " sendMsgType=" + sendMsgType);

            var autoBuffer = this.context.x1;
            var protoHex = "";

            if (sendMsgType === "text") {
                protoHex = textProtoHexGlobal;
            } else if (sendMsgType === "img") {
                protoHex = imgProtoHexGlobal;
            } else if (sendMsgType === "video") {
                protoHex = videoProtoHexGlobal;
            } else if (sendMsgType === "reply") {
                protoHex = replyProtoHexGlobal;
            } else if (sendMsgType === "file") {
                protoHex = fileProtoHexGlobal;
            } else if (sendMsgType === "fileupload") {
                protoHex = fileUploadProtoHexGlobal;
            } else if (sendMsgType === "appattach") {
                protoHex = appAttachProtoHexGlobal;
            } else if (sendMsgType === "voice") {
                protoHex = voiceProtoHexGlobal;
            }

            if (!protoHex || protoHex.length === 0) {
                console.error("[!] protoHex 为空, sendMsgType=" + sendMsgType);
                return;
            }

            var finalPayload = hexToByteArray(protoHex);
            textProtoDataAddr.writeByteArray(finalPayload);

            // 调用 autoBufferWrite(autoBuffer, data, len) 填充 v133
            nativeAutoBufferWrite(autoBuffer, textProtoDataAddr, finalPayload.length);
            console.log("[+] autoBufferWrite 调用完成, protobuf长度: " + finalPayload.length);

            // 将 X8 指向 retOneStub，这样 BLR X8 只会返回1，不执行原始逻辑
            this.context.x8 = retOneStub;
        }
    });
}


// ---------------------4.1.13(structVer=3) SubmitCgi 零伪造发送分区---------------------
// 范式(2026-09-20 静态定案, 详见 docs/4.1.13-submitcgi-analysis.md):
// 4.1.13 真发送入口 = SubmitCgi(0x42e3450, mgr, msg)。一次调用微信原生完成:
// 建 Task(0x218) → 分配真 taskid 写回 msg+8 → 红黑树原生 insert → StartTask。
// 旧 replay 范式死于 Task 0x1A0→0x218 模板过期(errType=7 本地否决)+
// manager 消费者改 find-and-pop。我们只提供伪造 msg:
//   +0x00 专用虚表(+0x10 序列化 = CModule serialize_stub 注入包体;
//          +0x18 响应 = ret_one 空转, ack 由 resp-dispatch hook 转发)
//   +0x18 URI 老libc++长串 {cgiBuf,len,len}+0x2f=0x80 (拷贝构造只读ptr/size)
//   +0x68 假回调对象(其虚表 +0x30 = CModule complete_stub, 返回 0 ⇒ msg 永不析构)
// 唯一 hook 点 = mgrCaptureAddr(0x42e4c2c, read-only 捕获 x19=manager)。
// 入口(0x42e3450/H头/另一consumer)只 call 不 attach —— attach 即崩原生流量。
// 2026-09-20 22:53 首通实证: 本范式消息已真实送达(nativeTaskId=345, 用户确认);
// 2026-09-21 complete_stub 验证通过: 文本+图/视频/文件/语音/引用五类媒体全部
// 送达且微信存活, 后置崩溃零复发。
var v3Send = null; // 惰性构建的 {msgVtable, callbackVtable, submitCgi, autoBufferWrite, cm}

function setupV3SendCallbacks() {
    if (v3Send !== null) {
        return;
    }
    var autoBufferWrite = new NativeFunction(autoBufferWriteFunc, 'int', ['pointer', 'pointer', 'int']);
    var submitCgi = new NativeFunction(req2bufEnterAddr, 'int', ['pointer', 'pointer']);

    // ⚠️ 蹦床铁律(2026-09-20 实锤×6) —— 四条:
    // 1) NativeCallback 在"JS已进入线程上经 NativeFunction 调用再被 native 虚调用"
    //    = 确定性 AV@0x4/0xa(三次)。V1/V2 两代 native 路径零 NativeCallback。
    // 2) SubmitCgi 函数体内任何地址不可 hook —— 指令点 hook 重定位破坏原生热路径
    //    (22:17 原生 msg 虚表指针变垃圾, minidump 实锤)。
    // 3) Memory.alloc+patchCode 自有页: JS 线程可执行(自检 ret=1)但微信原生线程
    //    blr 必 AV@页地址(22:35 rw-页 / 22:43 r-x提权页, 同址两杀) —— 自有页执行权
    //    存在线程级门槛, 自有页一律不得作为 native 虚调用目标。
    // 4) frida 自家 code allocator 页(trampoline/CModule)整晚被微信线程执行无恙
    //    (所有 read-only hook 都在跑) —— 唯一可信的自有执行区。
    // ⇒ 序列化注入 = CModule 纯机器码: vt+0x10 = cm.serialize_stub, 内部直调
    //   autoBufferWrite(per-send 数据经假回调对象邮箱 cb+0x08/+0x10 传入),
    //   native 路径零 JS / 零 hook / 零 NativeCallback, 三个杀手一次全灭。
    // 完成回调 cb->vt+0x30 也改 CModule complete_stub(2026-09-20 22:53 后置崩溃
    // 修复, 09-21 五类媒体+文本验证通过): 22:53 首通实证消息已送达但 ~1s 后微信
    // 崩 —— 完成回调是发送路径上最后一个 NativeCallback, 签名是猜的(4 指针),
    // 编组读错栈即崩。complete_stub 纯机器码: 不读任何参数(签名免疫), 返回 0 跳过
    // msg 析构; errType 可见性由 resp-dispatch ack 转发给 Go(响应体含服务端 ret)兜底。
    var cm;
    try {
        cm = new CModule(`
#include <stdint.h>
extern int autoBufferWrite(void* ab, const void* data, int len);
// payload 邮箱在假回调对象里(JS 侧 rw- 可写, native 只对它做虚调用):
//   msg+0x68 -> cb; cb+0x08 = dataPtr; cb+0x10 = len
// (CModule 页 r-x, C 全局 JS 写不进去 = AV; 假回调对象是纯 JS 堆, 无此问题)
int serialize_stub(void* msg, void* autobuf) {
    void* cb = *(void**)((char*)msg + 0x68);
    if (cb != 0) {
        const void* data = *(void**)((char*)cb + 0x08);
        int len = *(int*)((char*)cb + 0x10);
        if (data != 0 && len > 0) {
            autoBufferWrite(autobuf, data, len);
        }
    }
    return 1;
}
// 完成回调 stub: 纯机器码, 不读任何参数(H 的调用签名未知, 读寄存器/栈指针
// 等于赌签名), 返回 0 = H 尾部跳过 msg 析构。22:53 后置崩溃修复, 09-21 验证通过。
int complete_stub(void) { return 0; }
int ret_one(void) { return 1; }
`, { autoBufferWrite: autoBufferWriteFunc });
    } catch (e) {
        console.error("[!] V3 CModule 编译失败, 发送禁用(收消息不受影响): " + e);
        return;
    }

    // 加载期自检: CModule 可编译可调用(JS 线程)。微信线程执行权由 frida code
    // allocator 保证(trampoline 同源, 本会话整晚实证)。
    // ⚠️ QuickJS 运行时(本 gadget) CModule 函数导出 = 纯 NativePointer, 不可直接
    // 调用, 须包 NativeFunction; 数据全局 = 指向存储槽的指针, 经 .writeXxx 读写。
    var cmRetOne = new NativeFunction(cm.ret_one, 'int', []);
    if (cmRetOne() !== 1) {
        console.error("[!] V3 CModule 自检失败, 发送禁用(收消息不受影响)");
        return;
    }
    console.log("[+] V3 CModule ready: serialize_stub=" + cm.serialize_stub +
        " ret_one=" + cm.ret_one + " (frida code allocator 页, 微信线程可执行)");

    // 专用虚表: 不复用 fakeVtable(其它假对象仍在用, 防串味)。全槽位 cm.ret_one
    // (frida code allocator, 避开自有页铁律3); +0x10 序列化 = serialize_stub;
    // +0x18 buf2resp = ret_one(ack 由 resp-dispatch hook 转发)。
    var msgVtable = Memory.alloc(512);
    for (var i = 0; i < 64; i++) {
        msgVtable.add(i * 8).writePointer(cm.ret_one);
    }
    msgVtable.add(0x10).writePointer(cm.serialize_stub);

    var callbackVtable = Memory.alloc(512);
    for (var j = 0; j < 64; j++) {
        callbackVtable.add(j * 8).writePointer(cm.ret_one);
    }
    // +0x30 完成 = CModule stub: 最后一个离开 native 路径的完成回调(09-21 验证通过)
    callbackVtable.add(0x30).writePointer(cm.complete_stub);

    v3Send = {
        msgVtable: msgVtable,
        callbackVtable: callbackVtable,
        submitCgi: submitCgi,
        autoBufferWrite: autoBufferWrite,
        cm: cm,
    };
    console.log("[+] V3 send callbacks ready: msgVtable=" + msgVtable + " callbackVtable=" + callbackVtable);
}

// 无锁预检: 用 JS 自建 AutoBuffer 走一遍 write, 验证 0x4308c58 家族在 4.1.13 语义未变。
// 毒锁教训(2026-09-20): SubmitCgi 中途 AV 会跳过 unlock → mgr+0x80 锁永久毒死,
// 微信全部 CGI 卡死只能重启。预检不过绝不调 SubmitCgi。
function v3DryRunAutoBuffer() {
    try {
        var D = Memory.alloc(0x18);            // 镜像 0x4308a9c 构造产物: 0x18 全零描述块
        var ab = Memory.alloc(16);
        ab.writePointer(D);
        var sample = Memory.alloc(8);
        sample.writeByteArray([0x08, 0x01, 0x12, 0x03, 0x61, 0x62, 0x63, 0x00]);
        var w = new NativeFunction(autoBufferWriteFunc, 'int', ['pointer', 'pointer', 'int']);
        w(ab, sample, 7);
        var dataPtr = D.readPointer();
        var len = D.add(0xc).readU32();
        return !dataPtr.equals(ptr(0)) && len === 7;
    } catch (e) {
        console.log("[D] dryrun AB err: " + e);
        return false;
    }
}

// 把 8 类消息结构按 SubmitCgi 期望的 msg 布局整形(幂等, 每次发送前调用):
// URI 老libc++长串覆盖 +0x18..0x2f(顺带清掉旧 +0x20/+0x28 的 4.1.12 残留),
// +0x30 flags(Task+0x31=1/+0x32=0x0101, 媒体实证值照抄), +0x38..0x4f 合法空串,
// +0x68 假回调对象(NULL=H 内 __cxa_throw 硬崩)。
function applyV3MsgLayout(msgAddr, cgiBuf, uriLen) {
    msgAddr.add(0x00).writePointer(v3Send.msgVtable);
    msgAddr.add(0x08).writeU32(0);           // taskid: 原生实证(submitProbe)传 0, SubmitCgi 分配后回写 msg+8
    // selector: 4.1.13 运行时观测 0x8a/0xd6/0x206 三类消息全部 sel=1 (realmsg dump);
    // 4.1.11 时代的 3 是旧范式值, 跨大版本不可靠, 对齐本版观测
    msgAddr.add(0x10).writeU64(1);
    msgAddr.add(0x18).writePointer(cgiBuf);
    msgAddr.add(0x20).writeU64(uriLen);        // size
    // cap/+0x2f 旗标: 优先照抄运行时观测到的真实msg值(2026-09-20 realmsg dump),
    // 未观测到时保守回退 size/0x80
    var capVal = uriLen, flagVal = 0x80;
    if (v3Observed.capValid) {
        capVal = v3Observed.cap;
        flagVal = v3Observed.flag;
    }
    msgAddr.add(0x28).writeU64(capVal);
    msgAddr.add(0x2f).writeU8(flagVal);        // 长串旗标 = string+0x17 最高位
    // +0x30: 按消息类分化(sync类=0x01010000, 发送/cmdid 0x8a 类=0x01010100, realmsg 实证)。
    // 发送路径沿用 4.1.11/12 两代实证值 0x01010100 → +0x31=1, +0x32=0x0101
    msgAddr.add(0x30).writeU64(uint64("0x0000000001010100"));
    for (var off = 0x38; off <= 0x4f; off += 8) {
        msgAddr.add(off).writeU64(0);          // msg+0x38 空串(全零=短串size0, H 干净跳过)
    }
    // +0x40..0x47: 原生 newsendmsg 稳定字节 00 00 00 00 01 00 00 00 (submitProbe 两条一致),
    // 即 +0x44=1。字段语义未知, 逐字节照抄原生 —— 原生自己这么传必然不比零差
    msgAddr.add(0x40).writeU64(uint64("0x0000000100000000"));
    msgAddr.add(0x68).writePointer(ensureFakeCallbackObj());
}

// V3 异步提交队列: SubmitCgi 必须在微信原生(网络)线程上下文执行。
// 两次实锤(20:24 AV@0x4, 21:00 AV@0xa): 从 frida JS 线程直调, 输入布局已逐字节
// 验证正确仍然崩, 且崩点地址随运行时变化 = 线程局部状态(TLS)依赖; 原生 UI 发送
// 走同一 SubmitCgi 全程无恙。
// 出队点 ×4(谁先触发谁执行): SubmitCgi 入口 hook + resp-dispatch(H 解锁后网络线程)
// + mgr-capture + 出队泵(见 setupV3DrainPump, 2026-09-21 22:50 45s 全 CGI 静默
// 饿死实锤后启用——三个事件出队点在静默期零事件, 只能蹭合法线程阻塞的 syscall)。
// 空闲期 CGI 事件间隔实测 0~45s, 保质期 85s(Go 侧窗口 90s, 见 worker.go)。
var v3PendingSubmit = null;
var V3_SUBMIT_STALE_MS = 85 * 1000;
// 毒锁标记: SubmitCgi 中途 AV 会跳过 unlock → mgr+0x80 永久死锁, 本轮微信
// 生命周期内所有 CGI(收发)全灭只能重启。置位后禁发(fail-fast), 绝不再碰 SubmitCgi
var v3SubmitPoisoned = false;

function drainPendingSubmitNative() {
    if (v3PendingSubmit === null) {
        return;
    }
    var job = v3PendingSubmit;
    v3PendingSubmit = null; // 先取走: 单次尝试, AV/异常绝不重试(防连环毒锁)
    v3SchedulePumpDisarm(); // no-op(泵常驻不拆, 见函数注释), 保留调用点
    if (Date.now() - job.ts > V3_SUBMIT_STALE_MS) {
        console.log("[!] " + job.msgType + ": 原生线程提交出队超时, 放弃(Go 侧已超时)");
        return;
    }
    sendMsgType = job.msgType;
    try {
        v3Send.submitCgi(msgMapMgrGlobal, job.info.messageAddr);
        var nativeTaskId = job.info.messageAddr.add(0x08).readU32();
        if (nativeTaskId) {
            armPendingBuf2RespTask(nativeTaskId, ptr(0), job.msgType, ptr(0), job.taskId);
            console.log("[+] V3 SubmitCgi 原生线程提交: msgType=" + job.msgType + " nativeTaskId=" + nativeTaskId);
        } else {
            console.error("[!] " + job.msgType + ": SubmitCgi 后 msg+8 无 taskid(本地拒绝)");
        }
    } catch (e) {
        v3SubmitPoisoned = true;
        console.error("[!] " + job.msgType + ": 原生线程 SubmitCgi 异常(mgr+0x80 已毒, 微信需重启): " + e +
            " vt_raw=" + v3Hex16(job.info.messageAddr, 0x00));
    }
}

// 出队泵 v2(2026-09-21 文件流两连败实证): select 单符号泵零命中 —— mmnet
// 网络线程的等待函数不是 select。改为: (a) 合法线程集合 = 三个原生事件点
// (SubmitCgi入口/resp-dispatch/mgr-capture)实际观测到的 tid, 这些线程被
// 实证可安全跑 SubmitCgi; (b) 多符号泵 select/poll/kevent/kevent64/
// kevent_qos/recvfrom/read 全挂, 命中合法 tid 即出队, 首次命中单行日志
// 标记赢家(验收后手工裁剪只留赢家); (c) 首次 resp-dispatch 抓原生栈回溯,
// 直接看网络线程事件循环在等什么(一次性 DIAG)。
var v3ValidTids = {};
var v3TidLogN = 0;
var v3PumpArmed = false;
var v3PumpHitLog = {};
var v3BtDone = false;
function v3NoteValidTid(tid) {
    if (!v3ValidTids[tid]) {
        v3ValidTids[tid] = 1;
        if (v3TidLogN < 6) {
            v3TidLogN++;
            console.log("[+] V3 出队合法线程 tid=" + tid);
        }
    }
}
function v3SymAddr(name) {
    var addr = null;
    try {
        if (typeof Module.getGlobalExportByName === "function") {
            addr = Module.getGlobalExportByName(name);
        }
    } catch (e1) {}
    if (!addr) { try { addr = Module.findExportByName(null, name); } catch (e2) {} }
    if (!addr) { try { addr = Process.getModuleByName("libsystem_kernel.dylib").getExportByName(name); } catch (e3) {} }
    return (addr && !addr.isNull()) ? addr : null;
}
// 出队泵 v3(2026-09-21 22:50 饿死实锤后启用): 首次任务入队时挂 7 个 syscall
// hook, **挂后常驻不拆**(23:07 实锤: detach 拆 syscall 蹦床竞态崩微信, 见
// v3SchedulePumpDisarm 注释)。空闲开销 = onEnter 空队列快路径, 可忽略。
// 合法线程集合 = 三个原生事件点实际观测的 tid(实证可安全跑 SubmitCgi);
// frida 自身线程的 read/recvfrom 被 tid 门挡住不重入。递归安全:
// drainPendingSubmitNative 先取走 v3PendingSubmit 再调 submitCgi, SubmitCgi
// 内部再触发被 hook 的 syscall 时 re-entry 见 null 直接跳过。
var V3_DRAIN_PUMP_ENABLED = true;
var v3PumpListeners = null;      // 挂载句柄; null=当前未挂
var v3PumpDisarmTimer = null;

function setupV3DrainPump() {
    if (!V3_DRAIN_PUMP_ENABLED) return;
    if (v3PumpArmed) return;
    v3PumpArmed = true;
    var armed = [];
    v3PumpListeners = [];
    ["select", "poll", "kevent", "kevent64", "kevent_qos", "recvfrom", "read"].forEach(function(name) {
        var addr = v3SymAddr(name);
        if (!addr) return;
        try {
            v3PumpListeners.push(Interceptor.attach(addr, {
                onEnter: function() {
                    if (v3PendingSubmit !== null && v3ValidTids[this.threadId]) {
                        if (!v3PumpHitLog[name]) {
                            v3PumpHitLog[name] = 1;
                            console.log("[+] V3 出队泵命中(" + name + ") tid=" + this.threadId);
                        }
                        drainPendingSubmitNative();
                    }
                }
            }));
            armed.push(name);
        } catch (eAttach) { /* 该符号挂不上就跳过 */ }
    });
    console.log("[+] V3 出队泵v3已挂载(按需): " + armed.join(",") +
        " 合法tid=" + Object.keys(v3ValidTids).join("/"));
}

// [废弃 2026-09-21 23:07 实锤] 懒拆卸方案: Interceptor.detach 拆 syscall 热路径
// 蹦床存在竞态 → timer 到期 1s 内 frida-gadget 线程 SIGSEGV 崩微信(崩溃报告
// 230802, crashedThread=frida-gadget-tcp-27042, 跳转地址=被撕裂的蹦床)。
// 铁律: hook 只挂不拆。出队泵改为首挂常驻——onEnter 第一行空队列快路径 +
// tid 门使空闲开销可忽略, 稳定性 >> 常驻开销。本函数保留 no-op 兼容调用点。
function v3SchedulePumpDisarm() {
    // 常驻不拆卸(见上), no-op
}

// structVer=3 发送主路径: 交给微信原生建 Task/insert/StartTask。
// 返回 "1" 后 Go 侧照旧走 channel 等 ack(0x430783c 主路 + respCapture 兜底)。
function submitViaSubmitCgi(info, msgType, protoHex, taskId) {
    if (v3Send === null) {
        console.error("[!] " + msgType + ": V3 回调未初始化");
        return "fail";
    }
    if (msgMapMgrGlobal.equals(ptr(0))) {
        console.error("[!] " + msgType + ": manager 尚未捕获(等原生任意任务完成一次后再试)");
        return "fail";
    }
    if (v3SubmitPoisoned) {
        console.error("[!] " + msgType + ": SubmitCgi 已毒锁, 本轮微信生命周期内禁发, 需重启微信");
        return "fail";
    }
    info.protoHexSetter(protoHex);
    sendMsgType = msgType;

    // payload 先落缓冲区; 邮箱指针在 applyV3MsgLayout 设置好 msg+0x68 后再写
    var finalPayload = hexToByteArray(protoHex);
    textProtoDataAddr.writeByteArray(finalPayload);

    applyV3MsgLayout(info.messageAddr, info.cgiAddr, info.uri.length);

    // 序列化注入数据就位: payload 指针/长度写进假回调对象邮箱(cb+0x08/+0x10,
    // 见 CModule 源码注释), CModule serialize_stub 在原生线程经 msg+0x68 读取
    var cbMailbox = info.messageAddr.add(0x68).readPointer();
    cbMailbox.add(0x08).writePointer(textProtoDataAddr);
    cbMailbox.add(0x10).writeS32(finalPayload.length);

    if (!v3DryRunAutoBuffer()) {
        console.error("[!] " + msgType + ": AutoBuffer 预检失败, 放弃 SubmitCgi(防毒锁)");
        return "fail";
    }
    v3PendingSubmit = { info: info, msgType: msgType, taskId: taskId, ts: Date.now() };
    // 出队泵按需挂载: 入队即挂(若拆卸 timer 在等则取消, 轮内保持挂载)
    if (v3PumpDisarmTimer !== null) { clearTimeout(v3PumpDisarmTimer); v3PumpDisarmTimer = null; }
    setupV3DrainPump();
    console.log("[+] " + msgType + ": 已入队原生线程提交(事件出队点+出队泵)");
    return "1";
}
// ---------------------4.1.13 SubmitCgi 零伪造发送分区---------------------


function triggerSendTextMessage(taskId, receiver, content, atUser, protoHex, payloadHex) {
    return triggerSendMediaMessage(taskId, "", receiver, protoHex, payloadHex, "text");
}

function AttachSendFunc() {
    // 4.1.13(structVer=3): SubmitCgi 范式不再 replay MMStartTask, 无需捕获
    // X0/X1/快照; 不挂此 hook 也省掉每条原生消息一条 console.log 的管道开销
    if (structVer === "3") {
        console.log("[+] V3: 跳过 AttachSendFunc (SubmitCgi 范式无需 StartTask 捕获)");
        return;
    }
    Interceptor.attach(sendFuncAddr.add(0x10), {
        onEnter: function (args) {

            // 每次都刷新捕获(upstream 只抓第一次): 保证 payload 指向最近的任务,
            // 并快照完整任务结构(入口时任务已完整构造, 含回调子对象);
            // 注入前整块恢复, 避免复用 free 后残骸里的野回调指针(4.1.12 崩溃根因)
            triggerX0 = this.context.x0;
            triggerX1Payload = this.context.x1;
            try {
                triggerTaskSnapshot = triggerX1Payload.readByteArray(0x300);
            } catch (e) {
                console.log("[-] 任务快照失败: " + e);
            }
            console.log(`[+] 捕获到 StartTask 调用，X0：${triggerX0}, Payload: ${triggerX1Payload}`);
        }
    })
}


// -------------------------发送文本消息分区-------------------------


// -------------------------buf2resp超时兜底分区-------------------------
// 4.1.13: H 完成路径强制要求 msg+0x68 有回调对象, NULL 即
// __cxa_throw 硬断言(2026-09-20 15:13 实锤: 崩溃帧 0x42e5120 → bl 0x21f518
// 抛异常)。structVer=3 用专用 callbackVtable: vt+0x30 = CModule complete_stub
// (纯机器码返回 0 ⇒ H 尾部跳过 msg 析构; 09-21 五类媒体验证通过);
// 旧版仍用 fakeVtable 空转。
var fakeCallbackObj = ptr(0);
function ensureFakeCallbackObj() {
    if (fakeCallbackObj.equals(ptr(0))) {
        var vt = (structVer === "3" && v3Send !== null) ? v3Send.callbackVtable : fakeVtable;
        fakeCallbackObj = Memory.alloc(64);
        fakeCallbackObj.writePointer(vt);
        console.log("[+] Fake callback obj created at: " + fakeCallbackObj + " vtable=" + vt);
    }
    return fakeCallbackObj;
}

// 4.1.13(structVer=3) 收发统一响应分发点: 0x42e5044 (blr 前一条 mov x0,x22)。
// 所有完成 CGI 任务的响应都经 msg->vt+0x18(msg=x22, ab=x1) 分发 ——
// 收消息(首字节 0x08 → protobuf_msg)与我们的发送 ack(pending 表命中 → buf2resp)
// 在此合流, 取代 4.1.11 的 buf2RespAddr(该点 4.1.13 身份换位已死, 零触发实证)。
// read-only: 原生 resp 虚调用在 hook 返回后照常执行。热路径零日志(铁律8)。
// 60s 心跳 DIAG(2026-09-21 短链/长链窗口根因排查): 登录后短链窗口期 hits 应为高,
// 窗口关闭后应归零——归零即实锤"收发死=窗口关闭", 稳态收消息由 OnPush 接管。
// 窗口假说验证完成后此 DIAG 可删(同铁律: 只删日志不动逻辑)。
var v3RespHeartbeatN = 0;
var v3RespHeartbeatTs = Date.now();
function attachRespDispatchV3() {
    if (respDispatchAddr.equals(ptr(0))) {
        console.error("[!] JSON 缺 respDispatchAddr, V3 收消息/ack 不可用");
        return;
    }
    console.log("[+] Hooking resp-dispatch V3 at: " + respDispatchAddr);
    Interceptor.attach(respDispatchAddr, {
        onEnter: function (args) {
            try {
                v3RespHeartbeatN++;
                var hbNow = Date.now();
                if (hbNow - v3RespHeartbeatTs > 60 * 1000) {
                    console.log("[D] resp-dispatch 60s心跳: hits=" + v3RespHeartbeatN);
                    v3RespHeartbeatTs = hbNow;
                    v3RespHeartbeatN = 0;
                }
                // 原生线程出队(H 解锁后网络线程, 见 v3PendingSubmit 注释)
                drainPendingSubmitNative();
                v3NoteValidTid(this.threadId);
                if (!v3BtDone) {
                    v3BtDone = true;
                    // 一次性 DIAG: 网络线程的调用栈, 直接暴露事件循环的等待函数
                    try {
                        var bt = Thread.backtrace(this.context, Backtracer.ACCURATE).slice(0, 14);
                        var frames = bt.map(function(a) {
                            var s = DebugSymbol.fromAddress(a);
                            return (s.module ? s.module.name : "?") + "!" + (s.name || ("+0x" + s.offset.toString(16)));
                        });
                        console.log("[D] netbt " + frames.join(" <- "));
                    } catch (eBt) {}
                }
                var msg = this.context.x22;
                var ab = this.context.x1;
                // tid 先行: 命中我们任务的 ack 才走裸读分支
                var tid = 0;
                try { tid = msg.add(0x08).readU32(); } catch (eTid) { return; }
                // 墓碑机制: ack 命中不删登记只打标, mars 用同 taskid 重试的重复响应
                // 会被墓碑拦截静默丢弃——否则落入下方收消息分支(首字节 0x08 极常见)
                // 变幽灵来消息, bot 可能对自己的发送 ack 触发自动回复(评审发现)
                var entry = pendingBuf2RespTasks[tid];
                if (entry && entry.acked) {
                    return;
                }
                if (entry) {
                    entry.acked = true;
                    if (entry.timerId !== null) {
                        clearTimeout(entry.timerId);
                        entry.timerId = null;
                    }
                    // 墓碑保留 30s 吸收重试响应(与兜底路径保留窗口一致), 到期清除
                    setTimeout(function () {
                        if (pendingBuf2RespTasks[tid] === entry) delete pendingBuf2RespTasks[tid];
                    }, 30 * 1000);
                    // ack 数据必须裸读: 响应结构所在 malloc zone(0x33_...)对
                    // findRangeByAddress 不可见, 门控读全数误报空 → ack 被静默
                    // 吞掉(2026-09-21 实证: 文本两发+图片一发全部送达但 Go 侧
                    // "收到buf2resp" 零命中, 与 cndOnComplete 同一根因)
                    var dataPtr = ptr(0), dataLen = 0;
                    try {
                        var D = ab.readPointer();        // D = ab[0]
                        dataPtr = D.readPointer();        // data = D[0]
                        dataLen = D.add(0xc).readU32();
                    } catch (eD) {}
                    var ackData = null;
                    try {
                        if (!dataPtr.isNull() && dataLen > 0 && dataLen <= MAX_FRIDA_MESSAGE_BYTES) {
                            ackData = dataPtr.readByteArray(dataLen);
                        }
                    } catch (eR) {}
                    if (ackData) {
                        console.log("[+] V3 ack命中: tid=" + tid + " msgType=" + entry.msgType + " len=" + dataLen);
                        send({
                            type: "buf2resp",
                            msg_type: entry.msgType,
                            task_id: (entry.goTaskId !== undefined && entry.goTaskId !== null) ? String(entry.goTaskId) : "",   // Go 侧按 taskId 校验丢弃过期 ack; 空串=宽松放行
                            data: Array.from(new Uint8Array(ackData)),
                        });
                    } else {
                        // 数据读不出也放行(空数组): 任务已真实完成, 卡住不放
                        // Go 会假超时; 空 data Go 侧报错但流程收尾可见
                        console.log("[!] V3 ack命中但数据不可读: tid=" + tid + " msgType=" + entry.msgType +
                            " dataPtr=" + dataPtr + " len=" + dataLen);
                        send({
                            type: "buf2resp",
                            msg_type: entry.msgType,
                            task_id: (entry.goTaskId !== undefined && entry.goTaskId !== null) ? String(entry.goTaskId) : "",
                            data: [],
                        });
                    }
                    return;
                }
                // 非我们任务 → 收消息路径。必须裸读+try/catch, 不能走 IfReadable
                // 门控助手: 响应结构所在 0x33 malloc zone 对 findRangeByAddress
                // 不可见, 门控读全数误报空 → 收消息被静默吞掉(与 ack 分支/cnd
                // 完成结构同一坑, 2026-09-21 铁律; 门控版曾让稳态收发死诊断失真)
                var D = ptr(0), dataPtr = ptr(0), dataLen = 0;
                try {
                    D = ab.readPointer();        // D = ab[0]
                    dataPtr = D.readPointer();   // data = D[0]
                    dataLen = D.add(0xc).readU32();
                } catch (eD) { return; }
                if (dataLen < 4 || dataLen > MAX_FRIDA_MESSAGE_BYTES) {
                    return;
                }
                var mem = null;
                try { mem = dataPtr.readByteArray(dataLen); } catch (eR) {}
                if (!mem) {
                    return;
                }
                var uint8Array = new Uint8Array(mem);
                if (uint8Array[0] !== 0x08) {
                    return;
                }
                incomingTrafficSeen = true;
                send({
                    type: "protobuf_msg",
                    data: Array.from(uint8Array),
                });
            } catch (e) {
                // 热路径: 静默容错, 单条异常不能影响原生分发
            }
        }
    });
}

// req2bufExit后登记待ack任务: 命中buf2resp时清理指针并取消timer;
// 超时未命中则复原X24+0x60的原始指针(而不是清零/留着伪造结构体),
// 任务回到未注入的合法状态, mars无论重试重序列化还是超时回收delete都安全
// goTaskId = Go 侧任务号(V3 的登记键是 mars 分配的 nativeTaskId, 与 Go taskId
// 不同, 必须单独穿线), ack 转发时带给 Go 做关联校验, 丢弃迟到的过期 ack
function armPendingBuf2RespTask(taskId, addr, msgType, originalPtr, goTaskId) {
    pendingBuf2RespTasks[taskId] = {
        addr: addr,
        msgType: msgType,
        originalPtr: originalPtr || ptr(0),
        goTaskId: goTaskId,
        timerId: setTimeout(function () {
            fallbackCleanupPendingTask(taskId);
        }, PENDING_CLEANUP_TIMEOUT_MS),
    };
}

// ack命中: 取消timer并移除登记, 返回entry供调用方读取msgType
function finishPendingBuf2RespTask(taskId) {
    var entry = pendingBuf2RespTasks[taskId];
    if (!entry) {
        return null;
    }
    delete pendingBuf2RespTasks[taskId];
    if (entry.timerId !== null) {
        clearTimeout(entry.timerId);
        entry.timerId = null;
    }
    return entry;
}

// 超时兜底: 复原X24+0x60为原始消息指针(与成功路径写0不同, 此时任务
// 可能仍被mars重试, 必须留合法对象)。entry再保留30s, 迟到的ack
// 仍能匹配并把响应转发给Go (此时entry.addr已空, 只转发不再清理)
function fallbackCleanupPendingTask(taskId) {
    var entry = pendingBuf2RespTasks[taskId];
    if (!entry) {
        return;
    }
    entry.timerId = null;
    if (entry.addr.isNull()) {
        // 4.1.13(structVer=3): 节点已由 mars 原生 erase+delete, 没有需要复原的
        // 指针。entry 再保留 30s, 迟到的 ack 仍能匹配并把响应转发给 Go
        setTimeout(function () {
            // 已 acked 的墓碑由 resp-dispatch 自己的定时器到期清除, 别提前拆墓碑
            var e = pendingBuf2RespTasks[taskId];
            if (e && !e.acked) delete pendingBuf2RespTasks[taskId];
        }, 30 * 1000);
        return;
    }
    try {
        if (!entry.originalPtr.isNull()) {
            entry.addr.writePointer(entry.originalPtr);
            console.log("[!] buf2resp超时兜底: 已复原原始消息指针, msgType=" + entry.msgType + " taskId=" + taskId);
        } else {
            entry.addr.writeU64(0x0);
            console.log("[!] buf2resp超时兜底: 原始指针不可用, 已清零 insertMsgAddr, msgType=" + entry.msgType + " taskId=" + taskId);
        }
    } catch (e) {
        console.error("[!] buf2resp超时兜底清理失败: taskId=" + taskId + " err=" + e);
    }
    entry.addr = ptr(0);
    setTimeout(function () {
        delete pendingBuf2RespTasks[taskId];
    }, 30 * 1000);
}

// -------------------------Req2Buf公共部分分区-------------------------

// 4.1.13(structVer=3): V3 唯一 hook 点 = H found 路径 msg 装载指令的下一条
// (JSON mgrCaptureAddr=0x42e4c2c): ldr x22,[x25,#0x28] 刚执行完, x19=manager
// this。原生消息每次 pop 都经过这里, read-only 捕获 mgr 供 SubmitCgi 调用。
// not-found 路径不经过此 hook, 天然无感。其余一切(建 Task/insert/StartTask)
// 全部由 SubmitCgi 原生完成, 不再有序列化点 hook / msg 替换 / 手写红黑树。
// 入口 hook 禁区(attach 即崩原生流量, 2026-09-20 两次实锤): 0x42e48dc(H头)、
// 0x42e40e8(另一consumer); SubmitCgi 0x42e3450 本体只 call 不 hook。
// 运行时自适应: 从第一条真实 msg 抄字符串 cap/+0x2f 旗标(机械性字段跨消息类通用)。
// 背景: 2026-09-20 SubmitCgi 中途 AV 会跳过 unlock → mgr+0x80 锁永久毒死,
// 微信全部 CGI 卡死(看不到消息), 只能重启微信。伪造布局必须先对齐真货再放行。
var v3Observed = { capValid: false, cap: 0, flag: 0x80 };
function v3Hex16(addr, off) {
    try {
        return Array.from(new Uint8Array(addr.add(off).readByteArray(16)))
            .map(function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
    } catch (e) { return "unreadable"; }
}

function attachMgrCaptureV3() {
    if (mgrCaptureAddr.equals(ptr(0))) {
        console.error("[!] JSON 缺 mgrCaptureAddr, V3 无法捕获 manager, 发送不可用");
        return;
    }
    console.log("[+] Hooking mgr-capture V3 at: " + mgrCaptureAddr);
    Interceptor.attach(mgrCaptureAddr, {
        onEnter: function (args) {
            v3NoteValidTid(this.threadId);
            if (msgMapMgrGlobal.equals(ptr(0))) {
                msgMapMgrGlobal = this.context.x19;
                console.log("[+] V3: 捕获 msg-map manager = " + msgMapMgrGlobal);
            }
            // 运行时自适应(生产机制, 非探针): 从第一条真实 msg 抄字符串 cap/+0x2f
            // 旗标, 伪造 msg 照抄(见 applyV3MsgLayout); 观测失败走保守回退
            if (!v3Observed.capValid) {
                try {
                    var m = this.context.x22;
                    var capV = m.add(0x28).readU64();
                    var flagV = m.add(0x2f).readU8();
                    if (capV.toNumber() > 0 && (flagV & 0x80)) {
                        v3Observed.capValid = true;
                        v3Observed.cap = capV;
                        v3Observed.flag = flagV;
                        console.log("[+] V3 观测真实msg字符串布局: cap=0x" + capV.toString(16) + " flag=0x" + flagV.toString(16) + " (伪造msg将照抄)");
                    }
                } catch (e) { /* 未观测到走保守回退 */ }
            }
        }
    });
}

// SubmitCgi 入口出队点(三出队点之一): 微信自提交 CGI 时线程正处原生 SubmitCgi
// 上下文(TLS 齐备; 此时尚未拿锁, 内层提交完整走完返回后外层才继续, 无嵌套死锁)。
// 入口本体只挂这个 read-only 出队 hook, 不读不写任何参数。
function attachSubmitCgiDrainV3() {
    Interceptor.attach(req2bufEnterAddr, {
        onEnter: function (args) {
            drainPendingSubmitNative();
            v3NoteValidTid(this.threadId);
        }
    });
    console.log("[+] Hooking SubmitCgi 入口出队点(read-only)");
}

// 4.1.13(structVer=3) 长链 push 分发入口: mars/stn/stn.cc __OnPush(函数头 0x59b0e94,
// 字符串锚定 "task push name:%_, seq:%_, cmdid:%_, len:%_" @0x941e9d7 反查定位;
// 函数尾 ret@0x59b1188 六对寄存器存取与头完全对应, 边界已验证)。
// 签名(寄存器实证): (x0=ctx, x1=name std::string&, x2=seq, x3=cmdid,
// x4=body AutoBuffer&, x5=ext AutoBuffer&)。作用 ×2:
//   1) 收消息: 登录后短链 CGI 窗口关闭, newsync 全部以长链 push 到达——此处是
//      稳态唯一收消息口(2026-09-21 短链/长链窗口根因, 三个短链出队点全饿死的原因)
//   2) 第 4 出队点: push 到达=网络线程事件, 线程身份与 A/B 回溯链同源(TLS 齐备)
// 入口 hook(函数第一条 stp), read-only, 不碰 push 派发对象; body 裸读(0x33 zone 铁律)。
var v3PushLogN = 0;
function attachOnPushV3() {
    if (onPushAddr.equals(ptr(0))) {
        console.error("[!] JSON 缺 onPushAddr, V3 稳态收消息不可用(仅短链窗口期收发可用)");
        return;
    }
    console.log("[+] Hooking OnPush V3 at: " + onPushAddr);
    Interceptor.attach(onPushAddr, {
        onEnter: function (args) {
            // 长链 push 到达 = 网络线程事件, 第 4 出队点(稳态出队主泵)
            drainPendingSubmitNative();
            v3NoteValidTid(this.threadId);
            // push body = x4 (AutoBuffer&): D=ab[0], data=D[0], len=D+0xc(u32)
            // 与 resp-dispatch ack 分支同款裸读
            try {
                var ab = this.context.x4;
                var D = ab.readPointer();
                var dataPtr = D.readPointer();
                var dataLen = D.add(0xc).readU32();
                if (dataLen < 4 || dataLen > MAX_FRIDA_MESSAGE_BYTES) {
                    return;
                }
                if (v3PushLogN < 5) {
                    v3PushLogN++;
                    console.log("[+] V3 OnPush 命中: cmdid=" + this.context.x3 + " len=" + dataLen);
                }
                var mem = null;
                try { mem = dataPtr.readByteArray(dataLen); } catch (eR) { return; }
                if (!mem) {
                    return;
                }
                var uint8Array = new Uint8Array(mem);
                if (uint8Array[0] !== 0x08) {
                    return;
                }
                incomingTrafficSeen = true;
                send({
                    type: "protobuf_msg",
                    data: Array.from(uint8Array),
                });
            } catch (e) {
                // 热路径静默容错: 单条异常不能影响原生 push 分发
            }
        }
    });
}

// [已废弃] cmdid 注册表分发探针(0x4320b40): 收消息候选路由排查期探针,
// resp-dispatch(0x42e5044) 实证为收发统一分发点后删除(2026-09-21)。

function attachReq2buf() {
    if (structVer === "3") {
        attachMgrCaptureV3();
        attachRespDispatchV3();
        attachSubmitCgiDrainV3();
        attachOnPushV3();
        return;
    }
    Interceptor.attach(req2bufEnterAddr, {
        onEnter: function (args) {
            if (!this.context.x1.equals(taskIdGlobal)) {
                return;
            }

            const x24_base = this.context.x24;
            insertMsgAddr = x24_base.add(0x60);
            // 保存hook前的原始消息指针(校验过可读), 超时兜底时复原,
            // 让任务回到未注入的合法状态, mars重试/回收/delete都不会踩到伪造结构体
            originalInsertMsgPtr = readPointerIfReadable(insertMsgAddr);

            if (sendMsgType === "text") {
                insertMsgAddr.writePointer(sendTextMessageAddr);
                console.log("[+] 发送文本消息成功! Req2Buf 已将 X24+0x60 指向新地址: " + sendTextMessageAddr +
                    "[+] Req2Buf 写入后内存预览: " + insertMsgAddr);
            } else if (sendMsgType === "img") {
                insertMsgAddr.writePointer(sendImgMessageAddr);
                console.log("[+] 发送图片消息成功! Req2Buf 已将 X24+0x60 指向新地址: " + sendImgMessageAddr +
                    "[+] Req2Buf 写入后内存预览: " + insertMsgAddr);
            } else if (sendMsgType === "video") {
                insertMsgAddr.writePointer(sendVideoMessageAddr);
                console.log("[+] 发送视频消息成功! Req2Buf 已将 X24+0x60 指向新地址: " + sendVideoMessageAddr +
                    "[+] Req2Buf 写入后内存预览: " + insertMsgAddr);
            } else if (sendMsgType === "reply") {
                insertMsgAddr.writePointer(sendReplyMessageAddr);
                console.log("[+] 发送回复消息成功! Req2Buf 已将 X24+0x60 指向新地址: " + sendReplyMessageAddr +
                    "[+] Req2Buf 写入后内存预览: " + insertMsgAddr);
            } else if (sendMsgType === "voice") {
                insertMsgAddr.writePointer(sendVoiceMessageAddr);
                console.log("[+] 发送语音消息成功! Req2Buf 已将 X24+0x60 指向新地址: " + sendVoiceMessageAddr +
                    "[+] Req2Buf 写入后内存预览: " + insertMsgAddr);
            } else if (sendMsgType === "file") {
                insertMsgAddr.writePointer(sendFileMessageAddr);
                console.log("[+] 发送文件消息成功! Req2Buf 已将 X24+0x60 指向新地址: " + sendFileMessageAddr +
                    "[+] Req2Buf 写入后内存预览: " + insertMsgAddr);
            } else if (sendMsgType === "fileupload") {
                insertMsgAddr.writePointer(sendFileUploadMessageAddr);
                console.log("[+] 发送fileUploadMsg成功! Req2Buf 已将 X24+0x60 指向新地址: " + sendFileUploadMessageAddr +
                    "[+] Req2Buf 写入后内存预览: " + insertMsgAddr);
            } else if (sendMsgType === "appattach") {
                insertMsgAddr.writePointer(sendAppAttachMessageAddr);
                console.log("[+] 发送uploadAppAttach成功! Req2Buf 已将 X24+0x60 指向新地址: " + sendAppAttachMessageAddr +
                    "[+] Req2Buf 写入后内存预览: " + insertMsgAddr);
            }
        }
    });

    // 在出口处拦截req2buf，记录insertMsgAddr等buf2resp回调后再清理
    Interceptor.attach(req2bufExitAddr, {
        onEnter: function (args) {
            if (!this.context.x25.equals(taskIdGlobal)) {
                return;
            }
            // 不立即清除insertMsgAddr，让mars能路由buf2resp回调
            // 用fakeVtable保护结构体，防止中间被访问时崩溃
            // 登记任务并挂超时兜底timer: ack超时则复原X24+0x60原始指针
            armPendingBuf2RespTask(taskIdGlobal, insertMsgAddr, sendMsgType, originalInsertMsgPtr, taskIdGlobal);
            taskIdGlobal = 0;
        }
    });
}


// -------------------------Req2Buf公共部分分区-------------------------

// -------------------------发送图片消息分区-------------------------

// 初始化进行内存的分配
function setupSendImgMessageDynamic() {

    // 1. 动态分配内存块（按需分配大小）
    // 分配原则：字符串给 64-128 字节，结构体按实际大小分配
    imgCgiAddr = Memory.alloc(128);
    sendImgMessageAddr = Memory.alloc(256);
    imgMessageAddr = Memory.alloc(256);
    uploadFunc1Addr = Memory.alloc(24);
    uploadFunc2Addr = Memory.alloc(24);
    uploadCallback = Memory.alloc(128);
    imageIdAddr = Memory.alloc(256);
    md5Addr = Memory.alloc(256);
    uploadAesKeyAddr = Memory.alloc(256);
    ImagePathAddr1 = Memory.alloc(256);
    uploadImageX1 = Memory.alloc(1024);

    // 图片数据写入
    patchString(imgCgiAddr, "/cgi-bin/micromsg-bin/uploadmsgimg");

    sendImgMessageAddr.add(0x00).writeU64(0);
    sendImgMessageAddr.add(0x08).writeU64(0);
    sendImgMessageAddr.add(0x10).writeU64(0);
    sendImgMessageAddr.add(0x18).writeU64(1);
    sendImgMessageAddr.add(0x20).writeU32(taskIdGlobal);
    sendImgMessageAddr.add(0x28).writePointer(imgMessageAddr);

    imgMessageAddr.add(0x00).writePointer(fakeVtable);
    imgMessageAddr.add(0x08).writeU32(taskIdGlobal);
    imgMessageAddr.add(0x0c).writeU32(0x6e);
    imgMessageAddr.add(0x10).writeU64(0x3);
    imgMessageAddr.add(0x18).writePointer(imgCgiAddr);
    imgMessageAddr.add(0x20).writeU64(0x22);
    imgMessageAddr.add(0x28).writeU64(uint64("0x8000000000000030"));
    imgMessageAddr.add(0x30).writeU64(uint64("0x0000000001010100"));

    // 视频数据写入
    videoCgiAddr = Memory.alloc(128);
    sendVideoMessageAddr = Memory.alloc(256);
    videoMessageAddr = Memory.alloc(256);
    videoIdAddr = Memory.alloc(256);
    videoPathAddr1 = Memory.alloc(256);
    uploadVideoX1 = Memory.alloc(1024);

    patchString(videoCgiAddr, "/cgi-bin/micromsg-bin/uploadvideo");

    sendVideoMessageAddr.add(0x00).writeU64(0);
    sendVideoMessageAddr.add(0x08).writeU64(0);
    sendVideoMessageAddr.add(0x10).writeU64(0);
    sendVideoMessageAddr.add(0x18).writeU64(1);
    sendVideoMessageAddr.add(0x20).writeU32(taskIdGlobal);
    sendVideoMessageAddr.add(0x28).writePointer(videoMessageAddr);

    videoMessageAddr.add(0x00).writePointer(fakeVtable);
    videoMessageAddr.add(0x08).writeU32(taskIdGlobal);
    videoMessageAddr.add(0x0c).writeU32(0x6e);
    videoMessageAddr.add(0x10).writeU64(0x3);
    videoMessageAddr.add(0x18).writePointer(videoCgiAddr);
    videoMessageAddr.add(0x20).writeU64(0x21);
    videoMessageAddr.add(0x28).writeU64(uint64("0x8000000000000030"));
    videoMessageAddr.add(0x30).writeU64(uint64("0x0000000001010100"));

    // 语音数据写入
    voiceCgiAddr = Memory.alloc(128);
    sendVoiceMessageAddr = Memory.alloc(256);
    voiceMessageAddr = Memory.alloc(256);
    voiceIdAddr = Memory.alloc(256);
    voicePathAddr1 = Memory.alloc(256);
    uploadVoiceX1 = Memory.alloc(1024);
    voiceAudioDataAddr = Memory.alloc(5 * 1024 * 1024); // 预分配5MB

    patchString(voiceCgiAddr, "/cgi-bin/micromsg-bin/uploadvoice");

    sendVoiceMessageAddr.add(0x00).writeU64(0);
    sendVoiceMessageAddr.add(0x08).writeU64(0);
    sendVoiceMessageAddr.add(0x10).writeU64(0);
    sendVoiceMessageAddr.add(0x18).writeU64(1);
    sendVoiceMessageAddr.add(0x20).writeU32(taskIdGlobal);
    sendVoiceMessageAddr.add(0x28).writePointer(voiceMessageAddr);

    voiceMessageAddr.add(0x00).writePointer(fakeVtable);
    voiceMessageAddr.add(0x08).writeU32(taskIdGlobal);
    voiceMessageAddr.add(0x0c).writeU32(0x6e);
    voiceMessageAddr.add(0x10).writeU64(0x3);
    voiceMessageAddr.add(0x18).writePointer(voiceCgiAddr);
    voiceMessageAddr.add(0x20).writeU64(0x21);
    voiceMessageAddr.add(0x28).writeU64(uint64("0x8000000000000030"));
    voiceMessageAddr.add(0x30).writeU64(uint64("0x0000000001010100"));
}



// -------------------------4.1.13 msg-map 原生插入分区(已废弃)-------------------------
// 手写红黑树 insert 方案已被 SubmitCgi 零伪造范式取代(2026-09-20):
// SubmitCgi 原生完成 insert, 无需也不应手工插节点。历史结论存档见
// docs/4.1.13-submitcgi-analysis.md。

function triggerSendMediaMessage(taskId, sender, receiver, protoHex, payloadHex, msgType) {
    if (!taskId || !receiver) {
        console.error("[!] " + msgType + ": taskId or receiver is empty!");
        return "fail";
    }

    var msgAddrInfo = {
        "text":  { messageAddr: textMessageAddr,  sendMessageAddr: sendTextMessageAddr,  cgiAddr: textCgiAddr,  uri: "/cgi-bin/micromsg-bin/newsendmsg",      protoHexSetter: function(h) { textProtoHexGlobal = h; } },
        "img":   { messageAddr: imgMessageAddr,   sendMessageAddr: sendImgMessageAddr,   cgiAddr: imgCgiAddr,   uri: "/cgi-bin/micromsg-bin/uploadmsgimg",     protoHexSetter: function(h) { imgProtoHexGlobal = h; } },
        "video": { messageAddr: videoMessageAddr, sendMessageAddr: sendVideoMessageAddr, cgiAddr: videoCgiAddr, uri: "/cgi-bin/micromsg-bin/uploadvideo",       protoHexSetter: function(h) { videoProtoHexGlobal = h; } },
        "reply": { messageAddr: replyMessageAddr, sendMessageAddr: sendReplyMessageAddr, cgiAddr: replyCgiAddr, uri: "/cgi-bin/micromsg-bin/sendappmsg",        protoHexSetter: function(h) { replyProtoHexGlobal = h; } },
        "voice": { messageAddr: voiceMessageAddr, sendMessageAddr: sendVoiceMessageAddr, cgiAddr: voiceCgiAddr, uri: "/cgi-bin/micromsg-bin/uploadvoice",       protoHexSetter: function(h) { voiceProtoHexGlobal = h; } },
        "file":  { messageAddr: fileMessageAddr,  sendMessageAddr: sendFileMessageAddr,  cgiAddr: fileCgiAddr,  uri: "/cgi-bin/micromsg-bin/sendappmsg",        protoHexSetter: function(h) { fileProtoHexGlobal = h; } },
        "fileupload": { messageAddr: fileUploadMessageAddr, sendMessageAddr: sendFileUploadMessageAddr, cgiAddr: fileUploadCgiAddr, uri: "/cgi-bin/micromsg-bin/sendfileuploadmsg", protoHexSetter: function(h) { fileUploadProtoHexGlobal = h; } },
        "appattach": { messageAddr: appAttachMessageAddr, sendMessageAddr: sendAppAttachMessageAddr, cgiAddr: appAttachCgiAddr, uri: "/cgi-bin/micromsg-bin/uploadappattach", protoHexSetter: function(h) { appAttachProtoHexGlobal = h; } },
    };

    var info = msgAddrInfo[msgType];
    if (!info) {
        console.error("[!] unknown msgType: " + msgType);
        return "fail";
    }

    // 4.1.13(structVer=3): SubmitCgi 零伪造路径, 微信自建 Task/insert/StartTask
    if (structVer === "3") {
        return submitViaSubmitCgi(info, msgType, protoHex, taskId);
    }

    if (!triggerX0 || !triggerX1Payload) {
        console.error("[!] triggerX0 或 triggerX1Payload 尚未初始化，请等待 hook 捕获");
        return "fail";
    }

    info.protoHexSetter(protoHex);
    taskIdGlobal = taskId;

    info.messageAddr.add(0x08).writeU32(taskIdGlobal);
    info.sendMessageAddr.add(0x20).writeU32(taskIdGlobal);

    const payloadData = hexToByteArray(payloadHex);
    // 先恢复完整任务结构快照(重建合法回调子对象, free 残骸的野回调指针会崩)
    if (triggerTaskSnapshot) {
        triggerX1Payload.writeByteArray(triggerTaskSnapshot);
    }
    triggerX1Payload.writeByteArray(payloadData);
    triggerX1Payload.add(0x18).writePointer(info.cgiAddr);
    triggerX1Payload.add(0xb8).writePointer(triggerX1Payload.add(0xc0));
    triggerX1Payload.add(0x190).writePointer(triggerX1Payload.add(0x198));
    sendMsgType = msgType;

    const MMStartTask = new NativeFunction(sendFuncAddr, 'int64', ['pointer', 'pointer']);

    try {
        MMStartTask(triggerX0, triggerX1Payload);
        return "1";
    } catch (e) {
        console.error("[!] Error trigger " + msgType + " MMStartTask: " + e);
        return "fail";
    }
}

function triggerSendImgMessage(taskId, sender, receiver, protoHex, payloadHex) {
    return triggerSendMediaMessage(taskId, sender, receiver, protoHex, payloadHex, "img");
}

function triggerSendVideoMessage(taskId, sender, receiver, protoHex, payloadHex) {
    return triggerSendMediaMessage(taskId, sender, receiver, protoHex, payloadHex, "video");
}


function triggerUploadImg(receiver, md5, imagePath, payloadHex) {
    return fillUploadX1AndStart(imageIdAddr, ImagePathAddr1, uploadImageX1, receiver, md5, imagePath, payloadHex);
}

function triggerUploadVideo(receiver, md5, videoPath, payloadHex) {
    return fillUploadX1AndStart(videoIdAddr, videoPathAddr1, uploadVideoX1, receiver, md5, videoPath, payloadHex);
}

function triggerUploadVoice(receiver, voicePath, payloadHex, audioDataHex, durationMs) {
    if (uploadGlobalX0.equals(ptr(0))) {
        ensureCdnManagerX0();
    }
    if (uploadGlobalX0.equals(ptr(0))) {
        console.error("[!] uploadGlobalX0 尚未初始化，请等待 hook 捕获");
        return "fail";
    }

    voiceDurationGlobal = durationMs;
    const payload = hexToByteArray(payloadHex);

    // 解码音频二进制数据，写入预分配的5MB内存
    const audioBytes = hexToByteArray(audioDataHex);
    const audioLen = audioBytes.length;
    voiceSilkDataLenGlobal = audioLen;
    voiceAudioDataAddr.writeByteArray(audioBytes);

    const voiceIdStr = receiver + "_" + String(Math.floor(Date.now() / 1000)) + "_" + Math.floor(Math.random() * 1001) + "_1";
    patchString(voiceIdAddr, voiceIdStr);
    patchString(voicePathAddr1, voicePath);

    uploadVoiceX1.writeByteArray(payload);
    uploadVoiceX1.writePointer(uploadFunc1Addr);
    uploadVoiceX1.add(0x08).writePointer(uploadFunc2Addr);
    uploadVoiceX1.add(0x48).writePointer(voiceIdAddr);
    uploadVoiceX1.add(0x50).writeU64(voiceIdStr.length);
    uploadVoiceX1.add(0x58).writeU64(uint64("0x8000000000000000").add(voiceIdStr.length + 1));
    uploadVoiceX1.add(0x68).writeUtf8String(receiver);
    // 音频二进制数据: 0x100=指针, 0x108=长度, 0x110=容量(长度+1)|高位
    uploadVoiceX1.add(0x100).writePointer(voiceAudioDataAddr);
    uploadVoiceX1.add(0x108).writeU64(audioLen);
    uploadVoiceX1.add(0x110).writeU64(uint64("0x8000000000000000").add(audioLen + 1));

    const startUploadMedia = new NativeFunction(uploadImageAddr, 'int64', ['pointer', 'pointer']);

    return startUploadMedia(uploadGlobalX0, uploadVoiceX1);
}

function attachUploadMedia() {
    Interceptor.attach(uploadImageAddr.add(0x10), {
        onEnter: function (args) {
			uploadGlobalX0 = this.context.x0;
			if (!downloadGlobalX0) {
				// 上传/下载共用同一 mars::cdn::CdnManager 单例, 顺手回填
				downloadGlobalX0 = this.context.x0;
				console.log("[+] 上传hook回填 downloadGlobalX0: " + downloadGlobalX0);
			}
		}
    })
}



// 视频上传成功钥匙缓存: cdnKey -> { aesKey, md5Key, videoId }
// CDN 秒传去重的响应不带 aesKey, 按 cdnKey 命中回填 (见 patchCdnOnComplete)
var cdnVideoKeyCache = {};

// Go 启动时回灌持久化(./cdn_video_keys.json)的钥匙, 解决缓存跨进程丢失:
// onebot 重启后同一视频首次上传必撞秒传去重(响应无 aesKey), 内存缓存为空
// 就只能 abort → send timeout (2026-09-07 四次实锤)
function hydrateCdnVideoCache(jsonStr) {
    var persisted = JSON.parse(jsonStr);
    var n = 0;
    for (var k in persisted) {
        if (persisted.hasOwnProperty(k) && persisted[k] && persisted[k].aesKey && !cdnVideoKeyCache[k]) {
            cdnVideoKeyCache[k] = persisted[k];
            n++;
        }
    }
    console.log("[+] hydrateCdnVideoCache: 回灌 " + n + " 条视频钥匙");
    return n;
}

// 4.1.13(structVer=3) CDN 完成结构自动定位: 老偏移 +0x20 读出 null
// (2026-09-21 媒体验收首发实证), 完成结构再漂移(4.1.11→12 曾 +0x08)。
// 锚 = 我们生成的 fileId(全局唯一串); 扫 x2+0x00..0x160 命中后按 4.1.11
// 相对布局(target/cdn/aes/md5 = fileId+0x20/+0x40/+0x58/+0x70)平移推算,
// 逐槽内容验证(32-hex / ==receiver), 全过才缓存偏移 —— 运行时一次定位,
// 不赌静态偏移, 也不为 DIAG 多烧一次 gadget 会话。
var v3CndOff = null;
// 槽位读串, 三种编码全兜(2026-09-21 cndScan 实证: 4.1.13 槽里是内联 std::string
// 对象 {char*@0, size@8, cap|flag@0x10}, 不再是裸 char*):
// (a) 槽=char*(或内联string对象的ptr字段): 解一层读字符
// (b) 槽=string对象指针: 解两层
// (c) 槽本身=内联SSO串(4.1.11 targetId/4.1.13 +0x48 即此)
// ⚠️ 必须裸读+try/catch, 不能走 IfReadable 门控助手: 完成结构所在的
// 0x33_00000000 malloc zone 对 findRangeByAddress 不可见, 门控全数误报空
// (与 submitViaSubmitCgi readback 注释同一坑, 2026-09-21 二次实锤)
function v3ReadStr(base, off) {
    var slot = base.add(off);
    try {
        var p = slot.readPointer();
        if (!p.isNull()) {
            try { var sa = p.readUtf8String(); if (sa && sa.length > 0) return sa; } catch (e1) {}
            try { var sb = p.readPointer().readUtf8String(); if (sb && sb.length > 0) return sb; } catch (e2) {}
        }
    } catch (e0) {}
    try { var sc = slot.readUtf8String(); if (sc && sc.length > 0) return sc; } catch (e3) {}
    return "";
}
function v3LocateCndOffsets(x2, expected) {
    var fidOff = -1;
    var matchedFid = "";
    for (var off = 0x00; off <= 0x160; off += 8) {
        var s = v3ReadStr(x2, off);
        if (!s || s.length === 0) continue;
        if (fidOff < 0 && expected[s]) { fidOff = off; matchedFid = s; }
    }
    if (fidOff < 0) return null;
    // receiver 从命中的完整 fileId 剥后缀得出(格式 receiver_<ts>_<rand>_1)。
    // 不能用 split("_")[0]: wxid_ 前缀的接收者自带下划线会被截成 "wxid",
    // tgt===receiver 永远 false → wxid 个人会话媒体发送全灭(2026-09-21 评审发现;
    // 验收期目标是 ludaohe/群, 无下划线恰好不触发)
    var receiver = matchedFid.replace(/_\d+_\d+_1$/, "");
    var delta = fidOff - 0x20;
    var cand = { fileId: fidOff, target: 0x40 + delta, cdn: 0x60 + delta, aes: 0x78 + delta, md5: 0x90 + delta };
    var tgt = v3ReadStr(x2, cand.target);
    var cdn = v3ReadStr(x2, cand.cdn);
    var aes = v3ReadStr(x2, cand.aes);
    var md5 = v3ReadStr(x2, cand.md5);
    var hexish = function (t) { return t && /^[0-9a-f]{16,64}$/.test(t); };
    var ok = tgt === receiver && cdn && cdn.length >= 8 && hexish(aes) && hexish(md5);
    console.log((ok ? "[+] cnd定位成功(全槽验证通过): " : "[!] cnd定位验证失败: ") +
        "delta=0x" + delta.toString(16) + " target=" + tgt + " cdn=" + cdn + " aes=" + aes + " md5=" + md5);
    return ok ? cand : null;
}
function cndOnCompleteV3(x2) {
    const imageFileId = imageIdAddr.readUtf8String();
    const videoFileId = videoIdAddr.readUtf8String();
    const voiceFileId = voiceIdAddr.readUtf8String();
    const fileUploadFileId = uploadFileIdAddr.readUtf8String();
    var expected = {};
    if (imageFileId) expected[imageFileId] = "img";
    if (videoFileId) expected[videoFileId] = "video";
    if (voiceFileId) expected[voiceFileId] = "voice";
    if (fileUploadFileId && fileUploadFileId !== "file_upload_not_init") expected[fileUploadFileId] = "fileUpload";
    if (v3CndOff === null) {
        v3CndOff = v3LocateCndOffsets(x2, expected);
    }
    if (!v3CndOff) return;
    const currentFileId = v3ReadStr(x2, v3CndOff.fileId);
    var kind = expected[currentFileId];
    if (!kind) return; // 非我们发起的 CDN 任务
    const cdnKey = v3ReadStr(x2, v3CndOff.cdn);
    const aesKey = v3ReadStr(x2, v3CndOff.aes);
    const md5Key = v3ReadStr(x2, v3CndOff.md5);
    const targetId = v3ReadStr(x2, v3CndOff.target);
    // videoId 字段 4.1.12 已消失, 4.1.13 未观测; proto3 空 bytes 省略, 服务端
    // ack 实证(4.1.12)。videoId || "" 兜底防 Go panic
    const videoId = "";

    console.log("cndOnComplete(V3) x2: " + x2 + " kind=" + kind + " cdnKey: " + cdnKey +
        " aesKey: " + aesKey + " md5Key: " + md5Key + " targetId: " + targetId);

    if (cdnKey !== "" && cdnKey != null && aesKey !== "" && aesKey != null) {
        if (kind === "voice") {
            send({ type: "upload_voice_finish", target_id: targetId, cdn_key: cdnKey, aes_key: aesKey,
                voice_duration: voiceDurationGlobal, silk_data_len: voiceSilkDataLenGlobal });
        } else if (kind === "fileUpload") {
            send({ type: "upload_file_finish", target_id: targetId, cdn_key: cdnKey, aes_key: aesKey,
                md5_key: md5Key, attach_id: "@cdn_" + cdnKey + "_" + aesKey + "_1",
                file_upload_token: "", overwrite_msg_id: "" });
        } else if (kind === "video") {
            cdnVideoKeyCache[cdnKey] = { aesKey: aesKey, md5Key: md5Key, videoId: videoId || "" };
            send({ type: "upload_video_finish", target_id: targetId, cdn_key: cdnKey, aes_key: aesKey,
                md5_key: md5Key, video_id: videoId || "" });
        } else {
            send({ type: "upload_image_finish", target_id: targetId, cdn_key: cdnKey,
                aes_key: aesKey, md5_key: md5Key });
        }
    } else if (kind === "video" && cdnKey !== "" && cdnKey != null && cdnVideoKeyCache[cdnKey]) {
        // CDN 秒传去重: 响应不带 aesKey, 按 cdnKey 回填缓存钥匙(2026-08-27 实锤)
        var cached = cdnVideoKeyCache[cdnKey];
        console.log("[+] cndOnComplete(V3) 秒传命中, 回填缓存钥匙 cdnKey: " + cdnKey);
        send({ type: "upload_video_finish", target_id: targetId, cdn_key: cdnKey,
            aes_key: cached.aesKey, md5_key: cached.md5Key, video_id: cached.videoId || "" });
    } else {
        console.error("cdnKey or aesKey 为空(V3)");
    }
}

function patchCdnOnComplete() {
    Interceptor.attach(cndOnCompleteAddr, {
        onEnter: function (args) {

            try {
                const x2 = this.context.x2;
                if (structVer === "3") {
                    cndOnCompleteV3(x2);
                    return;
                }
                // 4.1.12(structVer=2): 完成结构整体 +0x08 (DIAG 实证: fileId 0x20→0x28,
                // cdnKey 0x60→0x68, aesKey 0x78→0x80, md5Key 0x90→0x98, targetId 0x40→0x48);
                // 且 videoId 字段整个消失(宽扫 0x00-0x260 无候选, 见 docs/version-upgrade.md
                // 铁律9), structVer=2 直接传空串
                const cndShift = (structVer === "2") ? 0x08 : 0;
                const currentFileId = x2.add(0x20 + cndShift).readPointer().readUtf8String();
                const imageFileId = imageIdAddr.readUtf8String();
                const videoFileId = videoIdAddr.readUtf8String();
                const voiceFileId = voiceIdAddr.readUtf8String();
                const fileUploadFileId = uploadFileIdAddr.readUtf8String();
                if (currentFileId !== imageFileId && currentFileId !== videoFileId && currentFileId !== voiceFileId && currentFileId !== fileUploadFileId) {
                    console.log("[-] CndOnComplete x2: " + x2 + " currentFileId: " + currentFileId +
                        " imageFileId: " + imageFileId + " videoFileId:" + videoFileId + " voiceFileId:" + voiceFileId + " fileUploadFileId:" + fileUploadFileId);
                    return;
                }

                const cdnKey = x2.add(0x60 + cndShift).readPointer().readUtf8String();
                const aesKey = x2.add(0x78 + cndShift).readPointer().readUtf8String();
                const md5Key = x2.add(0x90 + cndShift).readPointer().readUtf8String();
                const videoId = (structVer === "2") ? "" : x2.add(0xf0).readPointer().readUtf8String();
                const targetId = x2.add(0x40 + cndShift).readUtf8String();

                console.log("cndOnComplete x2: " + x2 + " cdnKey: " + cdnKey + " aesKey: " + aesKey + " md5Key: " + md5Key + " videoId: " + videoId + " targetId: " + targetId);

                if (cdnKey !== "" && cdnKey != null && aesKey !== "" && aesKey != null) {

                    // 判断是语音、视频、文件还是图片
                    if (currentFileId === voiceFileId) {
                        // 语音
                        send({
                            type: "upload_voice_finish",
                            target_id: targetId,
                            cdn_key: cdnKey,
                            aes_key: aesKey,
                            voice_duration: voiceDurationGlobal,
                            silk_data_len: voiceSilkDataLenGlobal
                        });
                    } else if (currentFileId === fileUploadFileId) {
                        // 文件
                        var attachId = "@cdn_" + cdnKey + "_" + aesKey + "_1";
                        send({
                            type: "upload_file_finish",
                            target_id: targetId,
                            cdn_key: cdnKey,
                            aes_key: aesKey,
                            md5_key: md5Key,
                            attach_id: attachId,
                            file_upload_token: "",
                            overwrite_msg_id: ""
                        });
                    } else if (currentFileId === videoFileId) {
                        // 视频: 缓存成功上传的钥匙, 供秒传去重时回填
                        // videoId || "" 兜底: null 会让 Go 侧 videoId.(string) panic
                        // (被 main.go recover 吞掉, 表现为 HTTP 超时假象); proto3 空 bytes
                        // 字段会被省略, 4.1.12 实测服务端 ack、视频可播放
                        cdnVideoKeyCache[cdnKey] = { aesKey: aesKey, md5Key: md5Key, videoId: videoId || "" };
                        send({
                            type: "upload_video_finish",
                            target_id: targetId,
                            cdn_key: cdnKey,
                            aes_key: aesKey,
                            md5_key: md5Key,
                            video_id: videoId || ""
                        });
                    } else {
                        // 图片
                        send({
                            type: "upload_image_finish",
                            target_id: targetId,
                            cdn_key: cdnKey,
                            aes_key: aesKey,
                            md5_key: md5Key
                        });
                    }
                } else if (currentFileId === videoFileId && cdnKey !== "" && cdnKey != null && cdnVideoKeyCache[cdnKey]) {
                    // CDN 秒传去重: 同一视频重复上传时服务端直接返回已有 filekey
                    // (cdnKey 相同), 但响应不带 aesKey/md5Key (2026-08-27 先发个人再发群,
                    // 群发送三次全部死在 "cdnKey or aesKey 为空")。文件就是上次我们自己传的,
                    // 回填缓存钥匙即可正确解密; videoId 优先用本次响应里的(秒传响应会带)。
                    var cached = cdnVideoKeyCache[cdnKey];
                    console.log("[+] cndOnComplete 秒传命中, 回填缓存钥匙 cdnKey: " + cdnKey);
                    send({
                        type: "upload_video_finish",
                        target_id: targetId,
                        cdn_key: cdnKey,
                        aes_key: cached.aesKey,
                        md5_key: cached.md5Key,
                        video_id: (videoId !== "" && videoId != null) ? videoId : (cached.videoId || "")
                    });
                } else {
                    console.error("cdnKey or aesKey 为空");
                }
            } catch (e) {
                console.error("[-] CdnOnComplete error: " + e);
            }
        }
    });
}


function attachGetCallbackFromWrapper() {
    Interceptor.attach(uploadGetCallbackWrapperAddr, {
        onEnter: function (args) {
            try {
                const tmpFileId = this.context.x1.readPointer().readUtf8String();
                const imageFileId = imageIdAddr.readUtf8String();
                const videoFileId = videoIdAddr.readUtf8String();
                const voiceFileId = voiceIdAddr.readUtf8String();
                const fileUploadFileId = uploadFileIdAddr.readUtf8String();
                if (tmpFileId !== imageFileId && tmpFileId !== videoFileId && tmpFileId !== voiceFileId && tmpFileId !== fileUploadFileId) {
                    console.log("[+] GetCallbackFromWrapper tmpFileId: " + tmpFileId + " imageFileId: " + imageFileId + " videoFileId:" + videoFileId + " voiceFileId:" + voiceFileId + " fileUploadFileId:" + fileUploadFileId);
                    return
                }

                uploadCallback.add(0x10).writePointer(uploadGetCallbackWrapperFuncAddr);
                this.context.x8 = uploadCallback;
            } catch (e) {
                console.error("[-] GetCallbackFromWrapper error: " + e);
            }
        }
    })

    Interceptor.attach(uploadOnCompleteAddr, {
        onEnter: function (args) {
            try {
                const tmpFileId = this.context.x1.readPointer().readUtf8String();
                const imageFileId = imageIdAddr.readUtf8String();
                const videoFileId = videoIdAddr.readUtf8String();
                const voiceFileId = voiceIdAddr.readUtf8String();
                const fileUploadFileId = uploadFileIdAddr.readUtf8String();
                if (tmpFileId !== imageFileId && tmpFileId !== videoFileId && tmpFileId !== voiceFileId && tmpFileId !== fileUploadFileId) {
                    console.log("[+] OnComplete tmpFileId: " + tmpFileId + " imageFileId: " + imageFileId + " videoFileId:" + videoFileId + " voiceFileId:" + voiceFileId + " fileUploadFileId:" + fileUploadFileId);
                    return
                }

                uploadCallback.add(0x30).writePointer(uploadOnCompleteFuncAddr);
                this.context.x8 = uploadCallback;
            } catch (e) {
                console.error("[-] OnComplete error: " + e);
            }
        }
    })
}


// -------------------------发送回复消息分区-------------------------
function setupSendReplyMessageDynamic() {
    replyCgiAddr = Memory.alloc(128);
    sendReplyMessageAddr = Memory.alloc(256);
    replyMessageAddr = Memory.alloc(256);

    patchString(replyCgiAddr, "/cgi-bin/micromsg-bin/sendappmsg");

    sendReplyMessageAddr.add(0x00).writeU64(0);
    sendReplyMessageAddr.add(0x08).writeU64(0);
    sendReplyMessageAddr.add(0x10).writeU64(0);
    sendReplyMessageAddr.add(0x18).writeU64(1);
    sendReplyMessageAddr.add(0x20).writeU32(taskIdGlobal);
    sendReplyMessageAddr.add(0x28).writePointer(replyMessageAddr);

    replyMessageAddr.add(0x00).writePointer(fakeVtable);
    replyMessageAddr.add(0x08).writeU32(taskIdGlobal);
    replyMessageAddr.add(0x0c).writeU32(0x6e);
    replyMessageAddr.add(0x10).writeU64(0x3);
    replyMessageAddr.add(0x18).writePointer(replyCgiAddr);
    replyMessageAddr.add(0x20).writeU64(0x20);
    replyMessageAddr.add(0x28).writeU64(uint64("0x8000000000000030"));
    replyMessageAddr.add(0x30).writeU64(uint64("0x0000000001010100"));

    console.log("[+] Reply message setup complete. CgiAddr: " + replyCgiAddr + " SendAddr: " + sendReplyMessageAddr);
}


function triggerSendReplyMessage(taskId, sender, receiver, protoHex, payloadHex) {
    return triggerSendMediaMessage(taskId, sender, receiver, protoHex, payloadHex, "reply");
}

// -------------------------发送回复消息分区-------------------------

// -------------------------发送语音消息分区-------------------------
function triggerSendVoiceMessage(taskId, sender, receiver, protoHex, payloadHex) {
    return triggerSendMediaMessage(taskId, sender, receiver, protoHex, payloadHex, "voice");
}
// -------------------------发送语音消息分区-------------------------

rpc.exports = {
    hydrateCdnVideoCache: hydrateCdnVideoCache,
    triggerSendImgMessage: triggerSendImgMessage,
    triggerUploadImg: triggerUploadImg,
    triggerSendTextMessage: triggerSendTextMessage,
    triggerDownload: triggerDownload,
    triggerUploadVideo: triggerUploadVideo,
    triggerSendVideoMessage: triggerSendVideoMessage,
    triggerSendReplyMessage: triggerSendReplyMessage,
    triggerUploadVoice: triggerUploadVoice,
    triggerSendVoiceMessage: triggerSendVoiceMessage,
    triggerSendFileMessage: triggerSendFileMessage,
    triggerSendFileUploadMessage: triggerSendFileUploadMessage,
    triggerUploadFile: triggerUploadFile,
    triggerUploadAppAttach: triggerUploadAppAttach,
};

// -------------------------发送图片消息分区-------------------------

// -------------------------接收消息分区-------------------------
function setupDownloadFileDynamic() {
    downloadFileX1 = Memory.alloc(1624)
    fileIdAddr = Memory.alloc(128)
    downloadAesKeyAddr = Memory.alloc(128)
    filePathAddr = Memory.alloc(256)
    fileCdnUrlAddr = Memory.alloc(256)

}


function setReceiver() {
	try {
	// 4.1.13(structVer=3): 0x430783c 身份换位已死(零触发实证), 收发统一由 respDispatchAddr 接管
	if (structVer === "3") {
		console.log("[+] V3: 跳过 buf2RespAddr hook(由 resp-dispatch 接管)");
	} else {
	Interceptor.attach(buf2RespAddr, {
		onEnter: function (args) {
			// 通过 SP+0x140 读取当前 buf2resp 对应的 taskId
			var respTaskId = this.context.sp.add(0x140).readS32();
			const currentPtr = this.context.x20;
			const x2 = this.context.x0.toInt32();
            // 先处理我们发送任务的ack: 无论响应数据是否可读, 清理动作都必须执行
            // (错误响应往往指针不可读, 在校验前早退会跳过清理留下悬空伪造指针)
            var pendingEntry = finishPendingBuf2RespTask(respTaskId);
            if (pendingEntry && !pendingEntry.addr.isNull()) {
                // 成功路径同样复原原始消息指针, 而不是写0: 已完成的任务若带 NULL
                // 消息指针留在 mars 任务 map 里, 后续(数秒~数天后)清理 erase 时会
                // 踩坏红黑树 (2026-09-02 02:22 crash: 文本成功后留下 NULL 节点,
                // 图片失败的清理路径踩雷)。originalPtr 是 sendFunc 构造的合法消息,
                // 复原后任务全程处于原生合法状态, OnTaskEnd 按原生流程回收即可
                try {
                    if (pendingEntry.originalPtr && !pendingEntry.originalPtr.isNull()) {
                        pendingEntry.addr.writePointer(pendingEntry.originalPtr);
                        console.log("[+] buf2resp: 已复原原始消息指针, msgType=" + pendingEntry.msgType + " taskId=" + respTaskId);
                    } else {
                        pendingEntry.addr.writeU64(0x0);
                        console.log("[+] buf2resp: 原始指针不可用, 已清零 insertMsgAddr, msgType=" + pendingEntry.msgType + " taskId=" + respTaskId);
                    }
                } catch (e) {
                    console.error("[!] buf2resp 清理异常: taskId=" + respTaskId + " err=" + e);
                }
            }

            if (!isReadablePointer(currentPtr) || x2 < 4 || x2 > MAX_FRIDA_MESSAGE_BYTES) {
                if (pendingEntry) {
                    console.log("[+] buf2resp: ack响应数据不可读, 已跳过数据转发, taskId=" + respTaskId);
                } else {
                    console.error("[-] buf2resp: pointer 不可读 或 x2 大小不正确, ptr=" + currentPtr + " x2=" + x2);
                }
				return;
            }

            // 判断是否是我们发送的消息的 ack
            if (pendingEntry) {
                // 读取响应数据
				var respData = x2 >= 4 && x2 <= MAX_FRIDA_MESSAGE_BYTES ? readByteArrayIfReadable(currentPtr, x2) : null;
				if (respData) {
					var bytes = new Uint8Array(respData);
					console.log("[+] buf2resp: 收到响应, msgType=" + pendingEntry.msgType + " taskId=" + respTaskId + " len=" + x2);
					send({
						type: "buf2resp",
						msg_type: pendingEntry.msgType,
						task_id: (pendingEntry.goTaskId !== undefined && pendingEntry.goTaskId !== null) ? String(pendingEntry.goTaskId) : "",
						data: Array.from(bytes),
					});
				}
				return
            }

            const mem = readByteArrayIfReadable(currentPtr, x2);
            if (!mem) {
                console.warn("[skip] protobuf_msg memory read failed, length=" + x2);
                return;
            }
            const uint8Array = new Uint8Array(mem);
            // 与已验证稳定的旧版本保持一致，只做最宽松的消息候选判断。
            // 具体结构交给 Go 解析，宁可产生误判日志，也不要在 JS 层漏掉消息。
            if (uint8Array[0] !== 0x08) {
                return;
            }

            // 任何同步消息到达 = 微信已登录, 解锁 CdnManager 解析门禁
            incomingTrafficSeen = true;
            send({
                type: "protobuf_msg",
                data: Array.from(uint8Array),
            })
        },
    });
	}
	} catch (e) {
		console.error("[!] buf2Resp hook 挂载失败(ack转发不可用): " + e);
	}

    try {
    Interceptor.attach(startDownloadMedia, {
        onEnter: function (args) {
            downloadGlobalX0 = this.context.x0;
            if (uploadGlobalX0.equals(ptr(0))) {
                // 上传/下载共用同一 mars::cdn::CdnManager 单例, 顺手回填
                uploadGlobalX0 = this.context.x0;
                console.log("[+] 下载hook回填 uploadGlobalX0: " + uploadGlobalX0);
            }
            var fileIDAddr = readPointerIfReadable(this.context.x1.add(0x40));
            var fileId = readUtf8StringIfReadable(fileIDAddr);
            if (!fileId || !isReadablePointer(this.context.x1.add(0xA0))) {
                return;
            }
            const t = this.context.x1.add(0xA0).readU32()
            if (t === 3) {
                if (fileId.endsWith("_1")) {
                    this.context.x1.add(0xA0).writeU32(0x02);
                }
                if (fileId.endsWith("_31")) {
                    this.context.x1.add(0xA0).writeU32(0x04);
                }
            }
        }
    })
    } catch (e) {
        console.error("[!] startDownloadMedia hook 挂载失败: " + e);
    }

    // 4.1.12(structVer=2) 下载链路漂移(DIAG 实证, 详见 docs/version-upgrade.md):
    // - file/imag 数据寄存器 x22→x21 (寄存器分配漂移, JSON hook 点即 mov x1,xN 指令)
    // - 任务结构 +0x18: fileId 0x2E0→0x2F8, cdnUrl 0x2F8→0x310
    // - 视频数据变为 libc++ std::string(x20+0x178), 长度必须读结构体(4.1.12 x23=0)
    // 4.1.13(structVer=3): 静态实证 addrfind 给的 file 0x581a028 / imag 0x587ac9c
    // 落在 bl 上(frida 挂不上, 异常还会中断后续 hook), JSON 改挂前一条
    // mov(x1,x21); 调用形态 memcpy(dst=x19+x23, src=x21, len=x2) 与 4.1.12
    // 同源, 任务结构 info 仍在 +0x2b8 未再涨 ⇒ 寄存器/偏移沿用 4.1.12 一套。
    var dlIsV2 = (structVer === "2" || structVer === "3");
    var dlFileIdOff = dlIsV2 ? 0x2F8 : 0x2E0;
    var dlCdnUrlOff = dlIsV2 ? 0x310 : 0x2F8;

    // 每个 attach 单独 try/catch: 一个点挂不上不能中断其余 hook
    try {
    Interceptor.attach(downloadFileAddr, {
        onEnter: function (args) {
			var dataPtr = dlIsV2 ? this.context.x21 : this.context.x22;
			var dataLen = this.context.x2.toInt32();
			var fileId = readUtf8StringIfReadable(readPointerIfReadable(this.context.x19.add(dlFileIdOff)));
			var cdnUrl = readUtf8StringIfReadable(readPointerIfReadable(this.context.x19.add(dlCdnUrlOff)));

            sendDownloadChunks(dataPtr, dataLen, fileId, cdnUrl);
        }
    });
    } catch (e) {
        console.error("[!] downloadFile hook 挂载失败: " + e);
    }

    try {
    Interceptor.attach(downloadImagAddr, {
        onEnter: function (args) {
            var dataPtr = dlIsV2 ? this.context.x21 : this.context.x22;
            var dataLen = this.context.x2.toInt32();
            var fileId = readUtf8StringIfReadable(readPointerIfReadable(this.context.x19.add(dlFileIdOff)));
            var cdnUrl = readUtf8StringIfReadable(readPointerIfReadable(this.context.x19.add(dlCdnUrlOff)));

            sendDownloadChunks(dataPtr, dataLen, fileId, cdnUrl);
        }
    });
    } catch (e) {
        console.error("[!] downloadImag hook 挂载失败: " + e);
    }

    try {
    Interceptor.attach(downloadVideoAddr, {
        onEnter: function (args) {
            var dataPtr, dataLen;
            if (dlIsV2) {
                // libc++ std::string at x20+0x178: 数据指针 [+0], 长度 [+8],
                // SSO 旗标 [+0x17]&0x80 (短串数据内联在对象里)
                var sObj = this.context.x20.add(0x178);
                try {
                    var ssoFlag = sObj.add(0x17).readU8();
                    if (ssoFlag & 0x80) {
                        dataPtr = sObj;
                        dataLen = ssoFlag & 0x7f;
                    } else {
                        dataPtr = readPointerIfReadable(sObj);
                        dataLen = sObj.add(8).readU64().toUInt32();
                    }
                } catch (e) { dataPtr = ptr(0); dataLen = 0; }
            } else {
			    dataPtr = readPointerIfReadable(this.context.x20.add(0x178));
			    dataLen = this.context.x23.toInt32();
            }
			var fileId = readUtf8StringIfReadable(readPointerIfReadable(this.context.x19.add(dlFileIdOff)));
			var cdnUrl = readUtf8StringIfReadable(readPointerIfReadable(this.context.x19.add(dlCdnUrlOff)));

            sendDownloadChunks(dataPtr, dataLen, fileId, cdnUrl);
        }
    });
    } catch (e) {
        console.error("[!] downloadVideo hook 挂载失败: " + e);
    }
}


// fileType:  HdImage => 1,Image => 2, thumbImage => 3, Video => 4, File => 5,
function triggerDownload(receiver, cdnUrl, aesKey, filePath, fileType) {
    if (!downloadGlobalX0) {
        ensureCdnManagerX0();
    }
    if (!downloadGlobalX0) {
        console.error("[!] downloadGlobalX0 尚未初始化，请等待 hook 捕获");
        return "fail";
    }

    const downloadMediaPayload = [
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // 0x00
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // 0x10
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // 0x20
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // 0x30
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0xF0, 0xB6, 0x4C, 0xFC, 0x0A, 0x00, 0x00, 0x00, // 0x40
        0x24, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x28, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80,
        0x80, 0x10, 0x4B, 0xFA, 0x0A, 0x00, 0x00, 0x00, // 0x58
        0xB2, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0xB8, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80,
        0xF0, 0xB3, 0x4C, 0xFC, 0x0A, 0x00, 0x00, 0x00, // 0x70
        0x20, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x28, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80,
        0x60, 0xC4, 0x2D, 0xFE, 0x0A, 0x00, 0x00, 0x00, // 0x88
        0xC8, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // 0x90
        0xD0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80, // 0x98
        0x03, 0x00, 0x00, 0x00, 0xFF, 0xFF, 0xFF, 0xFF, // 0xa0
        0x00, 0x00, 0x00, 0x00, 0x01, 0xAA, 0xAA, 0xAA, // 0xa8
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // 0xb0
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // 0xc0
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // 0xd0
        0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // 0xd8
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // 0xe0
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // 0xf0
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // 0x100
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // 0x110
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x02, 0x00, 0x00, 0x00, 0x0A, 0x00, 0x00, 0x00, // 0x128
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x11, 0x28, 0x28, 0x00, 0x00, 0x00, 0x00, 0x00, // 0x148
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x02, 0x00, 0x00, 0xAA, 0xAA, 0xAA, // 0x170
        0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x0A, 0x00, 0x00, 0x00, // 0x180
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x1E, 0x00, 0x00, 0x00, 0xAA, 0xAA, 0xAA, 0xAA, // 0x1a0
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0xAA, 0xAA, 0xAA, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x22, 0x1A, 0xFE, 0x0A, 0x00, 0x00, 0x00, // 0x1d0
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // 0x1f0
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // 0x200
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // 0x288
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // 0x298
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // 0x2a0
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
        0x00, 0x4F, 0x56, 0xFC, 0x0A, 0x00, 0x00, 0x00, // 0x2c0
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // 0x300
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x01, 0x00, 0x00, 0x00, 0x0A, 0x00, 0x00, 0x00, // 0x318
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x0A, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // 0x340
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x01, 0x00, 0x00, 0x00, 0x0A, 0x00, 0x00, 0x00, // 0x378
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x03, 0x00, 0x00, 0x00, 0x0A, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x80, 0x3F, 0x00, 0x00, 0x00, 0x00, // 0x3e0
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ];

    patchString(fileIdAddr, receiver + "_" + String(Math.floor(Date.now() / 1000)) + "_" + Math.floor(Math.random() * 1001) + "_1");
    patchString(fileCdnUrlAddr, cdnUrl)
    patchString(downloadAesKeyAddr, aesKey)
    patchString(filePathAddr, filePath);

    downloadFileX1.writeByteArray(downloadMediaPayload);
    downloadFileX1.add(0x40).writePointer(fileIdAddr);
    downloadFileX1.add(0x58).writePointer(fileCdnUrlAddr);
    downloadFileX1.add(0x70).writePointer(downloadAesKeyAddr);
    downloadFileX1.add(0x88).writePointer(filePathAddr);
    downloadFileX1.add(0xa0).writeU32(fileType);

    const startDwMedia = new NativeFunction(startDownloadMedia, 'int64', ['pointer', 'pointer']);
    return startDwMedia(downloadGlobalX0, downloadFileX1);
}

// -------------------------接收消息分区-------------------------
