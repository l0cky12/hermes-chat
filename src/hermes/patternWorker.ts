// The pattern worker (patternRunner.ts): tests one webhook filter pattern at a time, off the UI thread.
import type { PatternJob, WorkerReply } from "./patternRunner";
import { testPattern } from "./pyRegex";

const reply = (r: WorkerReply) => postMessage(r);
onmessage = (e: MessageEvent<PatternJob>) => reply(testPattern(e.data.pattern, e.data.text));
// The runner times each pattern from when it is posted, so it waits for this rather than timing the worker's start.
reply("ready");
