#!/usr/bin/env python3
"""How many bytes, and how many socket reads, one page change costs on the Bot Desktop's RFB stream (issue #172).

Talks RFB 3.8 to a real Xvnc's Unix socket, asks for noVNC's encodings (Tight first) with a quality and compression
level, then for each of several real-UI page changes drawn with x11bench.py, requests an incremental update and counts
its bytes and how many 64 KiB reads Hermes's bridge would have made of it (each becomes one WebSocket message).

  rfbsize.py RFB_SOCKET XVNC_DISPLAY QUALITY COMPRESSION
"""
import os
import socket
import struct
import sys
import time

import x11bench as xb

TIGHT, TIGHT_PNG, ZRLE, JPEG, HEXTILE, RRE, ZLIB, RAW, COPYRECT = 7, -260, 16, 21, 5, 2, 6, 0, 1
LAST_RECT, DESKTOP_SIZE = -224, -223


def recv_exact(s, n):
    out = b""
    while len(out) < n:
        c = s.recv(n - len(out))
        if not c:
            raise EOFError
        out += c
    return out


class Counting:
    """Reads the socket as Hermes's bridge does (whatever is there, up to 64 KiB) and counts reads and bytes."""

    def __init__(self, s):
        self.s, self.buf, self.reads, self.bytes = s, b"", 0, 0

    def take(self, n):
        while len(self.buf) < n:
            c = self.s.recv(65536)
            if not c:
                raise EOFError
            self.reads += 1
            self.bytes += len(c)
            self.buf += c
        out, self.buf = self.buf[:n], self.buf[n:]
        return out


def tight_len(r):
    b = r.take(1)[0]
    n = b & 0x7F
    if b & 0x80:
        b = r.take(1)[0]
        n |= (b & 0x7F) << 7
        if b & 0x80:
            n |= r.take(1)[0] << 14
    return n


def read_update(r, bpp=4):
    """One FramebufferUpdate; returns the encodings seen. Handles what Xvnc sends noVNC: Tight (all its modes), CopyRect,
    ZRLE is not asked for first so isn't decoded here."""
    t = r.take(1)[0]
    if t != 0:
        raise RuntimeError(f"unexpected server message {t}")
    (n,) = struct.unpack(">xH", r.take(3))
    seen = {}
    i = 0
    while n == 0xFFFF or i < n:
        _x, _y, w, h, enc = struct.unpack(">HHHHi", r.take(12))
        i += 1
        seen[enc] = seen.get(enc, 0) + 1
        if enc == LAST_RECT:
            break
        if enc == COPYRECT:
            r.take(4)
        elif enc == RAW:
            r.take(w * h * bpp)
        elif enc == TIGHT:
            ctl = r.take(1)[0]
            kind = ctl >> 4
            if kind == 8:  # fill
                r.take(3)
            elif kind == 9:  # JPEG
                r.take(tight_len(r))
            else:
                filt = 0
                if ctl & 0x40:
                    filt = r.take(1)[0]
                px = 3
                if filt == 1:  # palette
                    count = r.take(1)[0] + 1
                    r.take(count * 3)
                    row = (w + 7) // 8 if count == 2 else w
                    size = row * h
                elif filt == 2:  # gradient
                    size = w * h * px
                else:
                    size = w * h * px
                if size < 12:
                    r.take(size)
                else:
                    r.take(tight_len(r))
        elif enc in (DESKTOP_SIZE,):
            pass
        else:
            raise RuntimeError(f"encoding {enc} not handled")
    return seen


def main(sock_path, display, quality, compression):
    s = socket.socket(socket.AF_UNIX)
    s.connect(sock_path)
    recv_exact(s, 12)
    s.sendall(b"RFB 003.008\n")
    n = recv_exact(s, 1)[0]
    recv_exact(s, n)
    s.sendall(b"\x01")  # None
    recv_exact(s, 4)
    s.sendall(b"\x01")  # shared
    w, h = struct.unpack(">HH", recv_exact(s, 4))
    recv_exact(s, 16)
    recv_exact(s, struct.unpack(">I", recv_exact(s, 4))[0])
    # 32 bpp true colour, as noVNC asks.
    s.sendall(struct.pack(">B3xBBBBHHHBBB3x", 0, 32, 24, 0, 1, 255, 255, 255, 16, 8, 0))
    encs = [COPYRECT, TIGHT, TIGHT_PNG, JPEG, HEXTILE, RRE, ZLIB, RAW, -32 + quality, -256 + compression, DESKTOP_SIZE, LAST_RECT]
    s.sendall(struct.pack(">BxH", 2, len(encs)) + b"".join(struct.pack(">i", e) for e in encs))
    r = Counting(s)
    s.sendall(struct.pack(">BBHHHH", 3, 0, 0, 0, w, h))
    read_update(r)
    xv = xb.X(display)
    g = xv.gc(0)
    imgs = xb.pages(xv.width, xv.height, 12, os.path.join(os.environ.get("BENCH_CACHE", "/tmp"), f"pages-{xv.width}x{xv.height}.bin"))
    rows = []
    for k in range(1, 9):
        xv.put(g, 0, 0, xv.width, xv.height, imgs[k])
        xv.sync()
        time.sleep(0.3)
        r.reads = r.bytes = 0
        t = time.monotonic()
        s.sendall(struct.pack(">BBHHHH", 3, 1, 0, 0, w, h))
        seen = read_update(r)
        rows.append((r.bytes, r.reads, (time.monotonic() - t) * 1000, seen))
    kb = [b / 1024 for b, *_ in rows]
    reads = [n for _, n, *_ in rows]
    ms = [m for *_, m, _ in rows]
    print(f"quality={quality} compression={compression}: page change {min(kb):.0f}-{max(kb):.0f} KiB (mean {sum(kb)/len(kb):.0f}),"
          f" {min(reads)}-{max(reads)} reads, encode+read {min(ms):.0f}-{max(ms):.0f} ms; encodings {rows[-1][3]}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]))
