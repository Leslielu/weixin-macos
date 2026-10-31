#!/usr/bin/env python3
"""voipilinkinvite 请求模板：替换被叫 wxid 并重算 protobuf 长度。

payload 结构（probe20 抓包，273B）:
  08 ae44              field1 varint = 0x222e (请求类型)
  12 e1 01             field2 len=225
    0a 13 <19B wxid>   field1 = 被叫 wxid   <- 唯一需要替换的字段
    10 02              field2 = 2
    1a 00              field3 = 空
    22 b6 01 ...       field4 = 设备信息 (182B)
    ...                其余为平台/网络/uin/voip-2p/cmdid 0x2866/URI
用法:
  python3 invite_payload.py <wxid>            # 打印 hex
  python3 invite_payload.py --selftest        # 用原 wxid 重建，必须与原包逐字节一致
"""
import sys

CAPTURED_HEX = (
    "08ae4412e1010a13777869645f3364706f6475713137747663313210021a0022b60108cb818020120a30786632363431643366180420012a690a6508d70810fe7f187f20b201288e8810309984d0a00c3881a2bcb30f400448960150415808600a6808700a78008001008801ee019001ee01980100a00100a8010cb0010cb8010cc0010cc80104d00102d801ffffffff07a00200a80200b00200b8023fc002071200321d0a00120561726d36341a0022002a00380a40004a084170706c65204d3438800540b2014a0b0a03656e301001200430015080800428f3f481f3023a07766f69702d327018e65022252f6367692d62696e2f6d6963726f6d73672d62696e2f766f6970696c696e6b696e76697465"
)
ORIG_WXID = "wxid_3dpoduq17tvc12"


def varint(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def read_varint(buf: bytes, i: int):
    n = shift = 0
    while True:
        b = buf[i]
        i += 1
        n |= (b & 0x7F) << shift
        if not b & 0x80:
            return n, i
        shift += 7


def split(hex_str: str):
    """返回 (prefix, wxid, rest, tail)。

    prefix = field1 tag+value（请求类型 0x222e）
    rest   = field2 内 wxid 字段之后的原始字节
    tail   = field2 之后的原始字节（field3 cmdid 0x2866 + field4 URI）
    """
    raw = bytes.fromhex(hex_str)
    assert raw[0] == 0x08, "field1 tag"
    _, i = read_varint(raw, 1)          # field1 value (0x222e)
    prefix = raw[:i]
    assert raw[i] == 0x12, "field2 tag"
    body_len, j = read_varint(raw, i + 1)
    body = raw[j:j + body_len]
    tail = raw[j + body_len:]
    assert body[0] == 0x0A, "body field1 tag"
    wlen, k = read_varint(body, 1)
    wxid = body[k:k + wlen]
    return prefix, wxid, body[k + wlen:], tail


def build(wxid: str) -> bytes:
    prefix, _, rest, tail = split(CAPTURED_HEX)
    w = wxid.encode()
    body = b"\x0a" + varint(len(w)) + w + rest
    return prefix + b"\x12" + varint(len(body)) + body + tail


def selftest():
    orig = bytes.fromhex(CAPTURED_HEX)
    prefix, old_wxid, rest, tail = split(CAPTURED_HEX)
    rebuilt = build(ORIG_WXID)
    print(f"原包 {len(orig)}B, 重建 {len(rebuilt)}B, wxid={old_wxid.decode()!r}, "
          f"prefix={len(prefix)}B rest={len(rest)}B tail={len(tail)}B")
    assert rebuilt == orig, "round-trip 不一致"
    other = build("wxid_abcdefghijklmn")   # 同为 19 字符
    assert len(other) == len(orig)
    longer = build("wxid_0123456789abcdefg")  # 22 字符 -> 长度字段应变成双字节
    _, w, _, _ = split(longer.hex())
    print(f"长 wxid 包 {len(longer)}B, 解析回 wxid={w.decode()!r}")
    assert w.decode() == "wxid_0123456789abcdefg"
    print("SELFTEST OK")


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] == "--selftest":
        selftest()
    elif len(sys.argv) == 2:
        print(build(sys.argv[1]).hex())
    else:
        print(__doc__)
        sys.exit(1)
