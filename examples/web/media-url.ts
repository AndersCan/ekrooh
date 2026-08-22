const MAX_DATA_URI_BYTES = 2 * 1024 * 1024;

/** Validates a media URL before it is bound to an `<img src>`. Only same-origin
 * loopback URLs (the worklet's media server), `blob:` and bounded `data:image/`
 * URIs are allowed — a remote `http(s)` URL would beacon the user's IP/UA to an
 * attacker, and an unbounded `data:` URI would let a hostile host pin a huge
 * payload into the DOM. Anything else is rejected (returns `''`). */
export function safeMediaUrl(url: string | undefined | null): string {
  if (typeof url !== 'string' || url.length === 0) return '';

  if (url.startsWith('blob:')) return url;

  if (url.startsWith('data:')) {
    if (!url.startsWith('data:image/')) return '';
    const comma = url.indexOf(',');
    if (comma === -1) return '';
    const meta = url.slice(0, comma);
    if (!meta.includes(';base64')) return '';
    const data = url.slice(comma + 1);
    const bytes = Math.ceil((data.length * 3) / 4);
    return bytes > MAX_DATA_URI_BYTES ? '' : url;
  }

  if (url.startsWith('http://') || url.startsWith('https://')) {
    try {
      const origin =
        typeof window !== 'undefined' && window.location?.origin
          ? window.location.origin
          : '';
      if (origin && new URL(url, origin).origin === origin) return url;
    } catch {
      return '';
    }
    return '';
  }

  return '';
}
