#!/usr/bin/env python3
"""
voipclimb.py — 交替使用 BL调用图 + chained-fixup编码搜索 的自动上溯爬链
原理:
  - BL 边: /tmp/bl_callers.pkl (voipwalk 建的)
  - 数据指针: 编码 = 0x0010000000000000 | target, 文件内直接 bytes.find
  - vtable 槽位 -> vtable 起始(向前找连续指针槽边界) -> adrp 扫描找 ctor -> ctor BL callers
用法: voipclimb.py <rootOffsetHex> [层数]
"""
import struct
import sys
import pickle

sys.path.insert(0, '/Users/leslielu/Prog/weixin-macos/tools/voip')
from strxref import MachO, decode_adrp, decode_add_imm, decode_ldr_imm
from voipwalk import find_func_start, disasm

BIN = '/Users/leslielu/Applications/WeChat-4.1.13.app/Contents/Resources/wechat.dylib'
m = MachO(BIN)
# voipwalk.find_func_start 需要 voipwalk.MachO 的字段
_ta, _ts, _to = m.text_region()
m.text_start, m.text_fileoff = _ta, _to
callers = pickle.load(open('/tmp/bl_callers.pkl', 'rb'))

MARK = 0x0010000000000000


def va_to_off(va):
    for segname, vmaddr, vmsize, foff, fsize in m.segments:
        if vmaddr <= va < vmaddr + vmsize:
            return foff + (va - vmaddr)
    return None


def off_to_va(off):
    for segname, vmaddr, vmsize, foff, fsize in m.segments:
        if foff <= off < foff + fsize:
            return vmaddr + (off - foff)
    return None


def find_slots(target):
    """文件里搜编码指针, 返回槽位 VA 列表"""
    pat = struct.pack("<Q", MARK | target)
    out, start = [], 0
    while True:
        i = m.data.find(pat, start)
        if i < 0:
            break
        start = i + 8
        va = off_to_va(i)
        if va is not None:
            out.append(va)
    return out


def decode_slot(slot):
    off = va_to_off(slot)
    if off is None:
        return None
    enc = struct.unpack_from("<Q", m.data, off)[0]
    if enc & MARK and not (enc & (1 << 63)):
        t = enc & 0xFFFFFFFFFFF
        if 0x18000 <= t < 0x20000000:
            return t
    return None


def vtable_start(slot):
    """从槽位向前找 vtable 边界(连续解码成功区段的开头)"""
    s = slot
    first = None
    for back in range(1, 24):
        t = decode_slot(s - back * 8)
        if t is None:
            first = s - (back - 1) * 8
            break
    return first or s


def adrp_refs(target):
    """扫 __text: adrp+add/ldr 精确指向 target"""
    addr, size, offset = m.text_region()
    n = min(size, len(m.data) - offset) // 4
    page = target & ~0xFFF
    hits = []
    i = 0
    while i < n:
        w = struct.unpack_from("<I", m.data, offset + i * 4)[0]
        if (w & 0x9F000000) == 0x90000000:
            pc = addr + i * 4
            r = decode_adrp(w, pc)
            if r and r[1] == page:
                rd = r[0]
                for j in range(i + 1, min(i + 9, n)):
                    w2 = struct.unpack_from("<I", m.data, offset + j * 4)[0]
                    a = decode_add_imm(w2)
                    if a and a[1] == rd:
                        if (page + a[2]) == target:
                            hits.append(pc)
                        break
                    l = decode_ldr_imm(w2)
                    if l and l[1] == rd:
                        if (page + l[2]) == target:
                            hits.append(pc)
                        break
        i += 1
    return hits


def func_of(pc):
    return find_func_start(m, pc)


def climb(root, label, maxdepth=5):
    print(f"\n========== {label}: 0x{root:x} ==========")
    frontier = [(root, "BL", 0)]
    seen = {root}
    for depth in range(1, maxdepth + 1):
        nxt = []
        for fn, how, _ in frontier:
            # 路径1: BL 调用者
            for c in callers.get(fn, []):
                s = func_of(c)
                if s and s not in seen:
                    seen.add(s)
                    nxt.append((s, "BL", depth))
            if nxt:
                continue
            # 路径2: 无 BL 调用者 → vtable 槽 → ctor 引用 vtable → ctor 的 BL 调用者
            slots = find_slots(fn)
            for slot in slots:
                vt = vtable_start(slot)
                if vt is None:
                    continue
                refs = adrp_refs(vt)
                for r in refs:
                    cf = func_of(r)
                    if cf and cf not in seen:
                        seen.add(cf)
                        nxt.append((cf, f"VT@0x{vt:x}", depth))
        if not nxt:
            print(f"L{depth}: (到顶)")
            break
        print(f"L{depth}: {len(nxt)} 个上游函数")
        for fn, how, d in nxt[:20]:
            print(f"   0x{fn:x}  via {how}")
        frontier = nxt
        if len(nxt) > 24:
            print("   ... 截断")


if __name__ == "__main__":
    root = int(sys.argv[1], 16)
    label = sys.argv[2] if len(sys.argv) > 2 else "root"
    climb(root, label)
