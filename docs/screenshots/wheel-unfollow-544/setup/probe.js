window.__log = [];
const t = document.querySelectorAll(".pane .transcript")[1];
let last = t.scrollTop;
t.addEventListener("wheel", (e) => window.__log.push(`w${Math.round(e.deltaY)}`), { passive: true });
t.addEventListener("scroll", () => {
  const g = Math.round(t.scrollHeight - t.scrollTop - t.clientHeight);
  window.__log.push(`s${g}${t.scrollTop < last ? "u" : "d"}`);
  last = t.scrollTop;
});
addEventListener("keydown", (e) => window.__log.push(`k${e.key}@${document.activeElement?.tagName}.${document.activeElement?.className}`), true);
return 1;
