const SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:\/\//iu;

/*
 * The Outline address in any form the user pastes: without https, with a
 * trailing slash or a link to a document. Returns the root
 * (`https://docs.pixel.agency`) or `null` when it isn't an address.
 */
export function normalizeOutlineUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }
  const withScheme = SCHEME_PATTERN.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (!(url.protocol === "https:" || url.protocol === "http:")) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}
