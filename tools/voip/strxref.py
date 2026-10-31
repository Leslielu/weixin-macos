#!/usr/bin/env python3
"""
strxref.py — wechat.dylib arm64 字符串交叉引用扫描（VoIP 定位用）

原理：在 arm64 切片里找目标 C 字符串的虚拟地址，然后扫 __text 里的
ADRP+ADD / ADRP+LDR 组合，凡目标落在字符串地址上的指令位置全部列出。
引用点 = 使用该字符串的代码处，通常就是目标函数体内。

仅依赖标准库。用法：
  strxref.py <wechat.dylib> 字符串1 [字符串2 ...]
"""

import struct
import sys

FAT_MAGIC = 0xCAFEBABE
MH_MAGIC_64 = 0xFEEDFACF
CPU_TYPE_ARM64 = 0x0100000C
LC_SEGMENT_64 = 0x19


class MachO:
    def __init__(self, path):
        with open(path, "rb") as f:
            self.data = f.read()
        self.off = 0
        self._pick_slice()
        self.segments = []  # (segname, vmaddr, vmsize, fileoff, filesize)
        self.sections = []  # (segname, sectname, addr, size, offset)
        self._parse()

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
                raise ValueError("无 arm64 切片")
        magic = struct.unpack_from("<I", self.data, self.off)[0]
        if magic != MH_MAGIC_64:
            raise ValueError("非 64 位 Mach-O")

    def _parse(self):
        o = self.off
        ncmds = struct.unpack_from("<I", self.data, o + 16)[0]
        total = struct.unpack_from("<I", self.data, o + 20)[0]
        lc = o + 32
        end = o + 32 + total
        while lc < end:
            cmd, cmdsize = struct.unpack_from("<II", self.data, lc)
            if cmd == LC_SEGMENT_64:
                segname = self.data[lc + 8:lc + 24].rstrip(b"\0").decode()
                vmaddr, vmsize, fileoff, filesize = struct.unpack_from(
                    ">QQQQ", self.data, lc + 24)
                self.segments.append((segname, vmaddr, vmsize, self.off + fileoff, filesize))
                nsects = struct.unpack_from("<I", self.data, lc + 64)[0]
                so = lc + 72
                for _ in range(nsects):
                    sectname = self.data[so:so + 16].split(b"\0")[0].decode(errors="replace")
                    segname2 = self.data[so + 16:so + 32].split(b"\0")[0].decode(errors="replace")
                    addr, size = struct.unpack_from("<QQ", self.data, so + 32)
                    sec_off = struct.unpack_from("<I", self.data, so + 48)[0]
                    self.sections.append((segname2, sectname, addr, size, self.off + sec_off))
                    so += 80
            lc += cmdsize

    def fileoff_to_vmaddr(self, fileoff):
        for segname, vmaddr, vmsize, foff, fsize in self.segments:
            if foff <= fileoff < foff + fsize:
                return vmaddr + (fileoff - foff)
        return None

    def text_region(self):
        for segname, sectname, addr, size, offset in self.sections:
            if sectname == "__text":
                return addr, size, offset
        raise ValueError("找不到 __text")


def find_strings(m, needle):
    """返回所有匹配子串所在的完整 C 字符串 (start_off, full_bytes)"""
    results = []
    start = 0
    while True:
        i = m.data.find(needle, start)
        if i < 0 or i >= len(m.data):
            break
        start = i + 1
        # 只接受落在 arm64 切片内的
        if i < m.off:
            continue
        s = i
        while s > 0 and m.data[s - 1] != 0:
            s -= 1
        e = m.data.find(b"\0", i)
        if e < 0:
            continue
        full = m.data[s:e]
        if len(full) > 4096:
            continue
        if (s, full) not in results:
            results.append((s, full))
    return results


def decode_adrp(w, pc):
    """ADRP: 返回 (rd, page_target) 或 None"""
    if (w & 0x9F000000) != 0x90000000:
        return None
    rd = w & 0x1F
    immlo = (w >> 29) & 0x3
    immhi = (w >> 5) & 0x7FFFF
    imm = (immhi << 2) | immlo
    if imm & 0x100000:  # 21-bit 符号扩展
        imm -= 0x200000
    return rd, ((pc & ~0xFFF) + (imm << 12)) & 0xFFFFFFFFFFFFFFFF


def decode_add_imm(w):
    """ADD Xd, Xn, #imm12 (64-bit, shift=0): 返回 (rd, rn, imm) 或 None"""
    if (w & 0x9F800000) != 0x91000000:
        return None
    rd = w & 0x1F
    rn = (w >> 5) & 0x1F
    imm = (w >> 10) & 0xFFF
    return rd, rn, imm


def decode_ldr_imm(w):
    """LDR Xt, [Xn, #imm12] (64-bit): 返回 (rt, rn, imm) 或 None"""
    if (w & 0xFFC00000) != 0xF9400000:
        return None
    rt = w & 0x1F
    rn = (w >> 5) & 0x1F
    imm = ((w >> 10) & 0xFFF) * 8
    return rt, rn, imm


def scan(m, wanted_pages):
    """扫 __text，返回命中列表 [(pc, reg, target_va, kind)]"""
    addr, size, offset = m.text_region()
    data = m.data
    n = min(size, len(data) - offset) // 4
    hits = []
    unpack = struct.unpack_from
    i = 0
    # 先扫出所有 ADRP 目标页在 wanted_pages 的位置
    adrp_sites = []  # (idx, rd, page)
    while i < n:
        w = unpack("<I", data, offset + i * 4)[0]
        if (w & 0x9F000000) == 0x90000000:
            pc = addr + i * 4
            r = decode_adrp(w, pc)
            if r and r[1] in wanted_pages:
                adrp_sites.append((i, r[0], r[1]))
        i += 1
    # 对每个 ADRP 向后看 8 条指令找 ADD/LDR
    for i, rd, page in adrp_sites:
        pc0 = addr + i * 4
        for j in range(i + 1, min(i + 9, n)):
            w = unpack("<I", data, offset + j * 4)[0]
            a = decode_add_imm(w)
            if a and a[1] == rd:
                target = (page + a[2]) & 0xFFFFFFFFFFFFFFFF
                if target in wanted_pages:
                    hits.append((pc0, rd, target, "add"))
                break
            l = decode_ldr_imm(w)
            if l and l[1] == rd:
                target = (page + l[2]) & 0xFFFFFFFFFFFFFFFF
                if target in wanted_pages:
                    hits.append((pc0, rd, target, "ldr"))
                break
    return hits


def scan_literals(m, targets):
    """在非可执行段里找 8 字节字面量 == 目标 VA，返回槽位 VA 列表"""
    slots = []
    for segname, vmaddr, vmsize, foff, fsize in m.segments:
        if segname.startswith("__TEXT"):
            continue
        for t in targets:
            needle = struct.pack("<Q", t)
            start = foff
            end = foff + fsize
            while True:
                i = m.data.find(needle, start, end)
                if i < 0:
                    break
                start = i + 8
                if i % 8 == 0:
                    slots.append((vmaddr + (i - foff), t, segname))
    return slots


def main():
    binpath = sys.argv[1]
    needles = [s.encode() for s in sys.argv[2:]]
    m = MachO(binpath)
    print(f"[*] {binpath} arm64 切片 @ file 0x{m.off:x}")

    wanted = {}  # va -> 描述
    for needle in needles:
        for soff, full in find_strings(m, needle):
            va = m.fileoff_to_vmaddr(soff)
            if va is None:
                continue
            wanted[va] = full[:60]
            print(f"[str] 0x{va:x}  {full[:80]!r}")

    if not wanted:
        print("未找到目标字符串")
        return

    wanted_pages = {va & ~0xFFF for va in wanted}
    print(f"\n[*] 扫描数据段字面量池...")
    slots = scan_literals(m, list(wanted.keys()))
    slot_by_va = {}
    for slot_va, str_va, seg in slots:
        slot_by_va[slot_va] = (str_va, seg)
        print(f"[lit] 0x{slot_va:x} ({seg}) -> 0x{str_va:x} {wanted[str_va][:50]!r}")

    print(f"\n[*] 扫描 __text 引用 ({len(wanted_pages)} 个目标页 + {len(slot_by_va)} 槽位页)...")
    wanted2 = dict(wanted)
    for sv, (str_va, seg) in slot_by_va.items():
        wanted2[sv] = b"<slot->" + wanted[str_va][:40]
    for sv in slot_by_va:
        wanted_pages.add(sv & ~0xFFF)
    hits = scan(m, wanted_pages)

    by_target = {}
    for pc, rd, target, kind in hits:
        # 命中可能是字符串起始，也可能落在同一页其它地址，按最近目标归类
        best = None
        for va in wanted2:
            if (va & ~0xFFF) == (target & ~0xFFF):
                if best is None or abs(target - va) < abs(target - best):
                    best = va
        by_target.setdefault(best, []).append((pc, rd, target, kind))

    print()
    for va in sorted(by_target):
        print(f"=== {wanted2[va][:60]!r} @ 0x{va:x} ===")
        for pc, rd, target, kind in sorted(by_target[va]):
            delta = target - va
            print(f"  adrp_pc=0x{pc:x}  x{rd}  +0x{delta:x}  ({kind})")


if __name__ == "__main__":
    main()
