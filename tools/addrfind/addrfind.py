#!/usr/bin/env python3
"""
addrfind.py — 跨版本 WeChat (macOS arm64) 地址定位工具

原理：
  wechat_version/*.json 里的地址是 wechat.dylib arm64 切片 __TEXT 段内偏移。
  相邻版本函数会整体平移/重排，但函数体指令大多逐字节相同（仅 BL 目标、
  ADRP 立即数、literal 引用等位置相关字段变化）。因此：

  1. 每组只需用"签名搜索"定位 1 个锚点地址（anchor）；
  2. 组内其余地址 = 新锚点 + (旧成员 - 旧锚点) 的固定 delta 推算，
     再用签名在落点校验；校验不过则在落点附近 ±WINDOW 内局部搜索。

用法：
  addrfind.py OLD_BIN OLD_JSON NEW_BIN [-o OUT_JSON] [-v]

  OLD_BIN/NEW_BIN: wechat.dylib（fat 或 arm64 单切片均可）
  OLD_JSON:        旧版本 wechat_version/*.json
  输出:            新版本候选 JSON + 每个地址的定位方式和置信度

仅依赖标准库。
"""

import json
import struct
import sys

# ---------------------------------------------------------------- Mach-O

FAT_MAGIC = 0xCAFEBEBE
MH_MAGIC_64 = 0xFEEDFACF
CPU_TYPE_ARM64 = 0x0100000C
LC_SEGMENT_64 = 0x19


class MachO:
    """加载 fat/thin Mach-O 的 arm64 切片，提供 vmaddr -> bytes 访问。"""

    def __init__(self, path):
        with open(path, "rb") as f:
            self.data = f.read()
        self.off = 0  # 切片在文件中的起始
        self._pick_slice()
        self._parse_segments()

    def _pick_slice(self):
        magic = struct.unpack_from(">I", self.data, 0)[0]
        if magic == FAT_MAGIC:
            nfat = struct.unpack_from(">I", self.data, 4)[0]
            for i in range(nfat):
                cputype, _cpusub, off, _size, _align = struct.unpack_from(
                    ">IIIII", self.data, 8 + i * 20)
                if cputype == CPU_TYPE_ARM64:
                    self.off = off
                    break
            else:
                raise ValueError("fat binary 中没有 arm64 切片")
        magic = struct.unpack_from("<I", self.data, self.off)[0]
        if magic != MH_MAGIC_64:
            raise ValueError("不是 64 位 Mach-O")

    def _parse_segments(self):
        o = self.off
        ncmds = struct.unpack_from("<I", self.data, o + 16)[0]
        lc = o + 32
        self.text = None  # (vmaddr, vmsize, fileoff)
        for _ in range(ncmds):
            cmd, cmdsize = struct.unpack_from("<II", self.data, lc)
            if cmd == LC_SEGMENT_64:
                segname = self.data[lc + 8:lc + 24].rstrip(b"\0").decode()
                vmaddr, vmsize, fileoff, _filesize = struct.unpack_from(
                    "<QQQQ", self.data, lc + 24)
                if segname == "__TEXT":
                    self.text = (vmaddr, vmsize, self.off + fileoff)
            lc += cmdsize
        if not self.text:
            raise ValueError("找不到 __TEXT 段")

    def read_at(self, vmaddr, size):
        vm0, vmsize, foff = self.text
        if vmaddr < vm0 or vmaddr + size > vm0 + vmsize:
            raise ValueError("地址 %#x 超出 __TEXT 范围" % vmaddr)
        p = foff + (vmaddr - vm0)
        return self.data[p:p + size]

    def u32_at(self, vmaddr):
        return struct.unpack("<I", self.read_at(vmaddr, 4))[0]

    @property
    def text_bytes(self):
        vm0, vmsize, foff = self.text
        return self.data[foff:foff + vmsize]

    @property
    def text_vmaddr(self):
        return self.text[0]


# ---------------------------------------------------------------- ARM64 签名

def mask_word(w):
    """返回 (value, mask)：位置相关字段置 0 / 掩掉，其余保留。

    跨版本会变但指令语义不变的部分：BL/B 目标、ADRP/ADR 立即数、
    LDR literal 偏移、条件/位测试分支偏移。
    """
    if (w & 0xFC000000) in (0x94000000, 0x14000000):  # BL / B
        return w & 0xFC000000, 0xFC000000
    if (w & 0x7E000000) == 0x34000000:                # CBZ/CBNZ
        return w & 0xFF00001F, 0xFF00001F
    if (w & 0x7E000000) == 0x36000000:                # TBZ/TBNZ
        return w & 0xFFF8001F, 0xFFF8001F
    if (w & 0xFF000010) == 0x54000000:                # B.cond
        return w & 0xFF00001F, 0xFF00001F
    if (w & 0x9F000000) == 0x90000000:                # ADRP
        return w & 0x9F00001F, 0x9F00001F
    if (w & 0x9F000000) == 0x10000000:                # ADR
        return w & 0x9F00001F, 0x9F00001F
    if (w & 0x3B000000) == 0x18000000:                # LDR (literal)
        return w & 0xFF00001F, 0xFF00001F
    return w, 0xFFFFFFFF


def extract_sig(macho, anchor, before=8, after=24):
    """以 anchor 为中心取 before+after 条指令窗口，返回
    (words[(val,mask)...], anchor_index)。anchor_index 为锚点在窗口里的序号。"""
    start = anchor - before * 4
    words = []
    for i in range(before + after):
        w = macho.u32_at(start + i * 4)
        words.append(mask_word(w))
    return words, before


def sig_score(macho, sig, anchor_idx, cand_anchor):
    """在候选锚点处比对签名，返回 (匹配数, 总数, 不匹配的下标列表)。"""
    start = cand_anchor - anchor_idx * 4
    vm0 = macho.text_vmaddr
    if start < vm0:
        return 0, len(sig), list(range(len(sig)))
    total = len(sig)
    good = 0
    bad = []
    for i, (val, mask) in enumerate(sig):
        try:
            w = macho.u32_at(start + i * 4)
        except ValueError:
            bad.append(i)
            continue
        if (w & mask) == val:
            good += 1
        else:
            bad.append(i)
    return good, total, bad


def find_candidates(macho, sig, anchor_idx, tolerance):
    """全 __TEXT 扫描签名，返回 [(cand_anchor, score)]，按分数降序。

    用窗口中出现次数最少的全掩码指令做种子过滤，避免 O(n*len) 扫描。
    """
    text = macho.text_bytes
    vm0 = macho.text_vmaddr

    # 选种子：全掩码词里出现次数最少的
    best_i, best_cnt, best_pat = -1, None, None
    for i, (val, mask) in enumerate(sig):
        if mask != 0xFFFFFFFF:
            continue
        pat = struct.pack("<I", val)
        cnt = text.count(pat)
        if cnt == 0:
            continue
        if best_cnt is None or cnt < best_cnt:
            best_i, best_cnt, best_pat = i, cnt, pat
    if best_i < 0:
        return []

    results = []
    pos = text.find(best_pat)
    while pos >= 0:
        cand_anchor = vm0 + pos - best_i * 4 + anchor_idx * 4
        good, total, _ = sig_score(macho, sig, anchor_idx, cand_anchor)
        if total - good <= tolerance:
            results.append((cand_anchor, good))
        pos = text.find(best_pat, pos + 4)
    results.sort(key=lambda x: -x[1])
    return results


def local_search(macho, sig, anchor_idx, center, radius, tolerance):
    """在 center ± radius 内逐 4 字节找最佳签名匹配。"""
    best = None
    for off in range(-radius, radius + 1, 4):
        cand = center + off
        good, total, _ = sig_score(macho, sig, anchor_idx, cand)
        if total - good <= tolerance:
            if best is None or good > best[1]:
                best = (cand, good)
    return best


# ---------------------------------------------------------------- 地址组

# 组内相对偏移跨版本稳定（4.1.10->4.1.11 验证），每组只需定位 anchor。
GROUPS = [
    {"name": "req2buf", "anchor": "req2bufEnterAddr",
     "members": ["req2bufExitAddr", "blrX8Addr", "buf2RespAddr",
                 "autoBufferWriteFunc"]},
    {"name": "send", "anchor": "sendFuncAddr", "members": []},
    {"name": "upload", "anchor": "uploadImageAddr",
     "members": ["cdnGetServiceAddr", "cdnManagerGetterAddr",
                 "uploadGetCallbackWrapperAddr", "uploadOnCompleteAddr"]},
    # 上传回调函数簇（0x3xxxxx 区域，与 uploadImageAddr 所在区域独立平移）
    {"name": "uploadcb", "anchor": "uploadGetCallbackWrapperFuncAddr",
     "members": ["cndOnCompleteAddr", "uploadOnCompleteFuncAddr"]},
    {"name": "download", "anchor": "startDownloadMedia",
     "members": ["downloadImagAddr", "downloadFileAddr", "downloadVideoAddr"]},
]

ANCHOR_TOLERANCE = 6    # 锚点搜索允许的不匹配指令数（窗口 32 条）
MEMBER_TOLERANCE = 6    # 成员落点校验容忍度
LOCAL_RADIUS = 0x1000   # 落点校验失败时的局部搜索半径


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    verbose = "-v" in sys.argv
    out_path = None
    if "-o" in sys.argv:
        out_path = sys.argv[sys.argv.index("-o") + 1]
    if len(args) < 3:
        print(__doc__)
        sys.exit(1)
    old_bin, old_json_path, new_bin = args[0], args[1], args[2]

    old = MachO(old_bin)
    new = MachO(new_bin)
    old_json = json.load(open(old_json_path))
    old_addr = {k: int(v, 16) for k, v in old_json.items()
                if isinstance(v, str) and v.startswith("0x")}

    result = {}
    report = []

    for grp in GROUPS:
        akey = grp["anchor"]
        if akey not in old_addr:
            report.append((grp["name"], akey, None, "skip", "旧 JSON 无此键"))
            continue
        a_old = old_addr[akey]
        sig, ai = extract_sig(old, a_old)

        cands = find_candidates(new, sig, ai, ANCHOR_TOLERANCE)
        if not cands:
            report.append((grp["name"], akey, None, "FAIL",
                           "锚点签名无匹配，需 IDA 手找"))
            continue
        a_new, score = cands[0]
        n_cand = len(cands)
        conf = "high" if n_cand == 1 and score >= len(sig) - 2 else \
               ("mid" if score >= len(sig) - ANCHOR_TOLERANCE else "low")
        result[akey] = "0x%x" % a_new
        report.append((grp["name"], akey, a_new, "anchor-search",
                       "%d/%d 匹配, %d 个候选, 置信度 %s"
                       % (score, len(sig), n_cand, conf)))
        if verbose and n_cand > 1:
            for c, s in cands[1:5]:
                report.append((grp["name"], "", c, "alt-candidate",
                               "%d/%d" % (s, len(sig))))

        # 组内成员：delta 推算 + 落点校验，失败则局部搜索
        for mkey in grp["members"]:
            if mkey not in old_addr:
                continue
            delta = old_addr[mkey] - a_old
            pred = a_new + delta
            msig, mai = extract_sig(old, old_addr[mkey])
            good, total, _ = sig_score(new, msig, mai, pred)
            if total - good <= MEMBER_TOLERANCE:
                result[mkey] = "0x%x" % pred
                report.append((grp["name"], mkey, pred, "delta",
                               "%d/%d 匹配 (delta=%#x)" % (good, total, delta)))
            else:
                hit = local_search(new, msig, mai, pred, LOCAL_RADIUS,
                                   MEMBER_TOLERANCE)
                if hit:
                    result[mkey] = "0x%x" % hit[0]
                    report.append((grp["name"], mkey, hit[0],
                                   "delta+local-search",
                                   "%d/%d 匹配, 偏移修正 %#x -> %#x"
                                   % (hit[1], total, delta, hit[0] - a_new)))
                else:
                    report.append((grp["name"], mkey, None, "FAIL",
                                   "落点 %d/%d 且局部搜索无果"
                                   % (good, total)))

    # 输出
    print("%-10s %-32s %-12s %-18s %s" % ("group", "key", "new_addr", "method", "note"))
    print("-" * 100)
    for g, k, addr, method, note in report:
        print("%-10s %-32s %-12s %-18s %s"
              % (g, k, ("0x%x" % addr) if addr else "-", method, note))

    if out_path:
        # 保持旧 JSON 键顺序，补新值
        out = {}
        for k in list(old_json.keys()):
            if k in result:
                out[k] = result[k]
        for k in result:
            if k not in out:
                out[k] = result[k]
        with open(out_path, "w") as f:
            json.dump(out, f, indent=2)
        print("\n写入 %s（%d/%d 个键）"
              % (out_path, len(result), len(old_addr)))


if __name__ == "__main__":
    main()
