/*
 * Finding a query in a phrase of the transcript without regard to case and
 * «ё» («Планфикс» for «планфикс», «ещё» for «еще»), with the places in the
 * original text to mark.
 */

/** A character in the form the search compares. */
function fold(char: string) {
  const lower = char.toLowerCase();
  return lower === "ё" ? "е" : lower;
}

/** `[start, end)` of every match of `query` in `text`, in UTF-16 units. */
export function matchRanges(text: string, query: string): [number, number][] {
  const needle = Array.from(query.trim(), fold).join("");
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
    const to = from + needle.length;
    ranges.push([origin[from] ?? 0, origin[to] ?? text.length]);
    from = folded.indexOf(needle, to);
  }
  return ranges;
}
