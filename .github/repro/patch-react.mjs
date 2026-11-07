// Temporary (#308). In the built (unminified) bundle, React's commitHookEffectListUnmount calls an effect's cleanup;
// when that cleanup isn't a function it throws "destroy_ is not a function" without naming the effect. This patch logs
// the effect's component and its own source text first, so the error buffer in send.sh says which effect it was.
//   node .github/repro/patch-react.mjs [dist dir]
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? "dist/assets";
const file = readdirSync(dir).find((f) => /^index-.*\.js$/.test(f));
if (!file) throw new Error(`no index-*.js in ${dir}`);
const path = join(dir, file);
let js = readFileSync(path, "utf8");
const fn = js.indexOf("function commitHookEffectListUnmount(");
if (fn < 0) throw new Error("commitHookEffectListUnmount not found");
const call = js.indexOf("destroy_();", fn);
if (call < 0 || call - fn > 3000) throw new Error("destroy_() call not found near commitHookEffectListUnmount");
const probe = `if (typeof destroy_ !== "function") { try { const t = finishedWork.type; console.error("BAD_CLEANUP " + JSON.stringify({ cleanupType: typeof destroy_, cleanup: String(destroy_).slice(0, 300), component: typeof t === "function" ? t.name || "(anonymous)" : String(t), effect: String(updateQueue.create).slice(0, 800) })); } catch (e) { console.error("BAD_CLEANUP (describe failed) " + String(e)); } }
								`;
js = js.slice(0, call) + probe + js.slice(call);
writeFileSync(path, js);
console.log(`patched ${path}`);
