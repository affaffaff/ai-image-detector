/**
 * Highest-fidelity source selection.
 *
 * The shipped transform is Resize(short edge 440) + CenterCrop(384)
 * (models/manifest.json). Hand it an image whose short edge is under 440 and
 * that resize becomes an UPSCALE: the interpolator invents pixels, smooths away
 * the sensor noise and JPEG block structure the detector actually reads, and
 * leaves resampling artifacts that look like generation artifacts. It is the
 * pipeline's weakest measured regime — lowres TPR 0.76 against 0.833 pooled —
 * and it fails asymmetrically, toward false AI verdicts on real photographs.
 *
 * Search-results and gallery pages sit in that regime by construction. The
 * <img> in the grid is the host's own re-encoded ~250px thumbnail, so scoring
 * it measures Google's JPEG encoder as much as the photograph, while the
 * full-resolution original is one attribute away.
 *
 * So when the displayed source is too small to score without upscaling — or
 * is a search-engine thumbnail, which is a re-encode even above 440px — look
 * for a larger source for the SAME image:
 *
 *   1. srcset candidates wider than the one the browser picked. Same image by
 *      definition; `currentSrc` is chosen for the layout box and DPR, not for
 *      forensic fidelity.
 *   2. Lazy-load and zoom attributes (data-src, data-large-file, …) holding the
 *      original a viewer would open.
 *   3. An ancestor <a>, or a same-visual overlay <a>, that either points
 *      straight at an image or carries one in a query parameter — the shape
 *      every image search and CDN redirector uses (Google `imgres?imgurl=`,
 *      Bing `mediaurl=`, proxies `?url=`). Search grids often put that link
 *      beside the <img> rather than wrapping it.
 *
 * Ranked in that order because confidence that it is the same image falls as
 * you go down it. This module only proposes; the caller must still load each
 * candidate and confirm it is genuinely larger before scanning it, because
 * hotlink protection is common.
 *
 * Each candidate carries how strongly its provenance says "same file":
 *
 *   same-file  the URL itself asserts it — a MediaWiki original named by its
 *              own derivative, a srcset sibling, a lazy-load attribute, or a
 *              redirector parameter in which the host states which file this
 *              thumbnail was made from.
 *   linked     only "this picture sits inside a link to a picture".
 *
 * The caller checks aspect ratio on `linked` and NOT on `same-file`. That is
 * deliberate: search grids routinely crop their thumbnails to fit a layout, so
 * a same-file original legitimately differs in aspect from the tile that names
 * it, and rejecting it on geometry throws away the one source that would have
 * been scored correctly. Provenance is the stronger evidence; geometry is the
 * fallback for when there is no provenance at all.
 *
 * Upgrades are restricted to http(s). A candidate is a URL taken from page
 * content, and the offscreen host fetches it with <all_urls>; keeping the
 * scheme to what an <img> would have loaded anyway means this adds no reach the
 * page did not already have.
 */

/**
 * dataset keys, in the camelCase form the DOM exposes, that conventionally hold
 * a larger version of the rendered image.
 */
const LARGER_SOURCE_DATA_KEYS = [
  'zoomSrc',
  'hiResSrc',
  'largeFile',
  'origFile',
  'fullSrc',
  'largeSrc',
  'imageSrc',
  'original',
  'origsrc',
  'src',
  'lazySrc',
];

/**
 * @typedef {Object} UpgradeCandidate
 * @property {string} url
 * @property {'same-file' | 'linked'} confidence - how strongly the URL's
 *   provenance asserts this is the same picture. Decides whether the caller
 *   vetoes it on aspect ratio.
 */

/** Paths a bare <a href> must end in before it is treated as the image itself. */
const IMAGE_PATH = /\.(?:avif|bmp|gif|jpe?g|jxl|png|tiff?|webp)$/i;

/** Query parameters that image search engines and proxies use for the origin URL. */
const REDIRECT_PARAMS = new Set([
  'imgurl',
  'mediaurl',
  'imageurl',
  'image_url',
  'ou',
  'iu',
  'image',
  'url',
  'src',
  'u',
]);

/** Prefer image-named parameters over generic `url`/`src` (those often hold the article). */
const REDIRECT_PARAM_ORDER = [
  'imgurl',
  'mediaurl',
  'imageurl',
  'image_url',
  'ou',
  'iu',
  'image',
  'src',
  'url',
  'u',
];

/**
 * @param {string | null | undefined} raw
 * @param {string} base
 * @returns {string | null}
 */
function httpUrl(raw, base) {
  if (!raw) return null;
  try {
    const parsed = new URL(raw, base);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

/**
 * Parse a srcset attribute, keeping only entries carrying an explicit width
 * descriptor: an `x` descriptor says nothing about pixel count without knowing
 * the layout box, and the point here is pixel count.
 *
 * Candidates are separated by a comma that either follows a descriptor or is
 * followed by whitespace. Splitting on every comma would break the many CDN
 * URLs that contain them (`/upload/w_400,h_300/…`).
 *
 * @param {string | null | undefined} srcset
 * @param {string} base
 * @returns {Array<{url: string, width: number}>} widest first
 */
export function parseSrcset(srcset, base) {
  if (!srcset) return [];
  /** @type {Array<{url: string, width: number}>} */
  const out = [];
  for (const entry of String(srcset).split(/(?<=[0-9][wx])\s*,\s*|,\s+/)) {
    const parts = entry.trim().split(/\s+/);
    const descriptor = /^(\d+)w$/.exec(parts[1] ?? '');
    if (!descriptor) continue;
    const url = httpUrl(parts[0], base);
    if (url) out.push({ url, width: Number(descriptor[1]) });
  }
  return out.sort((a, b) => b.width - a.width);
}

/**
 * Pull an image URL out of a redirector's query string.
 * `imgres?…&imgurl=https%3A%2F%2Fcdn.example%2Fcat.jpg` -> the CDN URL.
 * @param {string | null | undefined} href
 * @returns {string | null}
 */
export function imageUrlFromQuery(href) {
  if (!href) return null;
  /** @type {URL} */
  let parsed;
  try {
    parsed = new URL(href);
  } catch {
    return null;
  }
  /** @type {Map<string, string>} */
  const byKey = new Map();
  for (const [key, value] of parsed.searchParams) {
    const k = key.toLowerCase();
    if (REDIRECT_PARAMS.has(k) && !byKey.has(k)) byKey.set(k, value);
  }
  for (const key of REDIRECT_PARAM_ORDER) {
    const value = byKey.get(key);
    if (!value) continue;
    // URLSearchParams has already percent-decoded the value.
    const inner = httpUrl(value, parsed.href);
    if (!inner || inner === parsed.href) continue;
    try {
      const host = new URL(inner).hostname;
      // A Google/Bing wrapper whose inner URL is another search page is not a file.
      if (/(?:^|\.)google(?:\.[a-z]+)+$/i.test(host) || /(?:^|\.)bing\.com$/i.test(host)) continue;
    } catch {
      continue;
    }
    return inner;
  }
  return null;
}

/**
 * Map a MediaWiki derivative back to the file it was generated from.
 *
 *   /wikipedia/commons/thumb/4/4d/Cat.jpg/960px-Cat.jpg  ->
 *   /wikipedia/commons/4/4d/Cat.jpg
 *
 * Worth special-casing because Commons is the single largest source of real
 * photographs on the web, and MediaWiki never serves the original in an article
 * or a search result — it serves a Lanczos-resampled derivative, which strips
 * precisely the sensor noise and JPEG block structure the detector reads. The
 * derivative also names its own original, so this cannot resolve to a different
 * image the way a gallery link can.
 *
 * The size segment is required in the match: a path merely containing "thumb"
 * is not a MediaWiki derivative.
 *
 * @param {string | null | undefined} href
 * @returns {string | null}
 */
export function mediaWikiOriginal(href) {
  if (!href) return null;
  /** @type {URL} */
  let parsed;
  try {
    parsed = new URL(href);
  } catch {
    return null;
  }
  const match = /^(.*)\/thumb(\/.+)\/[^/]*\d+px-[^/]*$/.exec(parsed.pathname);
  if (!match) return null;
  parsed.pathname = `${match[1]}${match[2]}`;
  parsed.search = '';
  return parsed.href;
}

/**
 * Rank the larger-source candidates worth probing for one image.
 *
 * @param {Object} input
 * @param {string} input.current        - URL that would otherwise be scanned
 * @param {number} input.shortEdge      - min(naturalWidth, naturalHeight) as loaded
 * @param {number} input.minShortEdge   - below this the transform upscales
 * @param {string} input.base           - document base URL, for relative refs
 * @param {string | null} [input.srcset]
 * @param {Record<string, string | undefined>} [input.dataset]
 * @param {string | null} [input.linkHref] - href of the nearest ancestor <a>
 * @param {string[]} [input.linkHrefs] - extra hrefs (overlay sibling links)
 * @param {number} [input.limit]        - max candidates to return
 * @returns {UpgradeCandidate[]} best first; empty when no upgrade is needed or
 *   none was found
 */
export function upgradeCandidates(input) {
  const { current, shortEdge, minShortEdge, base, srcset, dataset, linkHref, linkHrefs, limit = 3 } = input;

  // Already big enough to score on its own pixels. Not merely "no benefit" —
  // an upgrade costs a second network fetch per image, so the gate is what
  // keeps this off the pages that do not need it. Search-engine thumbnails are
  // the exception: encrypted-tbn / Bing TSE derivatives are re-encoded even
  // when they clear 440px, and scoring them is what made a Google Images tile
  // badge AI while the same picture's preview (the named original) did not.
  if (!(shortEdge > 0)) return [];
  if (shortEdge >= minShortEdge && !isSearchThumbnail(current)) return [];

  /** @type {UpgradeCandidate[]} */
  const ranked = [];
  const seen = new Set([current]);
  /** @param {string | null} url @param {UpgradeCandidate['confidence']} confidence */
  const push = (url, confidence) => {
    if (!url || seen.has(url)) return;
    // A MediaWiki derivative names the file it came from. Rank that ahead of
    // the derivative, keeping the derivative behind it in case the original has
    // been deleted or moved. Naming its own source makes it same-file however
    // weak the URL it was found on.
    const original = mediaWikiOriginal(url);
    if (original && !seen.has(original)) {
      seen.add(original);
      ranked.push({ url: original, confidence: 'same-file' });
    }
    seen.add(url);
    ranked.push({ url, confidence });
  };

  // Strongest candidate there is: the same file minus the resampling, named by
  // the rendered URL itself. `current` is already in `seen`, so its original
  // has to be offered explicitly.
  push(mediaWikiOriginal(current), 'same-file');

  for (const candidate of parseSrcset(srcset, base)) {
    if (candidate.width > shortEdge) push(candidate.url, 'same-file');
  }

  for (const key of LARGER_SOURCE_DATA_KEYS) {
    push(httpUrl(dataset?.[key], base), 'same-file');
  }

  // A redirector's query parameter is the host declaring "this thumbnail was
  // made from that file" — same-file on the page's own authority, even though
  // it was read off a link. Overlay siblings are included: search grids often
  // do not wrap the <img> in the <a> that carries imgurl.
  const hrefs = [];
  if (linkHref) hrefs.push(linkHref);
  if (linkHrefs) {
    for (const href of linkHrefs) {
      if (href) hrefs.push(href);
    }
  }
  for (const href of hrefs) {
    push(imageUrlFromQuery(href), 'same-file');
  }

  // Ranked last and the only weak class: a bare href is just "this picture sits
  // inside a link to a picture", which on a gallery is often the next photo.
  for (const href of hrefs) {
    const direct = httpUrl(href, base);
    if (direct && IMAGE_PATH.test(new URL(direct).pathname)) push(direct, 'linked');
  }

  return ranked.slice(0, limit);
}

/**
 * Hosts that serve a search engine's own re-encoded thumbnail, not the file
 * the page is naming. Forensic signal on these is the encoder, not the photo,
 * even when the bitmap is large enough that the model transform will not
 * upscale it.
 *
 * @param {string | null | undefined} href
 * @returns {boolean}
 */
export function isSearchThumbnail(href) {
  if (!href) return false;
  try {
    const host = new URL(href).hostname;
    return (
      /^encrypted-tbn[0-9]*\.gstatic\.com$/i.test(host) ||
      /^tse[0-9]*\.mm\.bing\.net$/i.test(host)
    );
  } catch {
    return false;
  }
}

/**
 * Identity for "the same file" across CDN query strings and MediaWiki
 * derivatives. Host + pathname only: `photo.jpg?w=1600` is still `photo.jpg`.
 * Search-engine thumbnails are excluded — those are a different encode.
 *
 * @param {string | null | undefined} href
 * @returns {string}
 */
export function imageResourceKey(href) {
  if (!href || isSearchThumbnail(href)) return '';
  const canonical = mediaWikiOriginal(href) || href;
  try {
    const parsed = new URL(canonical);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    let path = parsed.pathname;
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    return `${parsed.hostname.replace(/^www\./i, '').toLowerCase()}${path}`;
  } catch {
    return '';
  }
}

/**
 * @param {string | null | undefined} a
 * @param {string | null | undefined} b
 * @returns {boolean}
 */
export function sameImageResource(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const ka = imageResourceKey(a);
  const kb = imageResourceKey(b);
  return Boolean(ka && kb && ka === kb);
}
