#!/usr/bin/env python3
"""
addrfind.py — 跨版本 WeChat (macOS arm64) 地址定位工具 v2

原理：
  wechat_version/*.json 里的地址是 wechat.dylib arm64 切片 __TEXT 段内偏移。
  相邻版本函数会整体平移/重排，但函数体指令大多逐字节相同（仅 BL 目标、
  ADRP 立即数、literal 引用等位置相关字段变化）。

  v1 流程：每组签名搜索定位锚点，组内成员按旧 delta 推算 + 落点校验 +
  局部搜索。v2 增加第二阶段解析器（4.1.11->4.1.12 实战沉淀的补强套路）：

  1. alt-base      成员落点失败时，以旧地址空间中邻近的任意已解出键为基准重试
  2. bl_before     配对函数解析：扫"BL partner"调用点，回溯前置 BL 目标，
                   多数投票（cdnGetServiceAddr 25 个调用点共识的固化）
  3. caller_xref   调用者反查：旧版找 X 的 BL 调用站点，签名匹配到新版后
                   解码其 BL 目标；用"新旧调用者数量一致"去歧（sendFuncAddr）
  4. rigid cluster 刚性簇：簇内相对偏移逐版本不变，任一成员解出即推全部
  5. reverse hint  反向链锚定：--hint 提供更新版本的 bin+json，用更新版的
                   签名反搜当前版本（直接跳找到的锚点反补中间版本）

用法：
  addrfind.py OLD_BIN OLD_JSON NEW_BIN [-o OUT_JSON] [--hint HINT_BIN HINT_JSON] [-v]

仅依赖标准库。
"""

import json
import struct
import sys
from collections import Counter

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
        total = struct.unpack_from("<I", self.data, o + 20)[0]
        lc = o + 32
        self.text = None  # (vmaddr, vmsize, fileoff)
        while lc < o + 32 + total:
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


# ---------------------------------------------------------------- ARM64 工具

def bl_target(w, pc):
    """BL 指令解码目标地址。"""
    imm = w & 0x3FFFFFF
    if imm & 0x2000000:
        imm -= 0x4000000
    return pc + (imm << 2)


def is_bl(w):
    return (w & 0xFC000000) == 0x94000000


def scan_bl_to(macho, target, limit=16):
    """全 __TEXT 找 BL -> target 的调用站点。"""
    text, vm0 = macho.text_bytes, macho.text_vmaddr
    hits = []
    for off in range(0, len(text), 4):
        w = struct.unpack_from("<I", text, off)[0]
        if is_bl(w) and bl_target(w, vm0 + off) == target:
            hits.append(vm0 + off)
            if len(hits) >= limit:
                break
    return hits


def mask_word(w):
    """返回 (value, mask)：位置相关字段掩掉，其余保留。"""
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
    (words[(val,mask)...], anchor_index)。"""
    start = anchor - before * 4
    words = []
    for i in range(before + after):
        w = macho.u32_at(start + i * 4)
        words.append(mask_word(w))
    return words, before


def sig_score(macho, sig, anchor_idx, cand_anchor):
    """候选锚点处比对签名，返回 (匹配数, 总数)。"""
    start = cand_anchor - anchor_idx * 4
    vm0, vmsize = macho.text_vmaddr, macho.text[1]
    if start < vm0 or start + len(sig) * 4 > vm0 + vmsize:
        return 0, len(sig)
    good = 0
    for i, (val, mask) in enumerate(sig):
        try:
            w = macho.u32_at(start + i * 4)
        except ValueError:
            continue
        if (w & mask) == val:
            good += 1
    return good, len(sig)


def find_candidates(macho, sig, anchor_idx, tolerance):
    """全 __TEXT 扫描签名，返回 [(cand_anchor, score)] 降序。

    用窗口中出现次数最少的全掩码指令做种子过滤，避免 O(n*len) 扫描。
    """
    text = macho.text_bytes
    vm0 = macho.text_vmaddr

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
        good, total = sig_score(macho, sig, anchor_idx, cand_anchor)
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
        good, total = sig_score(macho, sig, anchor_idx, cand)
        if total - good <= tolerance:
            if best is None or good > best[1]:
                best = (cand, good)
    return best


# ---------------------------------------------------------------- 配置

# 组内相对偏移跨版本稳定，每组只需定位 anchor。
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

# bl_before 配对解析：扫 BL->partner 调用点，回溯前置 BL 目标多数投票
BL_PAIRS = [
    {"key": "cdnGetServiceAddr", "partner": "cdnManagerGetterAddr"},
]

# caller_xref 调用者反查：新旧 BL 调用者数量必须一致
CALLER_XREF = ["sendFuncAddr", "uploadImageAddr"]

# 刚性簇：簇内相对偏移逐版本不变，任一成员解出即推全部
RIGID_CLUSTERS = [
    ["downloadImagAddr", "downloadFileAddr", "downloadVideoAddr"],
]

ANCHOR_TOLERANCE = 6
MEMBER_TOLERANCE = 6
LOCAL_RADIUS = 0x1000
ALT_BASE_RADIUS = 0x10000     # 换基后的局部搜索半径
ALT_BASE_MAX_DIST = 0x500000  # 允许换基的旧地址空间邻近范围
VERIFY_MIN = 26               # 解析器落点全窗复核最低分（/32）


# ---------------------------------------------------------------- 解析器

class Resolver:
    def __init__(self, old, new, old_addr, verbose=False):
        self.old = old
        self.new = new
        self.old_addr = old_addr
        self.verbose = verbose
        self.result = {}   # key -> new addr
        self.methods = {}  # key -> (method, note)

    def resolved(self, key):
        return key in self.result

    def accept(self, key, addr, method, note, min_score=0):
        """落点前全窗复核（min_score>0 时）。"""
        if min_score and key in self.old_addr:
            sig, ai = extract_sig(self.old, self.old_addr[key])
            good, total = sig_score(self.new, sig, ai, addr)
            if good < min_score:
                return False
            note += ", 复核 %d/%d" % (good, total)
        self.result[key] = addr
        self.methods[key] = (method, note)
        return True

    # --- pass 1: 锚点签名 + delta ---
    def pass1(self):
        report = []
        for grp in GROUPS:
            akey = grp["anchor"]
            if akey not in self.old_addr:
                continue
            a_old = self.old_addr[akey]
            sig, ai = extract_sig(self.old, a_old)
            cands = find_candidates(self.new, sig, ai, ANCHOR_TOLERANCE)
            if cands:
                a_new, score = cands[0]
                conf = "high" if len(cands) == 1 and score >= len(sig) - 2 else "mid"
                self.accept(akey, a_new, "anchor-search",
                            "%d/%d, %d 候选, %s" % (score, len(sig), len(cands), conf))
            for mkey in grp["members"]:
                if mkey not in self.old_addr:
                    continue
                base = akey if self.resolved(akey) else None
                if base:
                    self._try_delta(mkey, base, LOCAL_RADIUS, "delta")
        return report

    def _try_delta(self, mkey, base_key, radius, label):
        delta = self.old_addr[mkey] - self.old_addr[base_key]
        pred = self.result[base_key] + delta
        sig, ai = extract_sig(self.old, self.old_addr[mkey])
        good, total = sig_score(self.new, sig, ai, pred)
        if total - good <= MEMBER_TOLERANCE:
            return self.accept(mkey, pred, label,
                               "%d/%d (基 %s delta=%#x)" % (good, total, base_key, delta))
        hit = local_search(self.new, sig, ai, pred, radius, MEMBER_TOLERANCE)
        if hit:
            return self.accept(mkey, hit[0], label + "+local",
                               "%d/%d (基 %s 修正 %#x->%#x)"
                               % (hit[1], total, base_key, delta, hit[0] - self.result[base_key]))
        return False

    # --- pass 2a: 换基 ---
    def pass_alt_base(self):
        progress = False
        for key, old_v in self.old_addr.items():
            if self.resolved(key):
                continue
            for base_key, base_old in self.old_addr.items():
                if base_key == key or not self.resolved(base_key):
                    continue
                if abs(old_v - base_old) > ALT_BASE_MAX_DIST:
                    continue
                if self._try_delta(key, base_key, ALT_BASE_RADIUS, "alt-base"):
                    progress = True
                    break
        return progress

    # --- pass 2b: BL 回溯配对 ---
    def pass_bl_pairs(self):
        for pair in BL_PAIRS:
            key, partner = pair["key"], pair["partner"]
            if self.resolved(key) or not self.resolved(partner):
                continue
            if partner not in self.old_addr or key not in self.old_addr:
                continue
            votes = Counter()
            for site in scan_bl_to(self.new, self.result[partner], limit=64):
                for back in range(4, 80, 4):
                    w = self.new.u32_at(site - back)
                    if is_bl(w):
                        votes[bl_target(w, site - back)] += 1
                        break
            if not votes:
                continue
            (top, n), runner = votes.most_common(2)[0], votes.most_common(2)[1] \
                if len(votes) > 1 else (None, 0)
            if n >= 3 and n >= 2 * runner[1]:
                self.accept(key, top, "bl-backtrace",
                            "%d 票(vs %d), partner %s" % (n, runner[1], partner),
                            min_score=VERIFY_MIN)

    # --- pass 2c: 调用者反查 ---
    def pass_caller_xref(self):
        for key in CALLER_XREF:
            if self.resolved(key) or key not in self.old_addr:
                continue
            old_callers = scan_bl_to(self.old, self.old_addr[key], limit=8)
            if not old_callers:
                continue
            votes = Counter()
            for site in old_callers:
                sig, ai = extract_sig(self.old, site, before=8, after=12)
                for c, s in find_candidates(self.new, sig, ai, 5)[:3]:
                    w = self.new.u32_at(c)
                    if is_bl(w):
                        votes[bl_target(w, c)] += 1
            if not votes:
                continue
            # 用"新版调用者数量 == 旧版调用者数量"去歧
            matched = []
            for tgt, v in votes.most_common(6):
                n_new = len(scan_bl_to(self.new, tgt, limit=8))
                if n_new == len(old_callers):
                    matched.append((tgt, v))
            if len(matched) == 1:
                self.accept(key, matched[0][0], "caller-xref",
                            "%d 票, 新旧均 %d 个调用者"
                            % (matched[0][1], len(old_callers)),
                            min_score=0)  # 调用点签名已背书，函数体可能大改

    # --- pass 2d: 刚性簇 ---
    def pass_rigid_clusters(self):
        for cluster in RIGID_CLUSTERS:
            have = [k for k in cluster if self.resolved(k)]
            missing = [k for k in cluster if not self.resolved(k)]
            if not have or not missing:
                continue
            base = have[0]
            for key in missing:
                if key not in self.old_addr or base not in self.old_addr:
                    continue
                self._try_delta(key, base, LOCAL_RADIUS, "rigid-cluster")

    # --- pass 2e: 反向链 hint ---
    def pass_reverse_hint(self, hint_bin, hint_addr):
        hint = MachO(hint_bin)
        for key, h_addr in hint_addr.items():
            if self.resolved(key) or key not in self.old_addr:
                continue
            sig, ai = extract_sig(hint, h_addr)
            cands = find_candidates(self.new, sig, ai, ANCHOR_TOLERANCE)
            if cands and (len(cands) == 1 or cands[0][1] - cands[1][1] >= 3):
                self.accept(key, cands[0][0], "reverse-hint",
                            "hint 签名 %d/%d, %d 候选" % (cands[0][1], len(sig), len(cands)))

    def run(self, hint=None):
        self.pass1()
        # pass 2 迭代到不动点
        for _ in range(4):
            before = len(self.result)
            if hint:
                self.pass_reverse_hint(hint[0], hint[1])
            self.pass_alt_base()
            self.pass_bl_pairs()
            self.pass_caller_xref()
            self.pass_rigid_clusters()
            if len(self.result) == before:
                break
        return self.result


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    verbose = "-v" in sys.argv
    out_path = None
    hint = None
    if "-o" in sys.argv:
        out_path = sys.argv[sys.argv.index("-o") + 1]
    if "--hint" in sys.argv:
        i = sys.argv.index("--hint")
        hint_bin, hint_json_path = sys.argv[i + 1], sys.argv[i + 2]
        hint_json = json.load(open(hint_json_path))
        hint = (hint_bin, {k: int(v, 16) for k, v in hint_json.items()
                           if isinstance(v, str) and v.startswith("0x")})
    if len(args) < 3:
        print(__doc__)
        sys.exit(1)
    old_bin, old_json_path, new_bin = args[0], args[1], args[2]

    old = MachO(old_bin)
    new = MachO(new_bin)
    old_json = json.load(open(old_json_path))
    old_addr = {k: int(v, 16) for k, v in old_json.items()
                if isinstance(v, str) and v.startswith("0x")}

    r = Resolver(old, new, old_addr, verbose)
    r.run(hint)

    print("%-34s %-12s %-18s %s" % ("key", "new_addr", "method", "note"))
    print("-" * 100)
    for k in old_json:
        if k in r.result:
            m, note = r.methods[k]
            print("%-34s %-12s %-18s %s" % (k, "0x%x" % r.result[k], m, note))
        elif k in old_addr:
            print("%-34s %-12s %-18s %s" % (k, "-", "FAIL", "需 IDA/运行时补"))

    if out_path:
        out = {}
        for k in list(old_json.keys()):
            if k in r.result:
                out[k] = "0x%x" % r.result[k]
        with open(out_path, "w") as f:
            json.dump(out, f, indent=2)
        print("\n写入 %s（%d/%d 个键）" % (out_path, len(r.result), len(old_addr)))


if __name__ == "__main__":
    main()
