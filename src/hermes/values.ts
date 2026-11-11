/** An error's message, or the thrown value as text when it isn't an `Error`. */
export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A plain object, not `null` or an array: what a JSON object parses to. */
export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `n` and the word that goes with it: `plural(1, "chat")` is "1 chat", `plural(2, "reply", "replies")` is "2 replies". */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
