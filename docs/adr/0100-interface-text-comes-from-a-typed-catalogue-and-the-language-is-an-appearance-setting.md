# Interface text comes from a typed catalogue, and the language is an appearance setting

Every string in the app was an English literal in a component, `index.html` set `lang="en"`, and dates and numbers were formatted with the runtime's default locale. No layer existed to add a language to, and a chosen language could not reach the formatters (#353).

## Decisions

- **The catalogue is a typed object, and English is its schema.** `src/i18n/en.ts` nests the words by screen, then section. A leaf is a string, or a function for words that take a value (`use: (name) => \`Use ${name}\``). `Catalogue = typeof en`. Spanish (`es.ts`) is typed as the whole `Catalogue`, so `tsc` fails on a missing word or on a function that takes different values. A component reads `useLocale().appearance.fonts.title`; a misspelt key is a type error, not a blank label.
- **A missing word shows in English.** `localeFor` fills a language's words over English (`fillFromEnglish`), so a partial language can ship. Spanish is complete today.
- **One `Locale` value carries the words, the BCP 47 tag, and the formats.** `fmt.number`, `fmt.time`, `fmt.dateTime`, `fmt.day` and `fmt.age` are built once per locale from its tag. `fmt.age` writes what `relTime` wrote in English ("now", "5m", "3h", "2d", "1w"), and the unit's narrow form elsewhere ("5min", "1sem" in Spanish). `fmt.day` writes an ISO day as a date in UTC, so the day never shifts with the time zone.
- **The language is an appearance setting.** Settings → Appearance → Interface language offers System, then each language by its own name. The choice is kept with the rest of the appearance on this computer. System takes the first of the desktop's languages (`navigator.languages`) that has a catalogue, else English.
- **One rule picks the tag.** For System, the tag is the matching desktop tag (`es-MX`), or the desktop's first tag when none matched, so dates keep the desktop's format. For a picked language, the tag is the first desktop tag of that language, else the language itself.
- **`<html lang>` follows the words.** The appearance store sets it as it sets the theme variables, before React renders. It is the tag when the words are in the tag's language, else the language: English words on a German desktop are `lang="en"`.
- **A change re-renders in place.** `App` reads the locale from the appearance store and provides it through `LocaleContext`. Nothing remounts, so open chats, drafts and a theme being edited stay as they are. The store follows `languagechange` from the desktop.
- **Screens convert one at a time, and a test proves each.** A converted screen is rendered under a pseudo-locale that marks every catalogue string, and the test fails on any text or `aria-label`, `title`, `placeholder`, `alt`, `label` or `aria-valuetext` without the mark. Data such as theme names, font names and sample code is marked `translate="no"` and skipped. Settings → Appearance is converted first (`appearanceTranslated.test.tsx`), with the frame around it: the Settings heading, search box, Back to chat and the tab names.
- **Settings search finds translated words for free.** It reads the rendered text (ADR 0047), so a translated label is searched in the language shown.
- **Formatting goes through the locale on unconverted screens too.** The chat list and the other places that showed `relTime` use `fmt.age`, and Usage and Usage analytics use `fmt.number`, `fmt.time` and `fmt.day` for their counts, times and days. These exceptions remain. Token counts (`tokens` in `usage.ts`) are written with a `.` decimal point and `k` or `M` in every language. Dollar amounts (`usd`) are `$` and a number with a `.` decimal point. A cost's detail (`tallyLabel` in `usageAnalytics.ts`) counts the chats whose usage couldn't be read or wasn't recorded with `toLocaleString()`, so that count follows the runtime's default locale. Their words stay English until those screens convert. The CSV, grouping keys and sorting stay ISO.

## Considered options

- **react-i18next or another library.** Its keys are strings, checked only at run time, and its interpolation is a template language of its own. The typed object gives the same fallback with no dependency, and `tsc` checks every key and every value a word takes.
- **English source text as the key.** Changing an English word would change every language's key, and the type system could not tell a missing translation from a new one.
- **A lint that flags JSX string literals.** It would also flag data and miss strings built in helpers. The pseudo-locale test checks what renders instead.
- **A language setting apart from Appearance.** One more store for one value. Appearance already applies to the root element from launch, sign-in screen included.

## Consequences

- Until a screen converts, its words stay English in every language, and the README says so.
- A component on a converted screen reads its words with `useLocale()`. A plain function that writes words or formats takes the `Locale` (or its tag) as a parameter.
- A new language is one file typed as `Catalogue`, one entry in `LANGUAGES`, and its name in the README's Languages list; a test checks the README names every language.
- The Spanish was written with machine help and needs a native speaker's review.
- Snooze wake times outside the chat list, `storedTime`, the count in `tallyLabel` of chats with usage that couldn't be read or wasn't recorded, and the app's other `toLocale*` calls still use the runtime's default locale until their screens convert.
