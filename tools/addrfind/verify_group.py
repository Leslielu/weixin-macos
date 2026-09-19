#!/usr/bin/env python3
"""verify_group.py - 逐 key 对比两个版本 dylib 在同地址处的指令助记符序列
用法: verify_group.py <old.dylib> <old.json> <new.dylib> <new.json>
只比较 mnemonic(忽略立即数), 打印每个 key 的 N 条指令匹配率。
"""
import json
import sys

sys.path.insert(0, "/Users/leslielu/Prog/weixin-macos/tools/addrfind")
from addrfind import MachO  # noqa: E402

from capstone import Cs, CS_ARCH_ARM64, CS_MODE_ARM  # noqa: E402

N_INSNS = 16


def mnemonics(macho: MachO, addr: int, n: int):
    raw = macho.read_at(addr, n * 4)
    md = Cs(CS_ARCH_ARM64, CS_MODE_ARM)
    out = []
    for ins in md.disasm(raw, addr):
        out.append(ins.mnemonic)
        if len(out) >= n:
            break
    return out


def main():
    old_bin, old_json, new_bin, new_json = sys.argv[1:5]
    mo = MachO(old_bin)
    mn = MachO(new_bin)
    jo = json.load(open(old_json))
    jn = json.load(open(new_json))
    for key in jo:
        if key not in jn:
            print(f"{key:34s} 新版缺失")
            continue
        ao = int(jo[key], 16)
        an = int(jn[key], 16)
        so = mnemonics(mo, ao, N_INSNS)
        sn = mnemonics(mn, an, N_INSNS)
        m = sum(1 for a, b in zip(so, sn) if a == b)
        mark = "OK " if m >= N_INSNS - 2 else "!!!"
        print(f"{mark} {key:34s} {m}/{min(len(so), len(sn))}  old=0x{ao:x} new=0x{an:x}")
        if m < N_INSNS - 2:
            for i, (a, b) in enumerate(zip(so, sn)):
                if a != b:
                    print(f"      +0x{i*4:x}: old={a}  new={b}")


if __name__ == "__main__":
    main()
