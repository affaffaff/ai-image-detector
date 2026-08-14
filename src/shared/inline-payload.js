/**
 * Caps and predicates for image URLs that travel through extension messaging
 * as the bytes themselves (data: / blob:), not as an HTTP locator.
 *
 * Lives apart from constants.js so unit tests can import it without evaluating
 * `__DEV_BUILD__`, which esbuild only defines when bundling the extension.
 */

/**
 * Max blob:/data: payload we will inline through extension messaging.
 *
 * HTTP fetches stream into MAX_IMAGE_BYTES and never sit in chrome.storage.
 * Inline data URLs travel as JSON on the scan port and, if memoized, into
 * chrome.storage.session (~10MB for the whole extension). Base64 expands
 * the payload by 4/3, so this cap is far below the fetch limit.
 */
export const MAX_INLINE_SCAN_BYTES = 2 * 1024 * 1024;

/**
 * Session memo keys a chrome.storage.session map by URL. data: and blob:
 * strings are the image itself — writing them would blow the 10MB quota
 * and is unnecessary (the content-script registry already memoizes in RAM).
 * @param {string} url
 */
export function isSessionMemoizableUrl(url) {
  return url.startsWith('https:') || url.startsWith('http:');
}

/**
 * Decoded byte length of a data: URL payload, or 0 if `url` is not data:.
 * Malformed data: URLs report Infinity so callers treat them as too large.
 * @param {string} url
 */
export function inlineDecodedBytes(url) {
  if (!url.startsWith('data:')) return 0;
  const comma = url.indexOf(',');
  if (comma < 0) return Number.POSITIVE_INFINITY;
  const payloadChars = url.length - comma - 1;
  const meta = url.slice(5, comma);
  return meta.includes(';base64') ? Math.floor((payloadChars * 3) / 4) : payloadChars;
}

/**
 * @param {string} url
 * @param {number} [limit]
 */
export function isInlinePayloadTooLarge(url, limit = MAX_INLINE_SCAN_BYTES) {
  return inlineDecodedBytes(url) > limit;
}
