// A webhook filter's `regex`, tested the way Hermes's `re.search` would. On a crafted event a pattern can backtrack for
// seconds (WebKit) or without end (V8), so the app runs this only on the pattern worker, never on the UI thread (#490).

/** Python's regular expressions, as near as JavaScript's come: named groups are spelled differently. */
function pyRegex(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern.replace(/\(\?P<([A-Za-z_]\w*)>/g, "(?<$1>").replace(/\(\?P=([A-Za-z_]\w*)\)/g, "\\k<$1>"), "u");
  } catch {
    try {
      return new RegExp(pattern);
    } catch {
      return undefined;
    }
  }
}

/** Whether `pattern` matches `text`; a pattern that doesn't compile matches nothing. */
export function testPattern(pattern: string, text: string): boolean {
  return !!pyRegex(pattern)?.test(text);
}
