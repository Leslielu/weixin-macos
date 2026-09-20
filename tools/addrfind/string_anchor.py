#!/usr/bin/env python3
"""string_anchor.py — 字符串锚定法跨版本定位地址 (addrfind 签名失配时的补强手段)

原理: 编译器烧进 __TEXT 的字符串(构建路径/日志格式串/断言文本)跨版本不变。
老版本里目标代码块附近必有 adrp+add 引用; 同一字符串在新版本找到后,
扫新版的 adrp+add 引用点, 按「引用点 + 老版本相对偏移」投票定位目标块。
对函数体被重构(指令签名失配)的函数依然有效 —— 2026-09-20 用此法
拿下 4.1.12 三个下载回调(downloadFile/Imag/Video), addrfind 对它们全部失败。

用法:
  # 1) 看老版本某地址周边有哪些字符串引用(选锚)
  python3 string_anchor.py refs version_bin/wechat-4.1.11.53-arm64.dylib --at 0x535ea98

  # 2) 定位单个地址: 老dylib 新dylib 老地址
  python3 string_anchor.py find version_bin/wechat-4.1.11.53-arm64.dylib \
      version_bin/wechat-4.1.12.53-arm64.dylib --at 0x535ea98

  # 3) 按 JSON 批量: 老dylib 老json 新dylib
  python3 string_anchor.py find-json version_bin/wechat-4.1.12.53-arm64.dylib \
      wechat_version/4_1_12_53_mac.json \
      version_bin/wechat-4.1.13.269628-arm64.dylib -o /tmp/cand.json

  # 4) 在已知函数附近搜字节模式(结构匹配法, 如 uploadOnCompleteAddr:
  #    ldr x8,[x0]; ldr x8,[x8,#0x30] 的字节)
  python3 string_anchor.py hexfind version_bin/wechat-4.1.12.53-arm64.dylib \
      --hex 080040f9081940f9 --lo 0x551e000 --hi 0x5524000

  # 5) 候选簇反汇编确认 hook 点(高亮 bl/blr 及前两条指令, 需 venv capstone)
  ~/.venvs/wechat-re/bin/python3 string_anchor.py callscan \
      version_bin/wechat-4.1.12.53-arm64.dylib --lo 0x568e5b0 --hi 0x568e5e8

注意:
  - 输出定位到函数/代码块级; 最终 hook 点必须 callscan 目视确认
    (下载三件套语义 = bl 前的 mov x1,xN; 数据寄存器跨版本会漂移, 4.1.11 x22 / 4.1.12 x21)。
  - intra-block 漂移: 不同锚推算的候选可能相差 0x20~0x40, 属正常(编译器重排)。
  - uploadOnCompleteAddr 类虚调用块附近常只有 "default" 等通用串, 锚定法无效,
    用 hexfind 结构匹配(找 ldr x8,[x0]; ldr x8,[x8,#0x30]; mov x1,xN; blr x8)。
"""
import argparse
import json
import struct
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from addrfind import MachO  # noqa: E402


# ---------------- arm64 最小解码(免 capstone) ----------------

def adrp_target(w, pc):
    """adrp 解码: 返回目标页基址; 非本指令返回 None"""
    if (w & 0x9F000000) != 0x90000000:
        return None
    immlo = (w >> 29) & 3
    immhi = (w >> 5) & 0x7FFFF
    imm = (immhi << 2) | immlo
    if imm & (1 << 20):
        imm -= 1 << 21
    return (pc & ~0xFFF) + (imm << 12)


def decode_add_imm(w):
    """ADD Xd, Xn, #imm12 (shift 0): 返回 (Rd, Rn, imm12); 否则 None"""
    if (w & 0xFFC00000) != 0x91000000:
        return None
    return (w & 0x1F, (w >> 5) & 0x1F, (w >> 10) & 0xFFF)


def norm_word(w):
    """掩掉位置相关立即数, 用于跨版本窗口比对(与 addrfind 同思路)"""
    op = w & 0xFC000000
    if op in (0x14000000, 0x94000000):          # b / bl
        return w & 0xFC000000
    if (w & 0x9F000000) in (0x90000000, 0x10000000):  # adrp / adr
        return w & 0x9F000000
    if (w & 0xFF000000) == 0x54000000:          # b.cond
        return w & 0xFF00000F
    if (w & 0x7E000000) == 0x34000000:          # cbz/cbnz
        return w & 0x8100001F
    if (w & 0x7E000000) == 0x36000000:          # tbz/tbnz
        return w & 0xFFF8001F
    return w


def read_string_at(m, sa, minlen=4, maxlen=160):
    try:
        raw = m.read_at(sa, maxlen + 1)
    except ValueError:
        return None
    z = raw.find(b'\0')
    if z < minlen or z > maxlen:
        return None
    s = raw[:z]
    if not all(32 <= c < 127 for c in s):
        return None
    return s


def masked_window(m, addr, n=32):
    try:
        raw = m.read_at(addr, n * 4)
    except ValueError:
        return None
    return [norm_word(struct.unpack_from('<I', raw, i * 4)[0]) for i in range(n)]


def window_mismatch(old_m, old_a, new_m, new_a, n=32):
    a = masked_window(old_m, old_a, n)
    b = masked_window(new_m, new_a, n)
    if a is None or b is None:
        return n
    return sum(1 for x, y in zip(a, b) if x != y)


# ---------------- 字符串引用提取 ----------------

def strrefs_near(m, addr, back=0x300, fwd=0x500):
    """扫描 [addr-back, addr+fwd) 窗口内 adrp+add 解析出的字符串引用。
    返回 [(引用点地址, 字符串)]"""
    lo = (addr - back) & ~3
    hi = addr + fwd
    try:
        raw = m.read_at(lo, hi - lo)
    except ValueError:
        return []
    pages = {}  # reg -> page
    out = []
    for i in range(0, len(raw) - 4, 4):
        w = struct.unpack_from('<I', raw, i)[0]
        pc = lo + i
        page = adrp_target(w, pc)
        if page is not None:
            pages[w & 0x1F] = page
            continue
        add = decode_add_imm(w)
        if add is not None:
            rd, rn, imm = add
            if rd == rn and rn in pages and 0 < imm < 0x1000:
                s = read_string_at(m, pages[rn] + imm)
                if s:
                    out.append((pc, s))
    return out


def find_code_refs(m, str_addr, cap=64):
    """全 __TEXT 扫描指向 str_addr 的 adrp+add 引用点"""
    tb = m.text_bytes
    base = m.text_vmaddr
    page, off = str_addr & ~0xFFF, str_addr & 0xFFF
    refs = []
    if off == 0:
        # 页对齐串可能省略 add: 全量扫 adrp 目标页(慢, 每字一次掩码判断)
        for pos in range(0, len(tb) - 4, 4):
            w = struct.unpack_from('<I', tb, pos)[0]
            if (w & 0x9F000000) != 0x90000000:
                continue
            if adrp_target(w, base + pos) == page:
                refs.append(base + pos)
                if len(refs) >= cap:
                    break
        return refs
    for n in range(29):
        needle = struct.pack('<I', 0x91000000 | (off << 10) | (n << 5) | n)
        pos = -1
        while len(refs) < cap:
            pos = tb.find(needle, pos + 1)
            if pos < 0:
                break
            if pos % 4 or pos < 4:
                continue
            adrpw = struct.unpack_from('<I', tb, pos - 4)[0]
            if (adrpw & 0x1F) != n:
                continue
            if adrp_target(adrpw, base + pos - 4) == page:
                refs.append(base + pos)
    return refs


# ---------------- 定位与评分 ----------------

def locate(old_m, new_m, target_old, back=0x300, fwd=0x500, verbose=True, tol=0x100):
    """锚间一致性评分定位。返回 [(候选地址, 一致分, 签名mismatch)] 按置信度降序。

    种子只用稀有串(全库出现<=8次): 热门串(如 mars::cdn / base64表)引用上千,
    全局引用表会截断且引入大量假种子。验证用「预测位置局部反汇编」:
    假设锚 i 的引用点 r_i 映射正确, 则锚 j 的引用应在 r_i + (site_j - site_i)
    ±tol 处(block内相对布局大体保留), 就地扫窗口看加载的串内容是否吻合,
    命中越多分越高 —— 手工分析"多锚互证"的自动化。"""
    anchors = strrefs_near(old_m, target_old, back, fwd)
    by_content = {}
    for site, s in anchors:
        if len(s) >= 8:
            by_content.setdefault(s, []).append(site)
    if verbose:
        for s, sites in sorted(by_content.items(), key=lambda kv: kv[1][0]):
            d = target_old - sites[0]
            print(f"    锚 0x{sites[0]:x} {'+' if d < 0 else '-'}0x{abs(d):x} '{s.decode()[:60]}'")

    # 种子 = 稀有串在新 dylib 的引用点; 串在 __cstring 任意对齐(不做4对齐检查),
    # 每个旧拷贝 x 每个引用点都是独立种子(拷贝错位会让预测平移一簇)
    seeds = []  # (old_site, content, ref)
    for s, sites in by_content.items():
        occ = new_m.text_bytes.count(s + b'\0')
        if occ == 0 or occ > 8:
            continue
        spos = -1
        for _ in range(occ):
            spos = new_m.text_bytes.find(s + b'\0', spos + 1)
            for r in find_code_refs(new_m, new_m.text_vmaddr + spos, cap=64):
                for site in sites:
                    seeds.append((site, s, r))
    if not seeds:
        return []

    # 局部窗口缓存: 0x100对齐块 -> {content: 最近引用点}
    wcache = {}

    def refs_at(center):
        key = (center & ~0xFF, (center & ~0xFF) + 0x200)
        if key not in wcache:
            d = {}
            for site, s in strrefs_near(new_m, key[0] + 0x100, back=0x100, fwd=0x100):
                d.setdefault(s, []).append(site)
            wcache[key] = d
        return wcache[key]

    hyps = []
    for site_i, s_i, r in seeds:
        t_pred = r + (target_old - site_i)
        score = 1
        for s_j, sites_j in by_content.items():
            if s_j == s_i:
                continue
            hit = False
            for site_j in sites_j:
                want = r + (site_j - site_i)
                near = refs_at(want).get(s_j, [])
                if any(abs(x - want) <= tol for x in near):
                    hit = True
                    break
            if hit:
                score += 1
        hyps.append((t_pred, score, s_i))
    # 聚簇(0x100): 簇分 = Σ 不同锚内容各自的最高分 (跨锚互证累加, 同锚多引用点不重复计)
    hyps.sort(key=lambda h: h[0])
    clusters = []
    for t, score, s in hyps:
        if clusters and t - clusters[-1]['last'] <= 0x100:
            c = clusters[-1]
            c['last'] = t
            c['per'][s] = max(c['per'].get(s, 0), score)
        else:
            clusters.append({'last': t, 'per': {s: score}, 't0': t})
    final = []
    for c in clusters:
        total = sum(c['per'].values())
        center = c['t0']
        best = min(range(center - 0x80, center + 0x80, 4),
                   key=lambda a: window_mismatch(old_m, target_old, new_m, a))
        final.append((best, total, window_mismatch(old_m, target_old, new_m, best)))
    return sorted(final, key=lambda h: (-h[1], h[2]))


# ---------------- 子命令 ----------------

def cmd_refs(a):
    m = MachO(a.dylib)
    for site, s in strrefs_near(m, a.at, a.back, a.fwd):
        d = a.at - site
        print(f"0x{site:x}  目标{'+' if d < 0 else '-'}0x{abs(d):x}  '{s.decode()}'")


def cmd_find(a):
    old_m, new_m = MachO(a.old), MachO(a.new)
    for t in a.at:
        print(f"\n目标 老地址 0x{t:x}:")
        res = locate(old_m, new_m, t)
        if not res:
            print("    [x] 无候选 (附近无可锚字符串? 试 hexfind 结构匹配)")
            continue
        for addr, votes, mm in res[:5]:
            print(f"    -> 0x{addr:x}  票{votes}  签名mismatch {mm}/32")


def cmd_find_json(a):
    old_m, new_m = MachO(a.old), MachO(a.new)
    j = json.load(open(a.old_json))
    keys = a.keys.split(',') if a.keys else list(j.keys())
    found = {}
    print(f"{'key':36s} {'old':>10s} {'new':>10s}  票 mismatch")
    for k in keys:
        old_v = j.get(k)
        if old_v is None:
            continue
        old_a = int(old_v, 16) if isinstance(old_v, str) else old_v
        res = locate(old_m, new_m, old_a, verbose=False)
        if res:
            addr, votes, mm = res[0]
            found[k] = "0x%x" % addr
            print(f"{k:36s} 0x{old_a:8x} 0x{addr:8x}  {votes}  {mm}/32")
        else:
            print(f"{k:36s} 0x{old_a:8x} {'-':>10s}  (无候选)")
    print(f"\n定位 {len(found)}/{len(keys)} 键")
    if a.o:
        out = dict(j)
        out.update(found)
        json.dump(out, open(a.o, 'w'), indent=2, ensure_ascii=False)
        print(f"写入 {a.o}")


def cmd_callscan(a):
    """簇内/邻域反汇编确认 hook 点: 高亮 bl/blr 及其前两条指令。
    下载三件套的 JSON 地址语义 = 调用点前的 mov x1,xN(数据寄存器随版本漂移,
    4.1.11 x22 / 4.1.12 x21), frida 不能在 bl 上 attach, 必须取 mov。"""
    try:
        from capstone import Cs, CS_ARCH_ARM64, CS_MODE_LITTLE_ENDIAN
    except ImportError:
        sys.exit("[x] 需要 capstone: ~/.venvs/wechat-re/bin/python3 " + sys.argv[0])
    m = MachO(a.dylib)
    md = Cs(CS_ARCH_ARM64, CS_MODE_LITTLE_ENDIAN)
    lo, hi = a.lo, a.hi + 8
    raw = m.read_at(lo, hi - lo)
    insns = list(md.disasm(raw, lo))
    for k, ins in enumerate(insns):
        line = f"0x{ins.address:x}: {ins.mnemonic:8s} {ins.op_str}"
        if ins.mnemonic in ('bl', 'blr'):
            print("\n" + line + "   <<<< call")
            for prev in insns[max(0, k - 2):k]:
                print(f"0x{prev.address:x}: {prev.mnemonic:8s} {prev.op_str}   (前指令)")
        elif a.all:
            print(line)


def cmd_hexfind(a):
    m = MachO(a.dylib)
    needle = bytes.fromhex(a.hex)
    tb = m.text_bytes
    base = m.text_vmaddr
    lo = a.lo if a.lo is not None else base
    hi = a.hi if a.hi is not None else base + len(tb)
    pos = lo - base - 1
    n = 0
    while n < a.cap:
        pos = tb.find(needle, pos + 1, hi - base)
        if pos < 0:
            break
        if pos % 4:
            continue
        n += 1
        addr = base + pos
        ctx = []
        for d in range(-12, 20, 4):
            p = pos + d
            if p < 0 or p + 4 > len(tb):
                continue
            w = struct.unpack_from('<I', tb, p)[0]
            hint = ''
            if (w & 0xFFFFFC1F) == 0xD63F0100 & 0xFFFFFC1F or w == 0xD63F0100:
                hint = ' blr'
            elif (w >> 26) == 0x25:
                hint = ' bl/b'
            elif (w & 0x9F000000) == 0x90000000:
                hint = ' adrp'
            mark = ' <==' if d == 0 else ''
            ctx.append(f"0x{base + p:x}: {w:08x}{hint}{mark}")
        print(f"\n>>> 0x{addr:x}")
        for line in ctx:
            print("   " + line)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest='cmd', required=True)

    sp = sub.add_parser('refs', help='列出地址周边字符串引用')
    sp.add_argument('dylib')
    sp.add_argument('--at', type=lambda x: int(x, 0), required=True)
    sp.add_argument('--back', type=lambda x: int(x, 0), default=0x300)
    sp.add_argument('--fwd', type=lambda x: int(x, 0), default=0x500)
    sp.set_defaults(f=cmd_refs)

    sp = sub.add_parser('find', help='定位单个/多个地址')
    sp.add_argument('old')
    sp.add_argument('new')
    sp.add_argument('--at', type=lambda x: int(x, 0), action='append', required=True)
    sp.set_defaults(f=cmd_find)

    sp = sub.add_parser('find-json', help='按老 JSON 批量定位')
    sp.add_argument('old')
    sp.add_argument('old_json')
    sp.add_argument('new')
    sp.add_argument('--keys', help='逗号分隔, 缺省全部')
    sp.add_argument('-o', help='输出候选 JSON(老 JSON 全量 + 命中键覆盖)')
    sp.set_defaults(f=cmd_find_json)

    sp = sub.add_parser('hexfind', help='字节模式搜索(结构匹配法)')
    sp.add_argument('dylib')
    sp.add_argument('--hex', required=True, help='小写hex字节, 如 080040f9081940f9')
    sp.add_argument('--lo', type=lambda x: int(x, 0))
    sp.add_argument('--hi', type=lambda x: int(x, 0))
    sp.add_argument('--cap', type=int, default=16)
    sp.set_defaults(f=cmd_hexfind)

    sp = sub.add_parser('callscan', help='反汇编范围, 高亮 bl/blr 调用点(需 venv capstone)')
    sp.add_argument('dylib')
    sp.add_argument('--lo', type=lambda x: int(x, 0), required=True)
    sp.add_argument('--hi', type=lambda x: int(x, 0), required=True)
    sp.add_argument('--all', action='store_true', help='打印全部指令(缺省只打印调用点)')
    sp.set_defaults(f=cmd_callscan)

    a = p.parse_args()
    a.f(a)


if __name__ == '__main__':
    main()
