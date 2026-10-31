#!/usr/bin/env python3
"""
voipwalk.py — wechat.dylib arm64 静态调用链回溯 (capstone)
用法:
  voipwalk.py <wechat.dylib> func <offsetHex>      # 找 offset 所在函数边界 + 反汇编
  voipwalk.py <wechat.dylib> callers <offsetHex>   # 全 __TEXT 扫描 BL 调用者
  voipwalk.py <wechat.dylib> dis <offsetHex> [n]   # 反汇编 n 条(默认40)
"""
import struct
import sys
from capstone import Cs, CS_ARCH_ARM64, CS_MODE_LITTLE_ENDIAN

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

    def _parse(self):
        o = self.off
        ncmds = struct.unpack_from("<I", self.data, o + 16)[0]
        total = struct.unpack_from("<I", self.data, o + 20)[0]
        lc = o + 32
        self.text_start = self.text_size = self.text_fileoff = None
        while lc < o + 32 + total:
            cmd, cmdsize = struct.unpack_from("<II", self.data, lc)
            if cmd == LC_SEGMENT_64:
                segname = self.data[lc + 8:lc + 24].rstrip(b"\0").decode()
                vmaddr, vmsize, fileoff, filesize = struct.unpack_from(
                    ">QQQQ", self.data, lc + 24)
                if segname == "__TEXT":
                    self.text_vmaddr, self.text_vmsize = vmaddr, vmsize
                    self.text_fileoff = self.off + fileoff
                    nsects = struct.unpack_from("<I", self.data, lc + 64)[0]
                    so = lc + 72
                    for i in range(nsects):
                        sectname = self.data[so:so + 16].split(b"\0")[0].decode()
                        if sectname == "__text":
                            addr, size = struct.unpack_from("<QQ", self.data, so + 32)
                            sec_off = struct.unpack_from("<I", self.data, so + 48)[0]
                            self.text_start = addr
                            self.text_size = size
                            self.text_fileoff = self.off + sec_off
                            break
            lc += cmdsize
        if self.text_start is None:
            raise ValueError("无 __text")


md = Cs(CS_ARCH_ARM64, CS_MODE_LITTLE_ENDIAN)
md.detail = True


def read_words(m, va, n):
    out = []
    for i in range(n):
        o = m.text_fileoff + (va + i * 4 - m.text_start)
        out.append(struct.unpack_from("<I", m.data, o)[0])
    return out


def disasm(m, va, n=40):
    off = m.text_fileoff + (va - m.text_start)
    code = m.data[off:off + n * 4 + 64]
    for insn in md.disasm(code, va):
        n -= 1
        yield insn.address, insn.mnemonic, insn.op_str
        if n <= 0:
            return


# 函数入口启发: capstone 解码回看窗口, 找 prologue 指令
def find_func_start(m, va):
    back = min(0x8000, va - m.text_start) & ~3
    off = m.text_fileoff + (va - back - m.text_start)
    code = m.data[off:off + back + 4]
    starts = []
    for insn in md.disasm(code, va - back):
        if insn.mnemonic in ("pacibsp", "pacibsp;"):
            starts.append(insn.address)
        elif insn.mnemonic == "stp" and "[sp" in insn.op_str and insn.op_str.endswith("!"):
            # stp Xt,Xt2,[sp,#-N]! 通用寄存器对保存序言
            starts.append(insn.address)
        elif insn.mnemonic == "sub" and insn.op_str.startswith("sp, sp, #") :
            starts.append(insn.address)
    cands = [s for s in starts if s <= va]
    if not cands:
        return None
    return cands[-1]


def scan_bl_callers(m, target):
    """全 __text 扫 BL target 的调用点"""
    hits = []
    n = m.text_size // 4
    fo = m.text_fileoff
    d = m.data
    for i in range(n):
        w = struct.unpack_from("<I", d, fo + i * 4)[0]
        if (w & 0xFC000000) == 0x94000000:  # BL
            imm = w & 0x3FFFFFF
            if imm & 0x2000000:
                imm -= 0x4000000
            pc = m.text_start + i * 4
            dst = pc + (imm << 2)
            if dst == target:
                hits.append(pc)
    return hits


def main():
    binpath = sys.argv[1]
    cmd = sys.argv[2]
    off = int(sys.argv[3], 16)
    m = MachO(binpath)
    print(f"__text: 0x{m.text_start:x} size 0x{m.text_size:x}")

    if cmd == "dis":
        n = int(sys.argv[4]) if len(sys.argv) > 4 else 40
        for a, mn, ops in disasm(m, off, n):
            print(f"  0x{a:x}: {mn:10s} {ops}")
    elif cmd == "func":
        start = find_func_start(m, off)
        print(f"0x{off:x} 所在函数(启发) start=0x{start:x}" if start else "未找到")
        if start:
            for a, mn, ops in disasm(m, start, 30):
                print(f"  0x{a:x}: {mn:10s} {ops}")
    elif cmd == "callers":
        print(f"扫描 BL -> 0x{off:x} ...")
        hits = scan_bl_callers(m, off)
        print(f"调用点 {len(hits)} 个: " + " ".join(hex(h) for h in hits[:40]))
        for h in hits[:10]:
            s = find_func_start(m, h)
            print(f"  call@0x{h:x}  所在函数≈0x{s:x}")
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
