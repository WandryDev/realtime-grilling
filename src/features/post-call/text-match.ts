/*
 * Finding a query in a phrase of the transcript without regard to case and
 * «ё» («Планфикс» for «планфикс», «ещё» for «еще»), with the places in the
 * original text to mark.
 *
 * Light stemming, the same rule as the search of the history in Rust
 * (`src-tauri/src/storage/call_search.rs`): when the last word of the
 * query is longer than 3 letters and ends in a vowel, «ь» or «й», it also
 * matches without that letter, so «бронь» finds «броне» and «брони». Such
 * a match is marked to the end of the word it found.
 */

/** A character in the form the search compares. */
function fold(char: string) {
  const lower = char.toLowerCase();
  return lower === "ё" ? "е" : lower;
}

/** The letters a word may end in and still match without (after `fold`). */
const DROPPED_ENDINGS = new Set("аеиоуыэюяьй");
/** Shorter words match only as they are. */
const STEM_FROM_LETTERS = 4;
const LETTER = /\p{L}/u;
const WHITESPACE = /\s/u;

/** The query as the folded text is searched for, and whether it was cut. */
function needleOf(query: string) {
  const folded = Array.from(query.trim(), fold);
  const last = folded.at(-1);
  let start = folded.length;
  while (start > 0 && !WHITESPACE.test(folded[start - 1] ?? "")) {
    start -= 1;
  }
  const wordLength = folded.length - start;
  if (
    last !== undefined &&
    wordLength >= STEM_FROM_LETTERS &&
    DROPPED_ENDINGS.has(last)
  ) {
    return { needle: folded.slice(0, -1).join(""), stemmed: true };
  }
  return { needle: folded.join(""), stemmed: false };
}

/** `[start, end)` of every match of `query` in `text`, in UTF-16 units. */
export function matchRanges(text: string, query: string): [number, number][] {
  const { needle, stemmed } = needleOf(query);
  if (!needle) {
    return [];
  }
  // The folded text and where each of its units comes from.
  let folded = "";
  const origin: number[] = [];
  let index = 0;
  for (const char of text) {
    const mapped = fold(char);
    folded += mapped;
    origin.push(...new Array<number>(mapped.length).fill(index));
    index += char.length;
  }
  origin.push(index);

  const ranges: [number, number][] = [];
  let from = folded.indexOf(needle);
  while (from !== -1) {
    let to = from + needle.length;
    // A stem marks the rest of its word: «брон» of «броне».
    while (stemmed && to < folded.length && LETTER.test(folded[to] ?? "")) {
      to += 1;
    }
    ranges.push([origin[from] ?? 0, origin[to] ?? text.length]);
    from = folded.indexOf(needle, to);
  }
  return ranges;
}
