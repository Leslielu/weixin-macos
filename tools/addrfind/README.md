# addrfind — 跨版本 WeChat 地址定位工具

从旧版 `wechat.dylib` + 旧版 `wechat_version/*.json` 出发，自动定位新版本
`wechat.dylib` 里的同名地址，产出候选 JSON。**仅依赖 Python 标准库。**

## 用法

```bash
python3 tools/addrfind/addrfind.py 旧版dylib 旧版.json 新版dylib -o 新候选.json
# 例：
python3 tools/addrfind/addrfind.py \
  version_bin/wechat-4.1.10.53-arm64.dylib \
  wechat_version/4_1_10_53_mac.json \
  version_bin/wechat-4.1.11.53-arm64.dylib \
  -o /tmp/candidate.json
```

dylib 传 fat 或 arm64 单切片均可（fat 自动取 arm64）。切片提取：

```bash
lipo -thin arm64 /Applications/WeChat.app/Contents/Resources/wechat.dylib \
  -output version_bin/wechat-<版本>-arm64.dylib
```

历史版本的 dylib 在 mac-m1 `~/wechat-backup/<快照>/WeChat.app/Contents/Resources/wechat.dylib`。
本机 `version_bin/` 目录（已 gitignore）存放各版本切片。

## 原理

1. **签名搜索找锚点**：以锚点地址为中心取 32 条指令窗口，掩掉位置相关字段
   （BL/B 目标、ADRP/ADR/LDR-literal 立即数、条件分支偏移），在全 `__TEXT`
   扫描。每组只需定位 1 个锚点。
2. **delta 推算组成员**：组内相对偏移跨版本高度稳定（4.1.10→4.1.11 大多逐字节
   不变），成员地址 = 新锚点 + 旧 delta，落点签名复核；失败则 ±0x1000 局部搜索。

## 地址分组（锚点 → 成员）

| 组 | 锚点 | 成员 |
|---|---|---|
| req2buf | req2bufEnterAddr | req2bufExitAddr, blrX8Addr, buf2RespAddr, autoBufferWriteFunc |
| send | sendFuncAddr | — |
| upload | uploadImageAddr | cdnGetServiceAddr, cdnManagerGetterAddr, uploadGetCallbackWrapperAddr, uploadOnCompleteAddr |
| uploadcb | uploadGetCallbackWrapperFuncAddr | cndOnCompleteAddr, uploadOnCompleteFuncAddr |
| download | startDownloadMedia | downloadImagAddr, downloadFileAddr, downloadVideoAddr |

> uploadcb 簇（0x3xxxxx 区域）与 uploadImageAddr 所在区域独立平移，必须单独
> 成组——这是 4.1.10→4.1.11 回归中实测发现的。

## 回归验证记录

- **4.1.10.53 → 4.1.11.53：18/18 与人工验证值完全一致**（含 delta 落点自动修正：
  cdnGetServiceAddr 漂移 4 字节、download 组漂移数百字节，均被局部搜索修正）。
- **4.1.11.53 → 4.1.13 (269628)：5/18 自动定位**（uploadcb 全簇 + uploadImageAddr
  + startDownloadMedia，见 `wechat_version/4_1_13_269628_mac.partial.json`）。
  大版本跳转编译产物变化大，req2buf/send/download 成员签名失配。
  缩小窗口实验另得两个高置信候选：uploadOnCompleteAddr=0x5709f88 (16/16)、
  uploadGetCallbackWrapperAddr=0x57098c8 (16/16)。
  其余需要 IDA 手找锚点（字符串 xref：`MMStartTask`、`newsendmsg`、
  `N4mars3cdn10CdnManagerE`，套路见 `docs/media-coldstart.md`）。

## 输出解读

- `anchor-search`：全局签名搜索命中，附候选数与置信度（1 个候选且 ≥30/32 为 high）
- `delta`：按组内固定偏移推算且落点复核通过
- `delta+local-search`：delta 漂移，局部搜索修正（会打印修正量）
- `FAIL`：需 IDA 人工处理；找到其余键后也可回头用新键当锚点缩小范围

## 注意

- 产出的候选 JSON **必须运行时验证**（挂 Frida 发文本+图片确认）再上线。
- 每次升级微信前，务必将旧版 `wechat.dylib` 留档（wechat-backup 已含整个 .app）。
