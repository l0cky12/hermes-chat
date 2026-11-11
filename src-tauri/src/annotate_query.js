// The body of the one function the app runs in a page (ADR 0094), in the isolated world `hermes-chat-annotate`, with
// the numbers `x`, `y` (CSS pixels in the view) and `up` (parents to climb). It returns raw parts as one JSON string,
// and Rust (annotate.rs) builds, filters and caps every field again. A form field's contents are never read.
const FIELDS = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
const STYLES = ['display', 'position', 'width', 'height', 'margin', 'padding', 'gap', 'color', 'background-color', 'border', 'border-radius', 'font-family', 'font-size', 'font-weight', 'line-height', 'text-align', 'opacity'];
const cap = (s, n) => {
  s = String(s);
  if (s.length > n) s = s.slice(0, n);
  return typeof s.toWellFormed === 'function' ? s.toWellFormed() : s;
};
const view = { width: innerWidth, height: innerHeight, scrollX, scrollY, scale: devicePixelRatio };

const frames = [];
let el = document.elementFromPoint(x, y), px = x, py = y, host = null;
while (el && (el.tagName === 'IFRAME' || el.tagName === 'FRAME') && frames.length < 4) {
  let inner = null;
  try { inner = el.contentDocument; } catch (e) {}
  if (!inner) {
    try { host = new URL(el.src).host || null; } catch (e) {}
    break;
  }
  const r = el.getBoundingClientRect();
  const frame = { el, dx: r.left + el.clientLeft, dy: r.top + el.clientTop };
  const hit = inner.elementFromPoint(px - frame.dx, py - frame.dy);
  if (!hit) break;
  px -= frame.dx; py -= frame.dy;
  frames.push(frame);
  el = hit;
}
if (!el) return JSON.stringify(null);
const crossFrame = host === null ? null : el;
for (let i = 0; i < up; i++) {
  if (el.parentElement) el = el.parentElement;
  else if (frames.length) el = frames.pop().el;
  else break;
}
const box = el.getBoundingClientRect();
const rect = {
  x: box.left + frames.reduce((sum, f) => sum + f.dx, 0),
  y: box.top + frames.reduce((sum, f) => sum + f.dy, 0),
  width: box.width,
  height: box.height,
};
const tag = el.tagName.toLowerCase();
if (el === crossFrame) return JSON.stringify({ tag, host, rect, view });

const field = el.tagName === 'INPUT' ? String(el.type || 'text').toLowerCase()
  : el.tagName === 'TEXTAREA' ? 'textarea'
  : el.tagName === 'SELECT' ? 'select'
  : el.isContentEditable ? 'editable'
  : null;
if (field !== null) {
  let label = null;
  if (field !== 'password' && field !== 'hidden') {
    label = el.getAttribute('aria-label');
    if (!label && el.labels) label = [...el.labels].filter((l) => l.querySelector(FIELDS) === null).map((l) => l.innerText).join(' ');
  }
  return JSON.stringify({ tag, field, label: label ? cap(label, 200) : null, rect, view });
}

const containsField = el.querySelector(FIELDS) !== null;
const label = containsField ? null : el.getAttribute('aria-label') || el.innerText;
const role = el.getAttribute('role');
const path = [];
for (let e = el; e && path.length < 8; e = e.parentElement) {
  let nth = 0;
  if (e.parentElement) {
    const same = [...e.parentElement.children].filter((c) => c.tagName === e.tagName);
    if (same.length > 1) nth = same.indexOf(e) + 1;
  }
  path.unshift({ tag: e.tagName.toLowerCase(), id: e.id ? cap(e.id, 64) : null, classes: [...e.classList].slice(0, 4).map((c) => cap(c, 64)), nth });
}
const computed = el.ownerDocument.defaultView.getComputedStyle(el);
const styles = {};
for (const name of STYLES) {
  const v = computed.getPropertyValue(name);
  if (v) styles[name] = cap(v, 200);
}
return JSON.stringify({
  tag,
  role: role ? cap(role, 64) : null,
  label: label ? cap(label, 200) : null,
  containsField,
  path,
  rect,
  styles,
  view,
});
