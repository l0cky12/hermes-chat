# Reply text costs what its length does, whatever its content

Issue #490. Some text took far longer to render than its length suggests, and froze the window. `$a ` repeated 20,000 times (60 KB) took 15 seconds, and a streamed reply rendered it again on every delta. An untagged code block of 200 KB took 3.6 seconds in WebKitGTK, and again on each find-in-chat keystroke. 40 KB of `a-a-a-…` took 2 seconds in Node and 17 in WebKitGTK to scan for secrets each time the export dialog opened. `bench/hostile.ts` times each case at doubling sizes, in Node and on the bench page in WebKitGTK.

## Decisions

- **A formula that never closes is scanned for once per paragraph.** Each unclosed `$`, `\(` or `\[` scanned to the end of its paragraph, so a paragraph of them took time in the square of its length. Once a formula of one kind runs unclosed to the end of a paragraph, any later one of that kind fails too: it scans the same text from the same state, only stricter about closing at once. The tokenizer (`src/ui/markdownMath.ts`) remembers this and fails such a formula at once. What parses is unchanged: 400,000 random strings of math delimiters, escapes and code spans give the same tree as before.
- **Code past 100,000 characters is not highlighted.** It shows plain, as the Preview's code view already did for files that long. The limit is `HIGHLIGHT_MAX_CHARS` in `src/ui/markdownPipeline.ts`, shared by replies, previewed Markdown and the code view.
- **An untagged block's language is guessed from its first 4,000 characters.** The guess runs every grammar over the code it reads, 13 to 27 times the cost of highlighting in one language (10 to 100 KB, Node). The block is then highlighted whole in the guessed language. A block of 4,000 characters or fewer is guessed as before. If the start gives no guess, the block stays plain.
- **All highlighted code is cached.** Blocks over 50,000 characters skipped the cache, so each find keystroke highlighted them again. With the 100,000-character limit, every highlighted block fits the 500,000-character cache. Copying a highlighted block from it costs about two fifths of highlighting it again.
- **The secret rules can't scan a run again from each word in it.** A link's scheme is at most 32 characters, at most eight words name a password (`aws_secret_access_key` is four), and a JWT can't start right after a `-`.

## Considered options

- **Capping a formula's length.** A cap still scans up to the cap from each `$`. A cap low enough to be fast would also refuse long display formulas written between `$$` in text.
- **No guess past a size, and plain code.** A large untagged block would lose its colours. Guessing from its start keeps them, at the cost of a 4,000-character guess.
- **A "render anyway" button for oversized replies**, as the issue suggests. With each case now linear, a long reply costs what any reply that long does, so there is nothing to hold back.

## Consequences

- An untagged block over 4,000 characters can be guessed differently than before, when its start reads as another language than the whole. ADR 0068 rejected guessing from fewer languages because every block would change. This changes only blocks longer than 4,000 characters, the ones whose guess cost the most.
- A code block over 100,000 characters in a reply has no colours.
- A JWT written straight after a `-` is not flagged in the export dialog.
