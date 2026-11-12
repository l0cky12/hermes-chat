// Math in Markdown, written the ways models write it: `$$…$$` blocks, and in text `$…$`, `$$…$$`, `\(…\)` and `\[…\]`.
// The parser reads it (micromark constructs), so math in code stays code and `*` or `_` in a formula is never
// emphasis. Its mdast is mdast-util-math's: `math` for a `$$` block, `inlineMath` in text, which become
// `<code class="language-math math-inline|math-display">`, a block's in a `<pre>`; markdownPipeline.ts typesets them.
import { math } from "micromark-extension-math";
import { mathFromMarkdown } from "mdast-util-math";
import type { Extension as FromMarkdownExtension } from "mdast-util-from-markdown";
import type { Parent } from "mdast";
import type { InlineMath } from "mdast-util-math";
import type { Code, Construct, Effects, Extension, State, TokenizeContext } from "micromark-util-types";
import type { Processor } from "unified";
// Declares the processor data fields remarkMath fills (micromarkExtensions, fromMarkdownExtensions).
import type {} from "remark-parse";

const DOLLAR = 36;
const BACKSLASH = 92;

/** End of input, a line ending, a tab or a space. */
const blank = (code: Code) => code === null || code < 0 || code === 32;
const lineEnding = (code: Code) => code !== null && code < -2;
const digit = (code: Code) => code !== null && code >= 48 && code <= 57;

/** The delimiter that ends a formula, consumed in full; `digitAfter`: a digit may follow it. */
function closing(delimiter: string, digitAfter = true): Construct {
  return {
    partial: true,
    tokenize(effects, ok, nok) {
      let at = 0;
      const next: State = (code) => {
        if (at === delimiter.length) {
          effects.exit("mathTextSequence");
          return !digitAfter && digit(code) ? nok(code) : ok(code);
        }
        if (code !== delimiter.charCodeAt(at++)) return nok(code);
        if (at === 1) effects.enter("mathTextSequence");
        effects.consume(code);
        return next;
      };
      return next;
    },
  };
}

// Pandoc's rule for a single `$`: the closing one has no space before it and no digit after it, so "$5 and $10" is prose.
const closeDollar = { construct: closing("$", false), afterBlank: false };
const closeDollars = { construct: closing("$$"), afterBlank: true };
const closeParen = { construct: closing("\\)"), afterBlank: true };
const closeBracket = { construct: closing("\\]"), afterBlank: true };
type Close = typeof closeDollar;

/**
 * Per paragraph (micromark tokenizes each one's text in a context of its own), where a formula of each kind first ran
 * to the paragraph's end unclosed. One of that kind starting later scans the same text from the same state, only
 * stricter about closing at once, so it can't close either. Not scanning again keeps `$a $a $a …` linear (#490).
 */
const unclosedFrom = new WeakMap<TokenizeContext, Map<Close, number>>();

/**
 * A formula's source after its opening delimiter, up to `close`: its lines, as `mathTextData` and line endings, which
 * mdast-util-math collects into the node's value. A backslash takes the character after it along, so `\$` in `$…$` and
 * `\\` before a `)` don't end the formula. A formula can't be empty, nor run past the paragraph it starts in.
 */
function formula(context: TokenizeContext, effects: Effects, ok: State, nok: State, close: Close): State {
  const from = context.now().offset;
  let unclosed = unclosedFrom.get(context);
  if (!unclosed) unclosedFrom.set(context, (unclosed = new Map()));
  if (from > (unclosed.get(close) ?? Infinity)) return nok;
  const first = close === closeParen || close === closeBracket ? BACKSLASH : DOLLAR;
  let empty = true;
  let previous: Code = null;
  let inData = false;
  const data = (on: boolean) => {
    if (on && !inData) effects.enter("mathTextData");
    if (!on && inData) effects.exit("mathTextData");
    inData = on;
  };
  const take = (code: Code) => {
    data(true);
    effects.consume(code);
    previous = code;
    empty = false;
  };
  const done: State = (code) => {
    effects.exit("mathText");
    return ok(code);
  };
  const escaped: State = (code) => {
    if (code === null || lineEnding(code)) return inside(code);
    take(code);
    return inside;
  };
  const notClosed: State = (code) => {
    take(code);
    return code === BACKSLASH ? escaped : inside;
  };
  const inside: State = (code) => {
    if (code === null) {
      if (from < (unclosed.get(close) ?? Infinity)) unclosed.set(close, from);
      return nok(code);
    }
    if (lineEnding(code)) {
      data(false);
      effects.enter("lineEnding");
      effects.consume(code);
      effects.exit("lineEnding");
      previous = code;
      return inside;
    }
    if (code === first && !empty && (close.afterBlank || !blank(previous))) {
      data(false);
      return effects.attempt(close.construct, done, notClosed)(code);
    }
    return notClosed(code);
  };
  return inside;
}

/** `$…$` (Pandoc's rule: no space just inside the opening `$`) and `$$…$$`, in text. */
const dollarMath: Construct = {
  name: "mathText",
  // Not from the middle of a run of dollars, unless the one before is escaped or ends a formula (`$a$$b$` is two).
  previous(code) {
    return code !== DOLLAR || ["characterEscape", "mathText"].includes(this.events[this.events.length - 1][1].type);
  },
  tokenize(effects, ok, nok) {
    const second: State = (code) => {
      if (code === DOLLAR) {
        effects.consume(code);
        effects.exit("mathTextSequence");
        return formula(this, effects, ok, nok, closeDollars);
      }
      if (blank(code)) return nok(code);
      effects.exit("mathTextSequence");
      return formula(this, effects, ok, nok, closeDollar)(code);
    };
    return (code) => {
      effects.enter("mathText");
      effects.enter("mathTextSequence");
      effects.consume(code);
      return second;
    };
  },
};

/** `\(…\)` and `\[…\]`, which would otherwise read as escaped brackets. */
const backslashMath: Construct = {
  name: "mathText",
  add: "before",
  tokenize(effects, ok, nok) {
    const kind: State = (code) => {
      if (code !== 40 && code !== 91) return nok(code);
      effects.consume(code);
      effects.exit("mathTextSequence");
      return formula(this, effects, ok, nok, code === 40 ? closeParen : closeBracket);
    };
    return (code) => {
      effects.enter("mathText");
      effects.enter("mathTextSequence");
      effects.consume(code);
      return kind;
    };
  },
};

/** micromark syntax: `$$` blocks (micromark-extension-math's), and math in text. */
export const mathSyntax: Extension = { flow: math().flow, text: { [DOLLAR]: dollarMath, [BACKSLASH]: backslashMath } };

const fromMath = mathFromMarkdown();

/** mdast-util-math's, but `$$…$$` and `\[…\]` in text are display math, as in TeX. */
export const mathMdast: FromMarkdownExtension = {
  ...fromMath,
  exit: {
    ...fromMath.exit,
    mathText(token) {
      fromMath.exit!.mathText!.call(this, token);
      if (!/^(\$\$|\\\[)/.test(this.sliceSerialize(token))) return;
      const parent = this.stack[this.stack.length - 1] as Parent;
      const node = parent.children[parent.children.length - 1] as InlineMath;
      node.data!.hProperties = { className: ["language-math", "math-display"] };
    },
  },
};

/** Remark plugin: parses math. */
export function remarkMath(this: Processor) {
  const data = this.data();
  (data.micromarkExtensions ??= []).push(mathSyntax);
  (data.fromMarkdownExtensions ??= []).push(mathMdast);
}
