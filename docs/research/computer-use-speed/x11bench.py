#!/usr/bin/env python3
"""Glass-to-glass timing for the Screen tab (issue #172). Stdlib only.

It talks raw X11 to two X servers:
  * the Bot Desktop's Xvnc (TigerVNC, started with Hermes's launcher.sh arguments), where it draws "what Hermes does":
    a full-screen page change, or a small change, each with a coloured marker block whose colour encodes a frame number;
  * the X server the Hermes Chat app runs on (Xvfb), where it polls the pixels of the Screen tab's canvas that show those
    markers, to see when each frame reaches the glass.

Both sides use time.monotonic(), so one machine's clock times the whole path:
Xvnc -> Hermes's RFB bridge -> (tunnel) -> the app's Rust relay -> Tauri channel -> noVNC -> WebKitGTK -> Xvfb.

  x11bench.py locate  APP_DISPLAY XVNC_DISPLAY                 finds where the markers show in the app's window
  x11bench.py run     APP_DISPLAY XVNC_DISPLAY SCENARIO OUT.json  runs one scenario (page, small, busy)
"""
import glob
import json
import os
import socket
import struct
import sys
import time
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))


class X:
    """The smallest X11 client this needs: no auth (local servers started without -auth), little-endian."""

    def __init__(self, display):
        n = display.lstrip(":").split(".")[0]
        self.s = socket.socket(socket.AF_UNIX)
        self.s.connect(f"/tmp/.X11-unix/X{n}")
        self.s.sendall(struct.pack("<BxHHHH2x", ord("l"), 11, 0, 0, 0))
        head = self._read(8)
        if head[0] != 1:
            raise SystemExit(f"X server {display} refused the connection")
        extra = self._read(struct.unpack("<H", head[6:8])[0] * 4)
        _, self.id_base, self.id_mask, _, vlen, self.max_req, _nscreens, nformats = struct.unpack("<IIIIHHBB", extra[:22])
        off = 32 + ((vlen + 3) & ~3)
        self.formats = {}
        for i in range(nformats):
            depth, bpp, pad = struct.unpack("<BBB", extra[off + 8 * i : off + 8 * i + 3])
            self.formats[depth] = (bpp, pad)
        off += 8 * nformats
        self.root, _, _, _, _, self.width, self.height = struct.unpack("<IIIIIHH", extra[off : off + 24])
        self.depth = extra[off + 38]
        self.next_id = 1
        self.seq = 0

    def _read(self, n):
        out = b""
        while len(out) < n:
            chunk = self.s.recv(n - len(out))
            if not chunk:
                raise EOFError("X server closed")
            out += chunk
        return out

    def _req(self, data):
        self.seq += 1
        self.s.sendall(data)

    def _reply(self):
        while True:
            head = self._read(32)
            if head[0] == 0:
                raise RuntimeError(f"X error {head[1]} on request {struct.unpack('<H', head[2:4])[0]}")
            if head[0] == 1:
                return head, self._read(struct.unpack("<I", head[4:8])[0] * 4)
            # An event: ignored.

    def alloc(self):
        rid = self.id_base | self.next_id
        self.next_id += 1
        return rid

    def gc(self, color):
        gid = self.alloc()
        self._req(struct.pack("<BxHIIII", 55, 5, gid, self.root, 0x4, color))
        return gid

    def set_color(self, gid, color):
        self._req(struct.pack("<BxHIII", 56, 4, gid, 0x4, color))

    def fill(self, gid, x, y, w, h):
        self._req(struct.pack("<BxHIIhhHH", 70, 5, self.root, gid, x, y, w, h))

    def put(self, gid, x, y, w, h, bgrx):
        """ZPixmap image, 32 bits a pixel (depth 24), in strips that fit a request."""
        row = w * 4
        rows = max(1, (self.max_req * 4 - 24) // row)
        for top in range(0, h, rows):
            n = min(rows, h - top)
            data = bgrx[top * row : (top + n) * row]
            self._req(struct.pack("<BBHIIHHhhBB2x", 72, 2, 6 + len(data) // 4, self.root, gid, w, n, x, y + top, 0, 24) + data)

    def sync(self):
        """GetInputFocus: once it answers, the server has done every request before it."""
        self._req(struct.pack("<BxH", 43, 1))
        self._reply()

    def pixel(self, x, y):
        self._req(struct.pack("<BBHIhhHHI", 73, 2, 5, self.root, x, y, 1, 1, 0xFFFFFFFF))
        _, data = self._reply()
        b, g, r = data[0], data[1], data[2]
        return r, g, b

    def image(self, x, y, w, h):
        self._req(struct.pack("<BBHIhhHHI", 73, 2, 5, self.root, x, y, w, h, 0xFFFFFFFF))
        _head, data = self._reply()
        return data


# ---- content: real screenshots from docs/screenshots, decoded with zlib only ----
def read_png(path):
    raw = open(path, "rb").read()
    pos, idat, w = 8, b"", 0
    while pos < len(raw):
        n, kind = struct.unpack(">I4s", raw[pos : pos + 8])
        body = raw[pos + 8 : pos + 8 + n]
        if kind == b"IHDR":
            w, h, depth, ctype = struct.unpack(">IIBB", body[:10])
            if depth != 8 or ctype not in (2, 6):
                return None
            bpp = 3 if ctype == 2 else 4
        elif kind == b"IDAT":
            idat += body
        pos += 12 + n
    data = zlib.decompress(idat)
    stride = w * bpp
    out = bytearray(h * stride)
    prev = bytearray(stride)
    for y in range(h):
        f = data[y * (stride + 1)]
        line = bytearray(data[y * (stride + 1) + 1 : (y + 1) * (stride + 1)])
        if f == 1:
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 255
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif f == 3:
            for i in range(stride):
                line[i] = (line[i] + ((line[i - bpp] if i >= bpp else 0) + prev[i]) // 2) & 255
        elif f == 4:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                b = prev[i]
                c = prev[i - bpp] if i >= bpp else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[i] = (line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        out[y * stride : (y + 1) * stride] = line
        prev = line
    return w, h, bpp, bytes(out)


def pages(width, height, count, cache):
    """`count` full screens of real UI, each a different screenshot, as BGRX."""
    if os.path.exists(cache):
        blob = open(cache, "rb").read()
        size = width * height * 4
        if len(blob) == size * count:
            return [blob[i * size : (i + 1) * size] for i in range(count)]
    files = sorted(glob.glob(os.path.join(REPO, "docs/screenshots/*/*.png")))
    out = []
    step = max(1, len(files) // (count * 2))
    for f in files[::step]:
        png = read_png(f)
        if not png:
            continue
        w, h, bpp, px = png
        if w < 1000 or h < 700:
            continue
        frame = bytearray(width * height * 4)
        for y in range(height):
            sy = y % h
            for x0 in range(0, width, w):
                n = min(w, width - x0)
                src = px[sy * w * bpp : (sy * w + n) * bpp]
                row = bytearray(n * 4)
                row[0::4] = src[2::bpp]
                row[1::4] = src[1::bpp]
                row[2::4] = src[0::bpp]
                frame[(y * width + x0) * 4 : (y * width + x0 + n) * 4] = row
        out.append(bytes(frame))
        if len(out) == count:
            break
    open(cache, "wb").write(b"".join(out))
    return out


# ---- markers ----
LEVELS = (0x20, 0x70, 0xB0, 0xF0)
MARK = 96  # marker block, Xvnc pixels


def code_color(n):
    n %= 64
    r, g, b = LEVELS[n & 3], LEVELS[(n >> 2) & 3], LEVELS[(n >> 4) & 3]
    return (r << 16) | (g << 8) | b


def decode(rgb):
    out = 0
    for i, v in enumerate(rgb):
        lvl = min(range(4), key=lambda k: abs(LEVELS[k] - v))
        if abs(LEVELS[lvl] - v) > 22:
            return None
        out |= lvl << (2 * i)
    return out


def marker_spots(xv):
    """Top-left and bottom-right marker blocks: Xvnc sends rects top to bottom, so both changing means the frame is all there."""
    return [(8, 8), (xv.width - MARK - 8, xv.height - MARK - 8)]


def locate(app_display, xvnc_display):
    """Paints the Xvnc screen black with two magenta markers, then finds them in the app's window."""
    app, xv = X(app_display), X(xvnc_display)
    g = xv.gc(0)
    xv.fill(g, 0, 0, xv.width, xv.height)
    xv.set_color(g, 0xFF00FF)
    for x, y in marker_spots(xv):
        xv.fill(g, x, y, MARK, MARK)
    xv.sync()
    time.sleep(2.0)
    data = app.image(0, 0, app.width, app.height)
    hits = []
    for y in range(0, app.height):
        for x in range(0, app.width):
            i = (y * app.width + x) * 4
            if data[i] > 0xE0 and data[i + 1] < 0x30 and data[i + 2] > 0xE0:
                hits.append((x, y))
    if not hits:
        raise SystemExit("no magenta marker found in the app's window: is the Screen tab showing the stream?")
    # Two clusters: split on the midpoint of x.
    mid = (min(h[0] for h in hits) + max(h[0] for h in hits)) / 2
    spots = []
    for side in (lambda h: h[0] < mid, lambda h: h[0] >= mid):
        c = [h for h in hits if side(h)]
        xs, ys = [h[0] for h in c], [h[1] for h in c]
        spots.append({"x": (min(xs) + max(xs)) // 2, "y": (min(ys) + max(ys)) // 2, "w": max(xs) - min(xs) + 1, "h": max(ys) - min(ys) + 1})
    return spots


def run(app_display, xvnc_display, scenario, out_path, spots, count=None, interval=None):
    """Draws frames on Xvnc in this process, polls the app's pixels in a child, and writes both timelines."""
    xv = X(xvnc_display)
    g = xv.gc(0)
    cache = os.path.join(os.environ.get("BENCH_CACHE", "/tmp"), f"pages-{xv.width}x{xv.height}.bin")
    imgs = pages(xv.width, xv.height, 12, cache)
    r, w = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(r)
        poll(app_display, spots, w)
        os._exit(0)
    os.close(w)
    time.sleep(0.5)
    if scenario == "page":
        count, interval = count or 30, interval or 1.5
    elif scenario == "small":
        count, interval = count or 40, interval or 0.5
    elif scenario == "busy":
        count, interval = count or 150, interval or 0.1
    drawn = []
    t0 = time.monotonic()
    for n in range(1, count + 1):
        due = t0 + n * interval
        while time.monotonic() < due:
            time.sleep(0.0005)
        start = time.monotonic()
        if scenario in ("page", "busy"):
            xv.put(g, 0, 0, xv.width, xv.height, imgs[n % len(imgs)])
        else:
            # A small change: a 400x40 strip of new text-like content and the markers.
            src = imgs[n % len(imgs)]
            y0 = 300 + (n % 8) * 40
            strip = b"".join(src[(y0 + yy) * xv.width * 4 + 400 * 4 : (y0 + yy) * xv.width * 4 + 800 * 4] for yy in range(40))
            xv.put(g, 400, y0, 400, 40, strip)
        xv.set_color(g, code_color(n))
        for x, y in marker_spots(xv):
            xv.fill(g, x, y, MARK, MARK)
        xv.sync()
        drawn.append({"n": n, "start": start, "done": time.monotonic()})
    time.sleep(3.0)
    os.kill(pid, 15)
    seen = json.loads(os.fdopen(r).read() or "[]")
    os.waitpid(pid, 0)
    json.dump({"scenario": scenario, "interval": interval, "drawn": drawn, "seen": seen, "spots": spots}, open(out_path, "w"))


def poll(app_display, spots, fd):
    import signal

    app = X(app_display)
    seen = []
    last = [None] * len(spots)
    stop = {"now": False}
    signal.signal(signal.SIGTERM, lambda *_: stop.update(now=True))
    while not stop["now"]:
        for i, s in enumerate(spots):
            asked = time.monotonic()
            v = decode(app.pixel(s["x"], s["y"]))
            # The pixel is as it was at some moment while the read was out: [asked, answered]. The later bound is the
            # one used, so a slow read can't make a frame look faster than it was.
            answered = time.monotonic()
            if v is not None and v != last[i]:
                last[i] = v
                seen.append([answered, i, v, asked])
    os.write(fd, json.dumps(seen).encode())
    os.close(fd)


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "locate":
        print(json.dumps(locate(sys.argv[2], sys.argv[3])))
    elif cmd == "run":
        spots = json.loads(os.environ["BENCH_SPOTS"])
        run(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5], spots)
