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

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

export type OutlineUrlCheck =
  | { ok: true; origin: string }
  | { message: string; ok: false };

/*
 * The address before the check (outline-connector spec, «Адрес Outline»):
 * its root, or why the check doesn't start. `http` only for localhost.
 */
export function checkOutlineUrl(input: string): OutlineUrlCheck {
  if (!input.trim()) {
    return { message: "Укажите адрес вашего Outline.", ok: false };
  }
  const origin = normalizeOutlineUrl(input);
  if (!origin) {
    return {
      message: "Это не похоже на адрес. Например, docs.pixel.agency",
      ok: false,
    };
  }
  const url = new URL(origin);
  if (url.protocol === "http:" && !LOCAL_HOSTS.has(url.hostname)) {
    return { message: "Нужен адрес с https", ok: false };
  }
  return { ok: true, origin };
}
