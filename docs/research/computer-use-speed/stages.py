#!/usr/bin/env python3
"""Splits each frame of an x11bench.py run into stages, using the log of an app built with instrument.patch.

  stages.py RUN.json APP.log LABEL

Stages, from Xvnc having the frame ("draw done", x11bench.py's clock, CLOCK_MONOTONIC):
  last tx   Rust hands the last of the frame's bytes to the Tauri channel (`BENCH tx`, monotonic). This includes Xvnc's
            encoding, Hermes's bridge and the link.
  last JS   the webview's channel handler has the last of them (`BENCH js`, wall clock, mapped to monotonic with the
            `BENCH clock` pairs Rust logs)
  glass     both markers show in the app's window (x11bench.py's poller, attributed as analyze.py does)
Each duration (channel = last JS - last tx, noVNC+paint = glass - last JS, and the app's whole share, glass - last tx)
is worked out per frame, then the median is
taken. Only frames shown before the next one was drawn are split, since after that two frames' bytes interleave; the
others are counted as `excluded`. So this is for the page and small scenarios, not busy.
"""
import json
import os
import statistics
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from analyze import attribute


def main(run_path, log_path, label):
    run = json.load(open(run_path))
    tx, js, offs = [], [], []
    for line in open(log_path).read().splitlines():
        p = line.split()
        if line.startswith("BENCH tx"):
            tx.append(float(p[2]))
        elif line.startswith("BENCH clock"):
            offs.append(float(p[3]) - float(p[2]) * 1000)
        elif line.startswith("BENCH js"):
            js.append(float(p[2]))
    off = statistics.median(offs)
    js = [(w - off) / 1000 for w in js]
    drawn = run["drawn"]
    (a, _), (b, _) = attribute(drawn, run["seen"], 0), attribute(drawn, run["seen"], 1)
    rows, excluded = [], 0
    for k, d in enumerate(drawn):
        if k not in a or k not in b:
            continue
        glass = max(a[k], b[k])
        if k + 1 < len(drawn) and glass >= drawn[k + 1]["start"]:
            excluded += 1
            continue
        t = [x for x in tx if d["start"] <= x < glass]
        j = [x for x in js if d["start"] <= x < glass]
        if not t or not j:
            excluded += 1
            continue
        ms = lambda x: (x - d["done"]) * 1000  # noqa: B023 - called only in this iteration
        rows.append({"msgs": len(t), "last_tx": ms(t[-1]), "channel": (j[-1] - t[-1]) * 1000, "paint": (glass - j[-1]) * 1000,
                     "app": (glass - t[-1]) * 1000, "glass": ms(glass)})
    if not rows:
        print(f"{label}: no frame with all stages ({excluded} excluded)")
        return
    med = lambda key: statistics.median(r[key] for r in rows)
    print(
        f"{label}: n={len(rows)} excluded={excluded} | channel msgs/frame {med('msgs'):.0f} | last tx {med('last_tx'):.0f} ms"
        f" | channel {med('channel'):.0f} | noVNC+paint {med('paint'):.0f} | app (channel+noVNC+paint) {med('app'):.0f} | glass {med('glass'):.0f}  (medians of per-frame values)"
    )


if __name__ == "__main__":
    main(*sys.argv[1:4])
