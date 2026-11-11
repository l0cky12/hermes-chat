#!/usr/bin/env python3
"""Rewrites `std::sync::Mutex` takes to `Locked::locked` (src/lock.rs, #491) and imports the trait where it is used.

Rewrites `.lock().unwrap()` (also split across lines) and the two hand-written poison recoveries. Anything else that
calls `lock()` is left for clippy's `disallowed_methods` to name. Safe to rerun: a file with nothing to rewrite is
left alone. Run from src-tauri: `python3 scripts/locked-codemod.py src tests`.
"""

import pathlib
import re
import sys

TAKE = re.compile(
    r"\.lock\(\)\s*\.(?:unwrap\(\)|unwrap_or_else\(\|e\| e\.into_inner\(\)\)|unwrap_or_else\(PoisonError::into_inner\))"
)


def import_line(path: pathlib.Path) -> str:
    return "use crate::lock::Locked;\n" if path.parts[0] == "src" else "use hermes_chat::lock::Locked;\n"


def add_import(text: str, line: str) -> str:
    if line in text:
        return text
    # Before the file's first `use` and the attributes on it (a `#[cfg]` there guards that `use`, not this one), else
    # after the file's leading `//!` docs and attributes.
    m = re.search(r"^(?:#\[.*\]\n)*use ", text, re.M)
    if m:
        return text[: m.start()] + line + text[m.start() :]
    m = re.match(r"(?:(?://!.*|#!\[.*\])\n)*\n?", text)
    return text[: m.end()] + line + text[m.end() :]


def main(roots: list[str]) -> None:
    for root in roots:
        for path in sorted(pathlib.Path(root).rglob("*.rs")):
            text = path.read_text()
            new, n = TAKE.subn(".locked()", text)
            if n == 0 or path.as_posix() == "src/lock.rs":
                continue
            new = add_import(new, import_line(path))
            path.write_text(new)
            print(f"{path}: {n}")


if __name__ == "__main__":
    main(sys.argv[1:])
