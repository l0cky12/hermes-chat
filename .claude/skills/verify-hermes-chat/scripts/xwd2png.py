# Converts an X window dump (xwd -root -silent) to PNG with the standard library only. Usage: xwd2png.py in.xwd out.png
# Reads bpp//8 bytes per pixel: Xvfb at depth 24 writes 24-bit pixels, and reading 4 bytes squeezes the image.
import struct, sys, zlib
d = open(sys.argv[1], 'rb').read()
h = struct.unpack('>25I', d[:100])
hs, w, ht, bpp, bpl, ncol = h[0], h[4], h[5], h[11], h[12], h[19]
rm, gm, bm = h[14], h[15], h[16]
off = hs + ncol * 12
B = bpp // 8
def sh(m): return (m & -m).bit_length() - 1
rs, gs, bs = sh(rm), sh(gm), sh(bm)
rows = []
for y in range(ht):
    line = d[off + y * bpl: off + y * bpl + w * B]
    out = bytearray(b'\x00')
    for x in range(w):
        p = int.from_bytes(line[x*B:x*B+B], 'big' if h[7] else 'little')
        out += bytes(((p & rm) >> rs, (p & gm) >> gs, (p & bm) >> bs))
    rows.append(bytes(out))
def chunk(t, b): return struct.pack('>I', len(b)) + t + b + struct.pack('>I', zlib.crc32(t + b) & 0xffffffff)
png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, ht, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b''.join(rows), 6)) + chunk(b'IEND', b'')
open(sys.argv[2], 'wb').write(png)
