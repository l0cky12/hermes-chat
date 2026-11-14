// Paths on the Hermes server as the app shows and splits them: Server files' names, and the folder and name of a file
// on the dashboard's own machine.

/** Text direction and other invisible control characters, which can disguise a name (`evil‮gnp.exe`). */
const HIDDEN_CHARS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;

/** A file name as it is shown: invisible and direction-changing characters are made visible as `�`. */
export const shownName = (path: string) => (path.replace(/\/+$/, "").split("/").pop() || path).replace(HIDDEN_CHARS, "�");
/** A whole path, made safe the same way. */
export const shownPath = (path: string) => path.replace(HIDDEN_CHARS, "�");

/** The folder a path is in, and its name there. */
export function splitPath(path: string): { dir: string; name: string } {
  const clean = path.replace(/\/+$/, "");
  const at = clean.lastIndexOf("/");
  if (at < 0) return { dir: "~", name: clean.slice(2) };
  return { dir: at === 0 ? "/" : clean.slice(0, at), name: clean.slice(at + 1) };
}
