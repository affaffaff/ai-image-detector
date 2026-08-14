"use strict";
(() => {
  // src/shared/messages.js
  var MSG = Object.freeze({
    // content -> SW (long-lived port, name PORT_SCAN)
    SCAN_REQUEST: "scan:request",
    SCAN_PRIORITY: "scan:priority",
    // SW -> content (same port)
    SCAN_UPDATE: "scan:update",
    // SW -> offscreen
    INFER_RUN: "infer:run",
    INFER_PRIORITY: "infer:priority",
    INFER_CANCEL: "infer:cancel",
    MODEL_STATUS_GET: "model:status-get",
    MODEL_DOWNLOAD: "model:download",
    // offscreen -> SW (unsolicited)
    MODEL_PROGRESS: "model:progress",
    // SW -> content scripts (all frames): weights just became usable
    MODEL_READY: "model:ready",
    // popup -> SW -> content: cosmetic blur of AI-scored images
    BLUR_SETTING: "blur:setting",
    // popup -> SW -> content: master scan enable (mirrors blur:setting so the
    // active tab does not wait on chrome.storage.onChanged)
    ENABLED_SETTING: "enabled:setting",
    // popup -> SW
    STATUS_GET: "status:get",
    MODEL_RETRY: "model:retry"
  }), PORT_SCAN = "scan", TARGET = Object.freeze({
    OFFSCREEN: "offscreen",
    SW: "sw"
  });

  // src/shared/constants.js
  var ENABLED_FLAG = "enabled";
  function flagFromStorage(value, fallback) {
    return value === void 0 ? fallback : !!value;
  }
  function readStoredFlag(liveApplied, stored, fallback) {
    return liveApplied ? null : flagFromStorage(stored, fallback);
  }
  function enabledFromStorage(value) {
    return flagFromStorage(value, !0);
  }
  var BLUR_AI_FLAG = "blurAiOptIn", BLUR_AI_DEFAULT = !1;
  function blurFromStorage(value) {
    return flagFromStorage(value, BLUR_AI_DEFAULT);
  }

  // src/offscreen/preprocess.js
  var IMAGENET_MEAN = Object.freeze([0.485, 0.456, 0.406]), IMAGENET_STD = Object.freeze([0.229, 0.224, 0.225]);
  var TILE_AGGREGATION = Object.freeze({
    MEAN: "mean-probability",
    MAX: "max-probability",
    TOP2: "top2-mean-probability",
    TOP3: "top3-mean-probability"
  }), DEFAULT_TILE_AGGREGATION = TILE_AGGREGATION.MAX;

  // src/content/source-upgrade.js
  var LARGER_SOURCE_DATA_KEYS = [
    "zoomSrc",
    "hiResSrc",
    "largeFile",
    "origFile",
    "fullSrc",
    "largeSrc",
    "imageSrc",
    "original",
    "origsrc",
    "src",
    "lazySrc"
  ], IMAGE_PATH = /\.(?:avif|bmp|gif|jpe?g|jxl|png|tiff?|webp)$/i, REDIRECT_PARAMS = /* @__PURE__ */ new Set([
    "imgurl",
    "mediaurl",
    "imageurl",
    "image_url",
    "ou",
    "iu",
    "image",
    "url",
    "src",
    "u"
  ]), REDIRECT_PARAM_ORDER = [
    "imgurl",
    "mediaurl",
    "imageurl",
    "image_url",
    "ou",
    "iu",
    "image",
    "src",
    "url",
    "u"
  ];
  function httpUrl(raw, base) {
    if (!raw) return null;
    try {
      let parsed = new URL(raw, base);
      return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
    } catch {
      return null;
    }
  }
  function parseSrcset(srcset, base) {
    if (!srcset) return [];
    let out = [];
    for (let entry of String(srcset).split(/(?<=[0-9][wx])\s*,\s*|,\s+/)) {
      let parts = entry.trim().split(/\s+/), descriptor = /^(\d+)w$/.exec(parts[1] ?? "");
      if (!descriptor) continue;
      let url = httpUrl(parts[0], base);
      url && out.push({ url, width: Number(descriptor[1]) });
    }
    return out.sort((a, b) => b.width - a.width);
  }
  function imageUrlFromQuery(href) {
    if (!href) return null;
    let parsed;
    try {
      parsed = new URL(href);
    } catch {
      return null;
    }
    let byKey = /* @__PURE__ */ new Map();
    for (let [key, value] of parsed.searchParams) {
      let k = key.toLowerCase();
      REDIRECT_PARAMS.has(k) && !byKey.has(k) && byKey.set(k, value);
    }
    for (let key of REDIRECT_PARAM_ORDER) {
      let value = byKey.get(key);
      if (!value) continue;
      let inner = httpUrl(value, parsed.href);
      if (!(!inner || inner === parsed.href)) {
        try {
          let host = new URL(inner).hostname;
          if (/(?:^|\.)google(?:\.[a-z]+)+$/i.test(host) || /(?:^|\.)bing\.com$/i.test(host)) continue;
        } catch {
          continue;
        }
        return inner;
      }
    }
    return null;
  }
  function mediaWikiOriginal(href) {
    if (!href) return null;
    let parsed;
    try {
      parsed = new URL(href);
    } catch {
      return null;
    }
    let match = /^(.*)\/thumb(\/.+)\/[^/]*\d+px-[^/]*$/.exec(parsed.pathname);
    return match ? (parsed.pathname = `${match[1]}${match[2]}`, parsed.search = "", parsed.href) : null;
  }
  function upgradeCandidates(input) {
    let { current, shortEdge, minShortEdge, base, srcset, dataset, linkHref, linkHrefs, limit = 3 } = input;
    if (!(shortEdge > 0)) return [];
    if (shortEdge >= minShortEdge && !isSearchThumbnail(current)) return [];
    let ranked = [], seen = /* @__PURE__ */ new Set([current]), push = (url, confidence) => {
      if (!url || seen.has(url)) return;
      let original = mediaWikiOriginal(url);
      original && !seen.has(original) && (seen.add(original), ranked.push({ url: original, confidence: "same-file" })), seen.add(url), ranked.push({ url, confidence });
    };
    push(mediaWikiOriginal(current), "same-file");
    for (let candidate of parseSrcset(srcset, base))
      candidate.width > shortEdge && push(candidate.url, "same-file");
    for (let key of LARGER_SOURCE_DATA_KEYS)
      push(httpUrl(dataset?.[key], base), "same-file");
    let hrefs = [];
    if (linkHref && hrefs.push(linkHref), linkHrefs)
      for (let href of linkHrefs)
        href && hrefs.push(href);
    for (let href of hrefs)
      push(imageUrlFromQuery(href), "same-file");
    for (let href of hrefs) {
      let direct = httpUrl(href, base);
      direct && IMAGE_PATH.test(new URL(direct).pathname) && push(direct, "linked");
    }
    return ranked.slice(0, limit);
  }
  function isSearchThumbnail(href) {
    if (!href) return !1;
    try {
      let host = new URL(href).hostname;
      return /^encrypted-tbn[0-9]*\.gstatic\.com$/i.test(host) || /^tse[0-9]*\.mm\.bing\.net$/i.test(host);
    } catch {
      return !1;
    }
  }
  function imageResourceKey(href) {
    if (!href || isSearchThumbnail(href)) return "";
    let canonical = mediaWikiOriginal(href) || href;
    try {
      let parsed = new URL(canonical);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
      let path = parsed.pathname;
      return path.length > 1 && path.endsWith("/") && (path = path.slice(0, -1)), `${parsed.hostname.replace(/^www\./i, "").toLowerCase()}${path}`;
    } catch {
      return "";
    }
  }

  // src/shared/inline-payload.js
  function inlineDecodedBytes(url) {
    if (!url.startsWith("data:")) return 0;
    let comma = url.indexOf(",");
    if (comma < 0) return Number.POSITIVE_INFINITY;
    let payloadChars = url.length - comma - 1, meta = url.slice(5, comma);
    return /;base64/i.test(meta) ? Math.floor(payloadChars * 3 / 4) : payloadChars;
  }
  function isInlinePayloadTooLarge(url, limit = 2097152) {
    return inlineDecodedBytes(url) > limit;
  }

  // src/content/candidate.js
  function classifyImageCandidate(input) {
    return !input.url || !/^(https?:|data:)/.test(input.url) ? "wait-source" : isSvgImageUrl(input.url) || isInlinePayloadTooLarge(input.url) ? "skip" : !input.complete || input.naturalWidth === 0 || input.naturalHeight === 0 ? "wait-load" : Math.min(input.displayedWidth, input.displayedHeight) < input.minEdge ? "skip" : "scan";
  }
  function plainRect(box) {
    return {
      left: box.left,
      top: box.top,
      right: box.right,
      bottom: box.bottom,
      width: box.width,
      height: box.height
    };
  }
  function fittedImageRect(input) {
    let { box, naturalWidth, naturalHeight } = input;
    if (!(box.width > 0 && box.height > 0 && naturalWidth > 0 && naturalHeight > 0))
      return plainRect(box);
    let containScale = Math.min(box.width / naturalWidth, box.height / naturalHeight), width = box.width, height = box.height;
    switch (input.objectFit) {
      case "contain":
        width = naturalWidth * containScale, height = naturalHeight * containScale;
        break;
      case "none":
        width = naturalWidth, height = naturalHeight;
        break;
      case "scale-down": {
        let scale = Math.min(1, containScale);
        width = naturalWidth * scale, height = naturalHeight * scale;
        break;
      }
      default:
        return plainRect(box);
    }
    let tokens = input.objectPosition.trim().toLowerCase().split(/\s+/).filter(Boolean), first = tokens[0] ?? "50%", second = tokens[1] ?? "50%", verticalFirst = first === "top" || first === "bottom", xToken = verticalFirst ? second : first, yToken = verticalFirst ? first : second, positionOffset = (token, free) => {
      if (token === "left" || token === "top") return 0;
      if (token === "center") return free / 2;
      if (token === "right" || token === "bottom") return free;
      if (token.endsWith("%")) {
        let value = Number.parseFloat(token);
        return Number.isFinite(value) ? free * value / 100 : free / 2;
      }
      if (token.endsWith("px")) {
        let value = Number.parseFloat(token);
        return Number.isFinite(value) ? value : free / 2;
      }
      return free / 2;
    }, rawLeft = box.left + positionOffset(xToken, box.width - width), rawTop = box.top + positionOffset(yToken, box.height - height), left = Math.max(box.left, rawLeft), top2 = Math.max(box.top, rawTop), right = Math.min(box.right, rawLeft + width), bottom = Math.min(box.bottom, rawTop + height);
    return {
      left,
      top: top2,
      right,
      bottom,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top2)
    };
  }
  function classifyPaintedCandidate(input) {
    return !input.url || !/^(https?:|data:)/.test(input.url) ? "wait-source" : isSvgImageUrl(input.url) || isInlinePayloadTooLarge(input.url) || Math.min(input.displayedWidth, input.displayedHeight) < input.minEdge ? "skip" : "scan";
  }
  function isSvgImageUrl(url) {
    let value = url.trim().toLowerCase();
    return /^data:image\/svg(?:\+xml)?[;,]/.test(value) || /\.svg(?:[?#]|$)/.test(value);
  }
  function cssBackgroundUrls(value) {
    if (!value || value === "none") return [];
    let urls = [], re = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
    for (let match = re.exec(value); match; match = re.exec(value)) {
      let raw = (match[2] ?? "").trim();
      raw && (isSvgImageUrl(raw) || urls.push(raw));
    }
    return urls;
  }
  function isBackgroundWatchTag(tagName) {
    switch (tagName) {
      case "SCRIPT":
      case "STYLE":
      case "LINK":
      case "META":
      case "HEAD":
      case "NOSCRIPT":
      case "BR":
      case "HR":
      case "TEMPLATE":
      case "IFRAME":
      case "SVG":
      case "PATH":
      case "CANVAS":
      case "VIDEO":
      case "AUDIO":
      case "SOURCE":
      case "TRACK":
      case "INPUT":
      case "TEXTAREA":
      case "SELECT":
      case "OPTION":
        return !1;
      default:
        return !0;
    }
  }
  function resetImageObservation(observer, image) {
    observer.unobserve(image), observer.observe(image);
  }
  function attributeResetsObservation(isImage, attributeName) {
    return isImage ? attributeName === "src" || attributeName === "srcset" : attributeName === "class" || attributeName === "style";
  }
  var OVERFLOW_SCROLLS = /(auto|scroll|overlay)/;
  function overflowCanScroll(overflowX, overflowY) {
    return OVERFLOW_SCROLLS.test(overflowX) || OVERFLOW_SCROLLS.test(overflowY);
  }
  function overflowParentIsScroller(input) {
    return overflowCanScroll(input.overflowX, input.overflowY) ? input.position === "fixed" || input.position === "sticky" || input.treatAsScroller ? !0 : OVERFLOW_SCROLLS.test(input.overflowY) && input.scrollHeight > input.clientHeight || OVERFLOW_SCROLLS.test(input.overflowX) && input.scrollWidth > input.clientWidth : !1;
  }
  function insetClipForOccluder(clip, occluder) {
    let clipW = clip.right - clip.left, clipH = clip.bottom - clip.top;
    if (!(clipW > 0 && clipH > 0)) return clip;
    let overlapW = Math.max(
      0,
      Math.min(clip.right, occluder.right) - Math.max(clip.left, occluder.left)
    ), overlapH = Math.max(
      0,
      Math.min(clip.bottom, occluder.bottom) - Math.max(clip.top, occluder.top)
    );
    if (!(overlapW > 0 && overlapH > 0) || overlapW >= clipW * 0.95 && overlapH >= clipH * 0.95) return clip;
    let next = { left: clip.left, top: clip.top, right: clip.right, bottom: clip.bottom };
    return occluder.top <= clip.top + 1 && occluder.bottom < clip.top + clipH * 0.5 && overlapW >= clipW * 0.5 && (next.top = Math.max(next.top, occluder.bottom)), occluder.bottom >= clip.bottom - 1 && occluder.top > clip.bottom - clipH * 0.5 && overlapW >= clipW * 0.5 && (next.bottom = Math.min(next.bottom, occluder.top)), occluder.left <= clip.left + 1 && occluder.right < clip.left + clipW * 0.5 && overlapH >= clipH * 0.5 && (next.left = Math.max(next.left, occluder.right)), occluder.right >= clip.right - 1 && occluder.left >= clip.left + clipW * 0.4 && overlapH >= clipH * 0.5 && (next.right = Math.min(next.right, occluder.left)), next;
  }
  function isRectInViewport(rect, viewport) {
    return rect.bottom > 0 && rect.right > 0 && rect.top < viewport.height && rect.left < viewport.width;
  }
  function compareViewportCandidates(a, b, viewport) {
    let visibleArea = (rect) => {
      let width = Math.max(0, Math.min(rect.right, viewport.width) - Math.max(rect.left, 0)), height = Math.max(0, Math.min(rect.bottom, viewport.height) - Math.max(rect.top, 0));
      return width * height;
    }, areaDifference = visibleArea(b) - visibleArea(a);
    if (areaDifference !== 0) return areaDifference;
    let viewportX = viewport.width / 2, viewportY = viewport.height / 2, centreDistance = (rect) => {
      let x = (Math.max(rect.left, 0) + Math.min(rect.right, viewport.width)) / 2, y = (Math.max(rect.top, 0) + Math.min(rect.bottom, viewport.height)) / 2;
      return (x - viewportX) ** 2 + (y - viewportY) ** 2;
    };
    return centreDistance(a) - centreDistance(b) || a.top - b.top || a.left - b.left;
  }
  function shouldRenderBadge(phase, probability, inNestedFrame = !1) {
    return phase === "pending" || phase === "scored" && typeof probability == "number" && Number.isFinite(probability) ? !0 : !!inNestedFrame && phase === "no-model";
  }
  function isHostTopmostAtPoint(host, hitStack, overlayHost, overlayNodes = [], isAssociatedOverlay = () => !1) {
    let skip = new Set(overlayNodes), top2 = hitStack.find((element) => element !== overlayHost && !skip.has(element));
    return !!(top2 && (top2 === host || host.contains(top2) || top2.contains(host) || isAssociatedOverlay(top2)));
  }
  function isPageLayerOccluder(hostBox, occluderBox, margin = 4) {
    return occluderBox.left < hostBox.left - margin || occluderBox.top < hostBox.top - margin || occluderBox.right > hostBox.right + margin || occluderBox.bottom > hostBox.bottom + margin;
  }
  function shouldHideBadgeForOccluder(hostIsTopmost, occluderPosition = "", pageLayerOccludes = !1) {
    return hostIsTopmost ? !1 : occluderPosition === "fixed" || occluderPosition === "sticky" ? !0 : pageLayerOccludes;
  }
  function isSameVisualInteractionOverlay(input) {
    if (input.position === "fixed" || input.position === "sticky" || input.hostAncestorDistance > 4 || input.overlayAncestorDistance > 2) return !1;
    let hostWidth = Math.max(0, input.hostRect.right - input.hostRect.left), hostHeight = Math.max(0, input.hostRect.bottom - input.hostRect.top), overlayWidth = Math.max(0, input.overlayRect.right - input.overlayRect.left), overlayHeight = Math.max(0, input.overlayRect.bottom - input.overlayRect.top), hostArea = hostWidth * hostHeight, overlayArea = overlayWidth * overlayHeight;
    if (!(hostArea > 0 && overlayArea > 0)) return !1;
    let intersectionWidth = Math.max(
      0,
      Math.min(input.hostRect.right, input.overlayRect.right) - Math.max(input.hostRect.left, input.overlayRect.left)
    ), intersectionHeight = Math.max(
      0,
      Math.min(input.hostRect.bottom, input.overlayRect.bottom) - Math.max(input.hostRect.top, input.overlayRect.top)
    );
    return intersectionWidth * intersectionHeight / Math.max(hostArea, overlayArea) >= 0.85;
  }
  function isPreviewPaneBox(box, viewportWidth) {
    return box.left > viewportWidth * 0.45 && Math.min(box.width, box.height) > 160;
  }
  function smallerRectOverlap(a, b) {
    let width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)), height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)), intersection = width * height, areaA = Math.max(0, a.right - a.left) * Math.max(0, a.bottom - a.top), areaB = Math.max(0, b.right - b.left) * Math.max(0, b.bottom - b.top), smaller = Math.min(areaA, areaB);
    return smaller > 0 ? intersection / smaller : 0;
  }
  function badgeAnchorPoint(input) {
    let { rect, clip, inset } = input, minVisible = input.minVisible ?? 0, left = Math.max(rect.left, clip.left), top2 = Math.max(rect.top, clip.top), right = Math.min(rect.right, clip.right), bottom = Math.min(rect.bottom, clip.bottom);
    return right - left > minVisible && bottom - top2 > minVisible ? { x: Math.min(left + inset, right), y: Math.min(top2 + inset, bottom), visible: !0 } : { x: 0, y: 0, visible: !1 };
  }
  function shouldSuppressDuplicateBadge(candidate, keeper) {
    return smallerRectOverlap(candidate.host, keeper.host) >= 0.8 ? candidate.url === keeper.url ? !0 : smallerRectOverlap(candidate.badge, keeper.badge) > 0 : !1;
  }

  // src/content/url-registry.js
  var UrlRegistry = class {
    /** @param {number} cacheMax */
    constructor(cacheMax) {
      if (!Number.isInteger(cacheMax) || cacheMax <= 0)
        throw new RangeError("cacheMax must be a positive integer");
      this.cacheMax = cacheMax, this.cache = /* @__PURE__ */ new Map(), this.inFlight = /* @__PURE__ */ new Map();
    }
    /**
     * Memoized result for a URL, or null. A hit refreshes recency so a URL an
     * infinite feed keeps recycling is not the one we evict.
     * @param {string} url
     * @returns {ScanUpdate | null}
     */
    get(url) {
      let hit = this.cache.get(url);
      return hit ? (this.cache.delete(url), this.cache.set(url, hit), hit) : null;
    }
    /**
     * Memoize a scored result, evicting the least recently used past the cap.
     * Map preserves insertion order, which is what makes this an LRU.
     * @param {string} url
     * @param {ScanUpdate} update
     */
    remember(url, update) {
      for (this.cache.delete(url), this.cache.set(url, update); this.cache.size > this.cacheMax; ) {
        let oldest = this.cache.keys().next();
        if (oldest.done) break;
        this.cache.delete(oldest.value);
      }
    }
    /**
     * Register an image as waiting on a URL.
     * @param {string} url
     * @param {string} id
     * @returns {boolean} true if the caller must send the request; false if one
     *                    is already out and this id has been added as a waiter.
     */
    join(url, id) {
      let existing = this.inFlight.get(url);
      return existing ? (existing.add(id), !1) : (this.inFlight.set(url, /* @__PURE__ */ new Set([id])), !0);
    }
    /**
     * Request id that owns the in-flight work for a URL. Duplicate DOM elements
     * use this id when promoting a now-visible image, so the queue reprioritizes
     * the one real inference job rather than a waiter that has no job of its own.
     * @param {string} url
     * @returns {string | null}
     */
    requestIdFor(url) {
      let first = this.inFlight.get(url)?.values().next();
      return first && !first.done ? first.value : null;
    }
    /**
     * URL that currently has this image id waiting, or null.
     * Needed when the requesting element has been removed (infinite scroll)
     * but other images on the same URL are still waiting for the result.
     * @param {string} id
     * @returns {string | null}
     */
    urlForWaiter(id) {
      for (let [url, waiters] of this.inFlight)
        if (waiters.has(id)) return url;
      return null;
    }
    /**
     * Take every id waiting on a URL and clear the entry.
     * @param {string} url
     * @param {string} [fallbackId] - used when the entry is already gone
     * @returns {Set<string>}
     */
    settle(url, fallbackId) {
      let waiters = this.inFlight.get(url) ?? new Set(fallbackId ? [fallbackId] : []);
      return this.inFlight.delete(url), waiters;
    }
    /**
     * Find the in-flight URL that includes this requester id, then settle it.
     * Needed when the requesting DOM node is gone (infinite scroll) but other
     * images on the same URL are still waiting.
     * @param {string} id
     * @returns {{url: string, waiters: Set<string>} | null}
     */
    settleById(id) {
      for (let [url, waiters] of this.inFlight)
        if (waiters.has(id))
          return this.inFlight.delete(url), { url, waiters };
      return null;
    }
    /**
     * Forget every in-flight request. Call when the port drops: the worker that
     * owned those requests is gone, so nothing is actually in flight any more.
     * Do not call this for a single `no-model` result — other URLs may still
     * score, and their co-waiters live in this map.
     * The cache is deliberately kept — those are real inference results and
     * survive a worker restart perfectly well.
     */
    reset() {
      this.inFlight.clear();
    }
  };

  // src/content/model-gate.js
  var ModelGate = class {
    constructor() {
      this.unavailable = !1, this.provenUsable = !1;
    }
    /** @returns {boolean} true if this call newly entered the unavailable state */
    enter() {
      return this.provenUsable || this.unavailable ? !1 : (this.unavailable = !0, !0);
    }
    /**
     * Record that weights work. Clears the latch if it was set.
     * @returns {boolean} true if the latch was set and is now cleared
     */
    markUsable() {
      return this.provenUsable = !0, this.unavailable ? (this.unavailable = !1, !0) : !1;
    }
    /**
     * Lift the latch for one probe request without claiming the model works.
     * Used after a service-worker restart: MODEL_READY may already have been
     * sent, and scored replies cannot arrive while `requestScan` is blocked.
     * @returns {boolean} true if a probe request may now be sent
     */
    allowProbe() {
      return this.provenUsable || !this.unavailable ? !1 : (this.unavailable = !1, !0);
    }
    reset() {
      this.unavailable = !1, this.provenUsable = !1;
    }
  };

  // src/content/blur-cover.js
  function blurCoverScale(width, height, blurPx = 22) {
    let min = Math.min(width, height);
    return !(min > 0) || !Number.isFinite(min) ? 1.2 : Math.min(2.4, Math.max(1.12, 1 + (2 * blurPx + 8) / min));
  }

  // src/content/overlay-nodes.js
  var OVERLAY_ATTR = "data-ai-image-detector", OVERLAY_ATTR_VALUE = "overlay", OVERLAY_SELECTOR = `[${OVERLAY_ATTR}="${OVERLAY_ATTR_VALUE}"]`, LEGACY_OVERLAY_SELECTOR = 'div[style*="position-anchor"][style*="--aid-"]', LEGACY_HOST_SELECTOR = 'div[style*="z-index:2147483647"][style*="width:0"][style*="height:0"]', OVERLAY_HIDE_STYLE_ID = "ai-image-detector-off", OVERLAY_HIDE_CSS = `${OVERLAY_SELECTOR},${LEGACY_OVERLAY_SELECTOR},${LEGACY_HOST_SELECTOR}{display:none!important;visibility:hidden!important;pointer-events:none!important}`, OVERLAY_INLINE_HIDE_ATTR = "data-ai-image-detector-hidden";
  function hideOverlayNodeInline(node) {
    let style = node.style;
    if (!style || typeof style.setProperty != "function" || typeof node.getAttribute == "function" && node.getAttribute(OVERLAY_INLINE_HIDE_ATTR))
      return;
    let previous = JSON.stringify([
      style.getPropertyValue("display"),
      style.getPropertyPriority("display")
    ]);
    style.setProperty("display", "none", "important"), node.setAttribute?.(OVERLAY_INLINE_HIDE_ATTR, previous);
  }
  function restoreOverlayNodeInline(node) {
    if (typeof node.getAttribute != "function") return;
    let recorded = node.getAttribute(OVERLAY_INLINE_HIDE_ATTR);
    if (!recorded) return;
    node.removeAttribute?.(OVERLAY_INLINE_HIDE_ATTR);
    let style = node.style;
    if (!(!style || typeof style.setProperty != "function"))
      try {
        let [value, priority] = (
          /** @type {[string, string]} */
          JSON.parse(recorded)
        );
        value ? style.setProperty("display", value, priority || "") : style.removeProperty("display");
      } catch {
        style.removeProperty("display");
      }
  }
  var OVERLAY_FIND_SELECTORS = [
    OVERLAY_SELECTOR,
    LEGACY_OVERLAY_SELECTOR,
    LEGACY_HOST_SELECTOR
  ];
  function markOverlayNode(node) {
    node.setAttribute(OVERLAY_ATTR, OVERLAY_ATTR_VALUE);
  }
  function isOverlayNode(node) {
    if (!node || typeof node != "object") return !1;
    let el = (
      /** @type {{getAttribute?: (name: string) => string | null, localName?: string}} */
      node
    );
    if (typeof el.getAttribute != "function") return !1;
    if (el.getAttribute(OVERLAY_ATTR) === OVERLAY_ATTR_VALUE) return !0;
    if (el.localName !== "div") return !1;
    let style = el.getAttribute("style");
    return typeof style == "string" && style.includes("position-anchor") && style.includes("--aid-");
  }
  function overlayNodesIn(root) {
    let seen = /* @__PURE__ */ new Set(), nodes = [];
    for (let selector of OVERLAY_FIND_SELECTORS) {
      let list = root.querySelectorAll(selector);
      for (let i = 0; i < list.length; i++) {
        let node = list[i];
        !node || seen.has(node) || (seen.add(node), nodes.push(node));
      }
    }
    return nodes;
  }
  function hideOverlayNodes(doc) {
    let root = doc.documentElement;
    if (!root) return;
    if (typeof doc.getElementById != "function" || !doc.getElementById(OVERLAY_HIDE_STYLE_ID)) {
      let style = doc.createElement("style");
      style.id = OVERLAY_HIDE_STYLE_ID, style.textContent = OVERLAY_HIDE_CSS, root.appendChild(style);
    }
    if (typeof doc.querySelectorAll != "function") return;
    let nodes = overlayNodesIn(
      /** @type {{querySelectorAll: (selector: string) => ArrayLike<{remove: () => void}>}} */
      /** @type {unknown} */
      doc
    );
    for (let i = 0; i < nodes.length; i++) {
      let node = (
        /** @type {Parameters<typeof hideOverlayNodeInline>[0] | undefined} */
        nodes[i]
      );
      node && hideOverlayNodeInline(node);
    }
  }
  function clearOverlayHide(doc) {
    if ((typeof doc.getElementById == "function" ? doc.getElementById(OVERLAY_HIDE_STYLE_ID) : null)?.remove?.(), typeof doc.querySelectorAll != "function") return;
    let hidden = doc.querySelectorAll(`[${OVERLAY_INLINE_HIDE_ATTR}]`);
    for (let i = 0; i < hidden.length; i++) {
      let node = (
        /** @type {Parameters<typeof restoreOverlayNodeInline>[0] | undefined} */
        hidden[i]
      );
      node && restoreOverlayNodeInline(node);
    }
  }
  function removeOverlayNodes(root) {
    let nodes = overlayNodesIn(root);
    for (let i = nodes.length - 1; i >= 0; i--)
      nodes[i]?.remove();
  }

  // src/content/scanner.js
  var seq = 0, pageId = Math.random().toString(36).slice(2, 8), epoch = 0, states = /* @__PURE__ */ new WeakMap(), byId = /* @__PURE__ */ new Map(), registry = new UrlRegistry(400), waitingForLoad = /* @__PURE__ */ new WeakSet(), blobResolved = /* @__PURE__ */ new WeakMap(), blobInFlight = /* @__PURE__ */ new WeakSet(), upgradeResolved = /* @__PURE__ */ new WeakMap(), upgradeInFlight = /* @__PURE__ */ new WeakSet(), waitingForOrigin = /* @__PURE__ */ new Set(), deferredWhileHidden = /* @__PURE__ */ new Set(), searchThumbFallbackDue = /* @__PURE__ */ new WeakSet(), searchThumbFallbackTimer = /* @__PURE__ */ new WeakMap(), lastActivatedThumb = null, viewerOriginal = null, enabled = !1, receivedLiveEnabled = !1, blurAiImages = BLUR_AI_DEFAULT, receivedLiveBlur = !1, started = !1, contextInvalidated = !1, waitingForDocumentRoot = !1, modelGate = new ModelGate(), rescanQueued = !1, staleNoModelRetried = /* @__PURE__ */ new Set(), lastVisiblePriorityBase = 0;
  function nextVisiblePriorityBase() {
    return lastVisiblePriorityBase = Math.max(Date.now(), lastVisiblePriorityBase + 1), 1 + lastVisiblePriorityBase;
  }
  function currentScanPriority(el) {
    if (document.visibilityState === "hidden") return 0;
    let rect = el.getBoundingClientRect();
    return isRectInViewport(rect, { width: window.innerWidth, height: window.innerHeight }) ? nextVisiblePriorityBase() + 0.5 : 0;
  }
  var overlayRoot = null, nativeAnchorPositioning = typeof CSS < "u" && CSS.supports("anchor-name: --aid-anchor") && CSS.supports("position-anchor: --aid-anchor") && CSS.supports("left: anchor(left)"), nativeAnchorFill = nativeAnchorPositioning && typeof CSS < "u" && CSS.supports("right: anchor(right)") && CSS.supports("bottom: anchor(bottom)"), nativeAnchorSeq = 0;
  function nativeAnchorWorksFor(host) {
    return nativeAnchorPositioning && host.getRootNode() === document;
  }
  var hostAnchorNames = /* @__PURE__ */ new WeakMap(), nativeBadgeBindings = /* @__PURE__ */ new WeakMap(), nativeVeilBindings = /* @__PURE__ */ new WeakMap(), badgePlacementRetries = /* @__PURE__ */ new WeakMap(), overlayStyles = `
  .badge {
    position: fixed;
    font: 700 10px/1.7 ui-monospace, Consolas, "Cascadia Mono", monospace;
    color: #eaffff;
    letter-spacing: .4px;
    padding: 0 7px;
    border-radius: 3px;
    border: 1px solid transparent;
    pointer-events: auto;
    cursor: default;
    white-space: nowrap;
    user-select: none;
  }
  .badge::before {
    content: "";
    position: absolute;
    top: 1px; left: 1px;
    width: 4px; height: 4px;
    border-top: 1px solid currentColor;
    border-left: 1px solid currentColor;
    opacity: .85;
    pointer-events: none;
  }
  .ai {
    background: rgba(30,4,18,.88);
    color: #ff4d8d;
    border-color: rgba(255,45,120,.85);
    box-shadow: 0 0 10px rgba(255,45,120,.45), inset 0 0 6px rgba(255,45,120,.18);
  }
  .real {
    background: rgba(2,16,14,.88);
    color: #00ff9f;
    border-color: rgba(0,255,159,.7);
    box-shadow: 0 0 8px rgba(0,255,159,.35), inset 0 0 6px rgba(0,255,159,.14);
  }
  .mock {
    background: rgba(4,7,15,.88);
    color: #00f0ff;
    border-color: rgba(0,240,255,.6);
    box-shadow: 0 0 8px rgba(0,240,255,.25);
  }
  .pending {
    background: rgba(4,7,15,.82);
    color: #8feaf2;
    border-color: rgba(143,234,242,.48);
    box-shadow: 0 0 7px rgba(0,240,255,.18);
    opacity: .82;
  }
  .setup {
    background: rgba(18,12,2,.88);
    color: #ffd257;
    border-color: rgba(251,191,36,.75);
    box-shadow: 0 0 8px rgba(251,191,36,.35);
  }
  .setup-notice {
    position: fixed;
    right: 14px;
    bottom: 14px;
    max-width: min(280px, calc(100vw - 28px));
    box-sizing: border-box;
    background: rgba(18,12,2,.94);
    color: #ffd257;
    font: 700 11px/1.45 ui-monospace, Consolas, "Cascadia Mono", monospace;
    letter-spacing: .25px;
    padding: 8px 11px;
    border: 1px solid rgba(251,191,36,.7);
    border-radius: 4px;
    box-shadow: 0 4px 18px rgba(0,0,0,.38), 0 0 8px rgba(251,191,36,.2);
    pointer-events: none;
  }
  .badge.scored { cursor: pointer; }
  /* Provisional: this number came from the rendered thumbnail and a
     full-resolution re-scan is in flight. */
  .badge.restating { opacity: .55; }
  .popover {
    position: fixed;
    min-width: 200px;
    max-width: 280px;
    background: rgba(5,9,20,.97);
    color: #c8d4f0;
    font: 11px/1.55 ui-monospace, Consolas, "Cascadia Mono", monospace;
    padding: 10px 12px;
    border-radius: 3px;
    border: 1px solid rgba(0,240,255,.45);
    box-shadow: 0 0 18px rgba(0,240,255,.22), 0 4px 18px rgba(0,0,0,.55);
    pointer-events: auto;
    z-index: 1;
  }
  .popover > div:first-child {
    color: #00f0ff;
    font-weight: 700;
    font-size: 13px;
    letter-spacing: .5px;
    text-shadow: 0 0 8px rgba(0,240,255,.6);
    margin-bottom: 2px;
  }
  .popover .k { color: #5b6b8c; letter-spacing: .3px; }
  .popover .bits { color: #00f0ff; font-variant-numeric: tabular-nums; }
  .popover .blur-toggle {
    display: block;
    width: 100%;
    margin-top: 8px;
    padding: 6px 8px;
    border: 1px solid rgba(255,45,120,.75);
    border-radius: 2px;
    background: rgba(255,45,120,.12);
    color: #ffd0e2;
    font: 700 10px/1.2 ui-monospace, Consolas, "Cascadia Mono", monospace;
    letter-spacing: 1.1px;
    text-transform: uppercase;
    cursor: pointer;
  }
  .popover .blur-toggle:hover { background: rgba(255,45,120,.22); }
  .popover .blur-toggle.show {
    border-color: rgba(0,240,255,.55);
    background: rgba(0,240,255,.1);
    color: #c8f7ff;
  }
  .popover .blur-toggle.show:hover { background: rgba(0,240,255,.18); }
  .blur-veil {
    position: fixed;
    display: flex;
    align-items: center;
    justify-content: center;
    appearance: none;
    -webkit-appearance: none;
    border: 0;
    outline: none;
    box-shadow: none;
    padding: 0;
    margin: 0;
    overflow: hidden;
    background: transparent;
    color: #f4f7ff;
    font: 700 11px/1.2 ui-monospace, Consolas, "Cascadia Mono", monospace;
    letter-spacing: 1.2px;
    text-transform: uppercase;
    cursor: pointer;
    pointer-events: auto;
    z-index: 0;
  }
  .blur-clip {
    position: absolute;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
    border-radius: inherit;
  }
  .blur-clone {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    max-width: none;
    max-height: none;
    margin: 0;
    padding: 0;
    border: 0;
    display: block;
    pointer-events: none;
    object-fit: cover;
    transform: scale(var(--aid-blur-scale, 1.2));
    transform-origin: center;
    filter: blur(0);
    opacity: 0;
    transition: filter ${280}ms ease, opacity ${280}ms ease;
  }
  .blur-dim {
    position: absolute;
    inset: 0;
    pointer-events: none;
    background: rgba(12, 2, 10, 0);
    transition: background ${280}ms ease;
  }
  .blur-veil-label {
    position: relative;
    z-index: 1;
    opacity: 0;
    transition: opacity ${280}ms ease;
    text-shadow: 0 1px 8px rgba(0, 0, 0, 0.85);
  }
  .blur-veil.in .blur-clone {
    opacity: 1;
    filter: blur(${22}px);
  }
  .blur-veil.in .blur-dim { background: rgba(12, 2, 10, 0.38); }
  .blur-veil.in .blur-veil-label { opacity: 1; }
  .blur-veil.bg-cover {
    backdrop-filter: blur(0);
    transition: backdrop-filter ${280}ms ease;
  }
  .blur-veil.bg-cover.in { backdrop-filter: blur(${22}px); }
  @media (prefers-reduced-motion: reduce) {
    .blur-clone, .blur-dim, .blur-veil-label, .blur-veil.bg-cover {
      transition: none;
    }
  }
  .hud {
    position: fixed;
    bottom: 10px;
    left: 10px;
    background: rgba(4,7,15,.94);
    color: #00f0ff;
    font: 600 11px/1.8 ui-monospace, Consolas, "Cascadia Mono", monospace;
    letter-spacing: 1px;
    padding: 0 12px;
    border-radius: 2px;
    border: 1px solid rgba(0,240,255,.5);
    box-shadow: 0 0 12px rgba(0,240,255,.3);
    pointer-events: none;
  }
`;
  function scrollContainerFor(host) {
    let nearestOverflowCapable = null;
    for (let parent = host.parentElement; parent && parent !== document.documentElement; parent = parent.parentElement) {
      let style = getComputedStyle(parent), pos = style.position;
      if (overflowParentIsScroller({
        overflowX: style.overflowX,
        overflowY: style.overflowY,
        scrollWidth: parent.scrollWidth,
        clientWidth: parent.clientWidth,
        scrollHeight: parent.scrollHeight,
        clientHeight: parent.clientHeight,
        position: pos
      }))
        return parent;
      if (!nearestOverflowCapable && overflowCanScroll(style.overflowX, style.overflowY) && (nearestOverflowCapable = parent), (pos === "fixed" || pos === "sticky") && nearestOverflowCapable)
        return nearestOverflowCapable;
    }
    return document.documentElement;
  }
  var BADGE_INSET = 4, BADGE_MIN_VISIBLE = 24, POPOVER_DROP = 18, scrollContainerCache = /* @__PURE__ */ new WeakMap(), pageChromeCache = null;
  function invalidatePageChrome() {
    pageChromeCache = null;
  }
  function isExtensionOverlayElement(el) {
    return el === overlayRoot?.host || isOverlayNode(el);
  }
  function pageChromeAt(x, y) {
    let stack = document.elementsFromPoint(x, y);
    for (let i = 0; i < stack.length; i++) {
      let el = stack[i];
      if (!(el instanceof Element) || isExtensionOverlayElement(el)) continue;
      let pos = getComputedStyle(el).position;
      if (pos === "fixed" || pos === "sticky") return el;
    }
    return null;
  }
  function pageChromeOccluders() {
    if (pageChromeCache) return pageChromeCache;
    let found = [], seen = /* @__PURE__ */ new Set(), width = window.innerWidth, height = window.innerHeight;
    if (width > 0 && height > 0) {
      let sample = (x, y) => {
        let el = pageChromeAt(x, y);
        !el || seen.has(el) || (seen.add(el), found.push({ el, box: el.getBoundingClientRect() }));
      };
      sample(width / 2, 1), sample(width / 2, height - 2), sample(1, height / 2), sample(width - 2, height / 2), sample(width * 0.75, height / 2);
    }
    return pageChromeCache = found, found;
  }
  function clipRectFor(host, scrollContainer) {
    let clip = {
      left: 0,
      top: 0,
      right: window.innerWidth,
      bottom: window.innerHeight
    }, container = scrollContainer ?? scrollContainerCache.get(host);
    if (container || (container = scrollContainerFor(host), scrollContainerCache.set(host, container)), container && container !== document.documentElement) {
      let box = container.getBoundingClientRect();
      clip.left = Math.max(clip.left, box.left), clip.top = Math.max(clip.top, box.top), clip.right = Math.min(clip.right, box.right), clip.bottom = Math.min(clip.bottom, box.bottom);
    }
    let chrome2 = pageChromeOccluders();
    for (let i = 0; i < chrome2.length; i++) {
      let item = chrome2[i];
      !item || item.el.contains(host) || (clip = insetClipForOccluder(clip, item.box));
    }
    return clip;
  }
  function setImportantStyle(element, property, value) {
    element.style.getPropertyValue(property) === value && element.style.getPropertyPriority(property) === "important" || element.style.setProperty(property, value, "important");
  }
  function acquireHostAnchorName(host) {
    let existing = hostAnchorNames.get(host);
    if (existing)
      return existing.refs += 1, existing.name;
    let name = `--aid-${pageId}-${++nativeAnchorSeq}`, previousInlineAnchorNames = host.style.getPropertyValue("anchor-name"), previousInlinePriority = host.style.getPropertyPriority("anchor-name"), computedAnchorNames = getComputedStyle(host).getPropertyValue("anchor-name").trim(), assignedAnchorNames = computedAnchorNames && computedAnchorNames !== "none" ? `${computedAnchorNames}, ${name}` : name;
    return host.style.setProperty("anchor-name", assignedAnchorNames, "important"), hostAnchorNames.set(host, {
      name,
      assignedAnchorNames,
      previousInlineAnchorNames,
      previousInlinePriority,
      refs: 1
    }), name;
  }
  function releaseHostAnchorName(host) {
    let existing = hostAnchorNames.get(host);
    if (!existing || (existing.refs -= 1, existing.refs > 0)) return;
    hostAnchorNames.delete(host);
    let current = host.style.getPropertyValue("anchor-name");
    if (current === existing.assignedAnchorNames) {
      existing.previousInlineAnchorNames ? host.style.setProperty(
        "anchor-name",
        existing.previousInlineAnchorNames,
        existing.previousInlinePriority
      ) : host.style.removeProperty("anchor-name");
      return;
    }
    let remaining = current.split(",").map((name) => name.trim()).filter((name) => name && name !== existing.name);
    remaining.length > 0 ? host.style.setProperty("anchor-name", remaining.join(", "), "important") : host.style.removeProperty("anchor-name");
  }
  function createNativeAnchorWrapper(host, options) {
    let anchorName = acquireHostAnchorName(host), wrapper = document.createElement("div");
    wrapper.style.setProperty("all", "initial", "important"), wrapper.style.setProperty("display", "block", "important"), wrapper.style.setProperty("position", "absolute", "important"), wrapper.style.setProperty("position-anchor", anchorName, "important"), wrapper.style.setProperty("left", "anchor(left)", "important"), wrapper.style.setProperty("top", "anchor(top)", "important"), options.fill ? (wrapper.style.setProperty("box-sizing", "border-box", "important"), nativeAnchorFill && (wrapper.style.setProperty("right", "anchor(right)", "important"), wrapper.style.setProperty("bottom", "anchor(bottom)", "important"), wrapper.style.setProperty("width", "auto", "important"), wrapper.style.setProperty("height", "auto", "important"))) : (wrapper.style.setProperty("width", "max-content", "important"), wrapper.style.setProperty("height", "max-content", "important")), wrapper.style.setProperty("overflow", options.fill ? "hidden" : "visible", "important"), wrapper.style.setProperty("pointer-events", "none", "important"), wrapper.style.setProperty("z-index", options.zIndex, "important");
    let root = wrapper.attachShadow({ mode: "closed" });
    return markOverlayNode(wrapper), host.after(wrapper), document.getElementById(OVERLAY_HIDE_STYLE_ID) && hideOverlayNodeInline(wrapper), { wrapper, root, host, anchorName };
  }
  function reseatNativeAnchorWrapper(binding) {
    let { wrapper, host } = binding;
    host.isConnected && (wrapper.parentElement !== host.parentElement || wrapper.previousElementSibling !== host) && host.after(wrapper);
  }
  function destroyNativeAnchorWrapper(binding) {
    binding.wrapper.remove(), releaseHostAnchorName(binding.host);
  }
  function ensureOverlay() {
    if (overlayRoot) return overlayRoot;
    let host = document.createElement("div");
    markOverlayNode(host), host.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;", overlayRoot = host.attachShadow({ mode: "closed" });
    let style = document.createElement("style");
    return style.textContent = overlayStyles, overlayRoot.appendChild(style), document.documentElement.appendChild(host), overlayRoot;
  }
  function createBadge(host) {
    if (!nativeAnchorWorksFor(host)) {
      let badge2 = document.createElement("div");
      return ensureOverlay().appendChild(badge2), badge2;
    }
    ensureOverlay();
    let binding = createNativeAnchorWrapper(host, {
      // Above the image, z-auto tile overlays, and the Show veil (z-index 1);
      // below any page layer that covers the tile (menus, dialogs, headers).
      zIndex: "2",
      fill: !1
    }), style = document.createElement("style");
    style.textContent = `${overlayStyles}
.badge { position: static; display: block; }`;
    let badge = document.createElement("div");
    return binding.root.append(style, badge), nativeBadgeBindings.set(badge, binding), badge;
  }
  function removeBadge(state) {
    let badge = state?.badge;
    if (!badge) return;
    let binding = nativeBadgeBindings.get(badge);
    if (binding) {
      let host = binding.host;
      badgePlacementRetries.delete(host), destroyNativeAnchorWrapper(binding), nativeBadgeBindings.delete(badge), state.unblurVeil || overlayActivityObserver.unobserve(host);
    } else
      badge.remove();
    state.badge = null;
  }
  function displayScoreOf(u) {
    return typeof u.display == "number" ? u.display : Math.round(
      /** @type {number} */
      u.probability * 100
    );
  }
  var blurHideTimers = /* @__PURE__ */ new WeakMap(), blurHideFinishers = /* @__PURE__ */ new WeakMap();
  function shouldBlurImage(state) {
    let u = state.update;
    return !u || u.state !== "scored" || !u.isAI || u.engine === "mock" || state.blurRevealed ? !1 : !!(blurAiImages || state.blurForced);
  }
  function blurHideDelayMs() {
    try {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return 0;
    } catch {
    }
    return 320;
  }
  var lastRevealGesture = null;
  function onDocumentUnblurClick(ev) {
    let path = ev.composedPath();
    if (openPopover && path.includes(openPopover.el)) return;
    for (let node of path)
      if (node instanceof HTMLElement && node.classList.contains("badge") || node instanceof HTMLElement && node.classList.contains("blur-veil")) return;
    if (ev.type === "click" && lastRevealGesture) {
      let gesture = lastRevealGesture;
      if (lastRevealGesture = null, Date.now() - gesture.at < 600) {
        let rect = gesture.el.isConnected ? paintedRect(gesture.el) : null;
        if (rect && ev.clientX >= rect.left && ev.clientX <= rect.right && ev.clientY >= rect.top && ev.clientY <= rect.bottom) {
          ev.preventDefault(), ev.stopPropagation();
          return;
        }
      }
    }
    let hit = null;
    for (let node of path) {
      if (node === document || node === document.documentElement || node === document.body) break;
      if (node instanceof HTMLElement) {
        if (states.has(node) && shouldBlurImage(
          /** @type {ImgState} */
          states.get(node)
        )) {
          hit = node;
          break;
        }
        for (let el of byId.values()) {
          let state2 = states.get(el);
          if (!(!state2 || !shouldBlurImage(state2)) && node.contains(el)) {
            hit = el;
            break;
          }
        }
        if (hit) break;
      }
    }
    if (!hit) {
      let x = ev.clientX, y = ev.clientY;
      for (let el of byId.values()) {
        let state2 = states.get(el);
        if (!state2 || !shouldBlurImage(state2)) continue;
        let rect = paintedRect(el);
        if (!(x < rect.left || x > rect.right || y < rect.top || y > rect.bottom)) {
          hit = el;
          break;
        }
      }
    }
    if (!hit) return;
    let state = states.get(hit);
    state && (ev.preventDefault(), ev.stopPropagation(), ev.type === "pointerdown" && (lastRevealGesture = { el: hit, at: Date.now() }), revealBlurredImage(hit, state));
  }
  function revealBlurredImage(el, state) {
    shouldBlurImage(state) && (state.blurRevealed = !0, syncImageBlur(el, state));
  }
  document.addEventListener("pointerdown", rememberActivatedThumb, !0);
  document.addEventListener("pointerdown", onDocumentUnblurClick, !0);
  document.addEventListener("click", onDocumentUnblurClick, !0);
  function setVeilAnchorFill(wrapper) {
    setImportantStyle(wrapper, "left", "anchor(left)"), setImportantStyle(wrapper, "top", "anchor(top)"), setImportantStyle(wrapper, "right", "anchor(right)"), setImportantStyle(wrapper, "bottom", "anchor(bottom)"), setImportantStyle(wrapper, "width", "auto"), setImportantStyle(wrapper, "height", "auto");
  }
  function positionUnblurVeil(host, veil) {
    let rect = paintedRect(host), binding = nativeVeilBindings.get(veil);
    if (rect.width <= 0 || rect.height <= 0 || isVisuallyHidden(host)) {
      binding ? setImportantStyle(binding.wrapper, "display", "none") : veil.style.display = "none";
      return;
    }
    if (binding) {
      reseatNativeAnchorWrapper(binding), setImportantStyle(binding.wrapper, "display", "block"), setVeilAnchorFill(binding.wrapper), syncBlurCover(host, veil);
      return;
    }
    veil.style.display = "flex", veil.style.left = `${rect.left}px`, veil.style.top = `${rect.top}px`, veil.style.width = `${rect.width}px`, veil.style.height = `${rect.height}px`, syncBlurCover(host, veil);
  }
  function syncBlurCover(host, veil, clipWidth, clipHeight) {
    let box = host.getBoundingClientRect(), width = clipWidth ?? box.width, height = clipHeight ?? box.height;
    veil.style.setProperty("--aid-blur-scale", String(blurCoverScale(width, height)));
    let fit = getComputedStyle(host);
    fit.borderRadius && (veil.style.borderRadius = fit.borderRadius);
    let clone = veil.querySelector(".blur-clone");
    if (!(clone instanceof HTMLImageElement) || !(host instanceof HTMLImageElement)) return;
    let src = host.currentSrc || host.src;
    src && clone.src !== src && (clone.src = src), clone.style.objectFit = fit.objectFit, clone.style.objectPosition = fit.objectPosition;
  }
  function ensureUnblurVeil(el, state) {
    if (state.unblurVeil) return state.unblurVeil;
    watchOverlayActivity(el);
    let veil = document.createElement("button");
    if (veil.type = "button", veil.className = el instanceof HTMLImageElement ? "blur-veil" : "blur-veil bg-cover", veil.title = "Click to show this image", el instanceof HTMLImageElement) {
      let clip = document.createElement("span");
      clip.className = "blur-clip", clip.setAttribute("aria-hidden", "true");
      let clone = document.createElement("img");
      clone.className = "blur-clone", clone.alt = "", clone.draggable = !1, clone.decoding = "async", clip.appendChild(clone), veil.appendChild(clip);
    }
    let dim = document.createElement("span");
    dim.className = "blur-dim", dim.setAttribute("aria-hidden", "true");
    let label = document.createElement("span");
    label.className = "blur-veil-label", label.textContent = "Show", veil.append(dim, label);
    let stopUnhidePointer = (ev) => {
      ev.preventDefault(), ev.stopPropagation();
    };
    if (veil.addEventListener("pointerdown", stopUnhidePointer), veil.addEventListener("click", (ev) => {
      ev.preventDefault(), ev.stopPropagation(), revealBlurredImage(el, state);
    }), !nativeAnchorWorksFor(el) || !nativeAnchorFill)
      return ensureOverlay().appendChild(veil), state.unblurVeil = veil, veil;
    ensureOverlay();
    let binding = createNativeAnchorWrapper(el, {
      // Sibling layer below the badge (z-index 2), above the image.
      zIndex: "1",
      fill: !0
    }), style = document.createElement("style");
    return style.textContent = `${overlayStyles}
.blur-veil { position: static; display: flex; width: 100%; height: 100%; box-sizing: border-box; }`, binding.root.append(style, veil), nativeVeilBindings.set(veil, binding), state.unblurVeil = veil, veil;
  }
  function cancelBlurHide(veil) {
    let timer = blurHideTimers.get(veil);
    timer && (clearTimeout(timer), blurHideTimers.delete(veil));
    let finish = blurHideFinishers.get(veil);
    finish && (veil.removeEventListener("transitionend", finish), blurHideFinishers.delete(veil));
  }
  function destroyUnblurVeil(state) {
    let veil = state.unblurVeil;
    if (!veil) return;
    cancelBlurHide(veil);
    let binding = nativeVeilBindings.get(veil);
    binding ? (destroyNativeAnchorWrapper(binding), nativeVeilBindings.delete(veil), state.badge || overlayActivityObserver.unobserve(binding.host)) : veil.remove(), state.unblurVeil = null;
  }
  function removeUnblurVeil(state) {
    destroyUnblurVeil(state);
  }
  function dismissUnblurVeil(state) {
    let veil = state.unblurVeil;
    if (!veil) return;
    cancelBlurHide(veil);
    let delay = blurHideDelayMs();
    if (delay === 0 || !veil.classList.contains("in")) {
      destroyUnblurVeil(state);
      return;
    }
    veil.classList.remove("in"), veil.style.pointerEvents = "none";
    let finish = () => {
      blurHideFinishers.delete(veil), state.unblurVeil === veil && destroyUnblurVeil(state);
    };
    blurHideFinishers.set(veil, finish), veil.addEventListener("transitionend", finish, { once: !0 }), blurHideTimers.set(veil, setTimeout(finish, delay));
  }
  function armBlurVeil(state, veil) {
    cancelBlurHide(veil), veil.style.pointerEvents = "";
    let show = () => {
      state.unblurVeil !== veil || !shouldBlurImage(state) || veil.classList.add("in");
    };
    if (veil.classList.contains("in")) return;
    let arm = () => requestAnimationFrame(() => requestAnimationFrame(show)), clone = veil.querySelector(".blur-clone");
    if (clone instanceof HTMLImageElement && !clone.complete) {
      clone.addEventListener("load", arm, { once: !0 }), clone.addEventListener("error", arm, { once: !0 });
      return;
    }
    arm();
  }
  function syncImageBlur(el, state) {
    if (shouldBlurImage(state)) {
      let veil = ensureUnblurVeil(el, state);
      positionUnblurVeil(el, veil), armBlurVeil(state, veil);
    } else
      dismissUnblurVeil(state);
  }
  function syncAllImageBlurs() {
    for (let el of byId.values()) {
      let state = states.get(el);
      state && syncImageBlur(el, state);
    }
  }
  function renderBadge(el, state) {
    if (!enabled) return;
    syncImageBlur(el, state);
    let u = state.update;
    if (state.phase === "pending" && (document.visibilityState === "hidden" || !isRectInViewport(paintedRect(el), {
      width: window.innerWidth,
      height: window.innerHeight
    })) || !shouldRenderBadge(state.phase, u?.probability, window !== top)) {
      removeBadge(state), openPopover?.state === state && closePopover(), scheduleBadgeCollisionReconcile();
      return;
    }
    let created = !1;
    state.badge || (state.badge = createBadge(el), created = !0, watchOverlayActivity(el)), (created || state.phase === "scored" || state.phase === "no-model") && badgePlacementRetries.delete(el);
    let b = state.badge;
    if (b.onclick = null, state.phase === "pending" && u && typeof u.probability == "number") {
      let pct = displayScoreOf(u);
      b.className = `badge scored restating ${u.engine === "mock" ? "mock" : u.isAI ? "ai" : "real"}`, b.textContent = u.engine === "mock" ? "MOCK" : u.isAI ? `AI ${pct}%` : `${pct}%`, b.title = "Re-analyzing at full resolution";
    } else if (state.phase === "pending")
      b.className = "badge pending", b.textContent = "AI \u2026", b.title = state.holdScan ? "Finding a full-resolution source" : "Analyzing this image on-device";
    else if (state.phase === "no-model")
      b.className = "badge setup", b.textContent = "SETUP", b.title = "Open the extension popup to install the on-device model";
    else if (u && typeof u.probability == "number") {
      let pct = displayScoreOf(u), mock = u.engine === "mock";
      b.className = `badge scored ${mock ? "mock" : u.isAI ? "ai" : "real"}`, b.textContent = mock ? "MOCK" : u.isAI ? `AI ${pct}%` : `${pct}%`, b.title = mock ? "Simulated pipeline result \u2014 not an AI verdict" : "Click for on-device score details", b.onclick = (ev) => {
        ev.preventDefault(), ev.stopPropagation(), togglePopover(el, state);
      };
    }
    let deferHitTest = created || state.phase === "scored" || state.phase === "no-model", visible = positionBadge(el, b, { deferHitTest });
    scheduleBadgeCollisionReconcile(), openPopover?.state === state && (visible ? positionPopover(el, openPopover.el) : closePopover()), (created || deferHitTest || !visible) && scheduleBadgePlacementRetry(el, state);
  }
  var loggedFirstBadge = !1, setupNotice = null;
  function showSetupNotice() {
    window !== top || setupNotice || (setupNotice = document.createElement("div"), setupNotice.className = "setup-notice", setupNotice.textContent = "AI detector \xB7 setup required", setupNotice.title = "Open the extension popup to install the on-device model", ensureOverlay().appendChild(setupNotice));
  }
  function clearSetupNotice() {
    setupNotice?.remove(), setupNotice = null;
  }
  function enterModelUnavailableState() {
    if (modelGate.enter()) {
      closePopover();
      for (let [, el] of byId) {
        let state = states.get(el);
        !state || state.phase !== "pending" && state.phase !== "no-model" || (state.phase = "no-model", renderBadge(el, state));
      }
      showSetupNotice(), probeModelReadiness();
    }
  }
  function applyModelReady() {
    if (!enabled) return;
    staleNoModelRetried.clear();
    let alreadyProven = modelGate.provenUsable, wasLatched = modelGate.markUsable();
    clearSetupNotice(), (wasLatched || !alreadyProven) && scheduleRescanVisible();
  }
  function probeModelReadiness() {
    return modelGate.provenUsable ? Promise.resolve("already") : new Promise((resolve) => {
      let settled = !1, finish = (status) => {
        settled || (settled = !0, resolve(status));
      };
      try {
        chrome.runtime.sendMessage({ type: MSG.STATUS_GET, target: TARGET.SW }, (response) => {
          if (chrome.runtime.lastError, response?.model?.state === "ready") {
            applyModelReady(), finish("recovered");
            return;
          }
          finish("unavailable");
        });
      } catch {
        finish("unavailable");
      }
    });
  }
  function scheduleRescanVisible() {
    !enabled || rescanQueued || (rescanQueued = !0, queueMicrotask(() => {
      rescanQueued = !1, rescanVisible();
    }));
  }
  function onModelBecameUsable() {
    let firstProof = !modelGate.provenUsable, wasLatched = modelGate.markUsable();
    firstProof && staleNoModelRetried.clear(), wasLatched && (clearSetupNotice(), scheduleRescanVisible());
  }
  function retryStaleNoModel(url, fallbackId) {
    let waiters = registry.settle(url, fallbackId), already = staleNoModelRetried.has(url);
    already || staleNoModelRetried.add(url);
    for (let id of waiters) {
      let el = byId.get(id), state = el && states.get(el);
      if (!(!el || !state || state.phase === "scored")) {
        if (already) {
          state.phase = "no-model", renderBadge(el, state);
          continue;
        }
        state.phase = "pending", state.update = null, viewportPriorityObserver.observe(el), renderBadge(el, state), requestScan(el, state);
      }
    }
  }
  var openPopover = null;
  function closePopover() {
    openPopover?.el.remove(), openPopover = null;
  }
  function togglePopover(host, state) {
    if (openPopover?.state === state) {
      closePopover();
      return;
    }
    closePopover();
    let u = state.update;
    if (!u || typeof u.probability != "number") return;
    let root = ensureOverlay(), pop = document.createElement("div");
    pop.className = "popover";
    let pct = displayScoreOf(u), add = (text, className) => {
      let row = document.createElement("div");
      className && (row.className = className), row.textContent = text, pop.appendChild(row);
    };
    if (u.engine === "mock") {
      add("MOCK PIPELINE"), add("Simulated test only \u2014 not an AI verdict", "k"), add("Use the local-model build for real on-device scores.", "k"), pop.addEventListener("click", (ev) => ev.stopPropagation()), root.appendChild(pop), openPopover = { state, el: pop, host }, positionPopover(host, pop);
      return;
    }
    add(`AI score ${pct}%`), add(`${u.isAI ? "Verdict: AI-generated" : "Verdict: likely real"} at 0.65`, "k"), add(`calibrated P(AI) ${u.probability.toFixed(3)}`, "k");
    let upgrade = host instanceof HTMLImageElement ? upgradeResolved.get(host) : void 0;
    if (upgrade?.url && upgrade.url === state.url ? add("scored the full-resolution original", "k") : upgrade?.note && add(`scored the page thumbnail \u2014 ${upgrade.note}`, "k"), u.gate === "graphic" ? add("flat graphics/text detected \u2014 not photographic content, so the photo detector\u2019s score is capped below the AI threshold", "k") : u.gate === "native-tiles" && add("the downscaled crop looked generated; native-resolution tiles did not agree, so the score is the tiles\u2019", "k"), u.isAI) {
      let btn = document.createElement("button");
      btn.type = "button";
      let blurred = shouldBlurImage(state);
      btn.className = `blur-toggle${blurred ? " show" : ""}`, btn.textContent = blurred ? "Show image" : "Blur image", btn.addEventListener("click", (ev) => {
        ev.preventDefault(), ev.stopPropagation(), shouldBlurImage(state) ? (state.blurRevealed = !0, state.blurForced = !1) : (state.blurRevealed = !1, state.blurForced = !0), syncImageBlur(host, state);
        let nowBlurred = shouldBlurImage(state);
        btn.className = `blur-toggle${nowBlurred ? " show" : ""}`, btn.textContent = nowBlurred ? "Show image" : "Blur image";
      }), pop.appendChild(btn);
    }
    if (u.contributions?.length)
      for (let c of u.contributions) {
        if (typeof c.bits != "number" || !Number.isFinite(c.bits)) {
          add(`${c.name}: ${c.reason ?? "override"}`, "bits");
          continue;
        }
        let sign = c.bits >= 0 ? "+" : "";
        add(`${c.name}: ${sign}${c.bits.toFixed(2)} bits`, "bits");
      }
    add("Analyzed on this device. Nothing left the browser.", "k"), pop.addEventListener("click", (ev) => ev.stopPropagation()), root.appendChild(pop), openPopover = { state, el: pop, host }, positionPopover(host, pop);
  }
  function positionPopover(host, pop) {
    let anchor = badgeAnchorPoint({
      rect: paintedRect(host),
      clip: clipRectFor(host),
      inset: BADGE_INSET
    });
    pop.style.left = `${anchor.x}px`, pop.style.top = `${anchor.y + POPOVER_DROP}px`;
  }
  document.addEventListener(
    "click",
    (ev) => {
      if (!openPopover) return;
      let path = ev.composedPath();
      path.includes(openPopover.el) || openPopover.state.badge && path.includes(openPopover.state.badge) || closePopover();
    },
    !0
  );
  function paintedRect(host) {
    let box = host.getBoundingClientRect();
    if (!(host instanceof HTMLImageElement) || !host.naturalWidth || !host.naturalHeight)
      return box;
    let style = getComputedStyle(host);
    return fittedImageRect({
      box,
      naturalWidth: host.naturalWidth,
      naturalHeight: host.naturalHeight,
      objectFit: style.objectFit,
      objectPosition: style.objectPosition
    });
  }
  function isVisuallyHidden(host) {
    let el = host;
    for (; el; ) {
      let style = getComputedStyle(el);
      if (style.display === "none" || style.visibility !== "visible" || style.contentVisibility === "hidden" || Number.parseFloat(style.opacity) <= 0.01)
        return !0;
      el = el.parentElement;
    }
    return !1;
  }
  function commonAncestorDistances(host, overlay) {
    let hostDistance = 0, hostNode = host;
    for (; hostNode && hostDistance <= 4; hostNode = hostNode.parentElement) {
      let overlayDistance = 0, overlayNode = overlay;
      for (; overlayNode && overlayDistance <= 2; overlayNode = overlayNode.parentElement) {
        if (hostNode === overlayNode) return { hostDistance, overlayDistance };
        overlayDistance += 1;
      }
      hostDistance += 1;
    }
    return null;
  }
  function isAssociatedInteractionOverlay(host, hostRect, hit) {
    if (!(hit instanceof Element)) return !1;
    let distances = commonAncestorDistances(host, hit);
    return distances ? isSameVisualInteractionOverlay({
      hostRect,
      overlayRect: hit.getBoundingClientRect(),
      hostAncestorDistance: distances.hostDistance,
      overlayAncestorDistance: distances.overlayDistance,
      position: getComputedStyle(hit).position
    }) : !1;
  }
  function positionBadge(host, badge, options) {
    let rect = paintedRect(host), nativeBinding = nativeBadgeBindings.get(badge);
    if (rect.width <= 0 || rect.height <= 0 || !options?.deferHitTest && isVisuallyHidden(host))
      return badge.style.display = "none", !1;
    if (nativeBinding) {
      reseatNativeAnchorWrapper(nativeBinding), badge.style.display = "";
      let box = host.getBoundingClientRect(), offsetX = rect.left - box.left + BADGE_INSET, offsetY = rect.top - box.top + BADGE_INSET;
      return setImportantStyle(nativeBinding.wrapper, "left", `calc(anchor(left) + ${offsetX}px)`), setImportantStyle(nativeBinding.wrapper, "top", `calc(anchor(top) + ${offsetY}px)`), logFirstBadgePlacement(badge), !0;
    }
    let clip = clipRectFor(host), anchor = badgeAnchorPoint({
      rect,
      clip,
      inset: BADGE_INSET,
      minVisible: BADGE_MIN_VISIBLE
    }), anchorX = anchor.x, anchorY = anchor.y, overlayHost = overlayRoot?.host, overlayNodes = [badge];
    setupNotice && overlayNodes.push(setupNotice), openPopover?.el && overlayNodes.push(openPopover.el);
    let hostState = states.get(host);
    if (hostState?.unblurVeil) {
      overlayNodes.push(hostState.unblurVeil);
      let veilBinding = nativeVeilBindings.get(hostState.unblurVeil);
      veilBinding && overlayNodes.push(veilBinding.wrapper);
    }
    if (!anchor.visible || !overlayHost)
      return badge.style.display = "none", !1;
    if (options?.deferHitTest) {
      if (hostState?.badgeOccluded)
        return badge.style.display = "none", !1;
    } else {
      let hitStack = document.elementsFromPoint(anchorX, anchorY), hostIsTopmost = isHostTopmostAtPoint(
        host,
        hitStack,
        overlayHost,
        overlayNodes,
        (hit) => isAssociatedInteractionOverlay(host, rect, hit)
      ), occluderPosition = "", pageLayerOccludes = !1;
      if (!hostIsTopmost) {
        let skip = new Set(overlayNodes), occluder = hitStack.find((element) => element !== overlayHost && !skip.has(element));
        occluder instanceof Element && (occluderPosition = getComputedStyle(occluder).position, pageLayerOccludes = isPageLayerOccluder(
          host.getBoundingClientRect(),
          occluder.getBoundingClientRect()
        ));
      }
      let hideForOccluder = shouldHideBadgeForOccluder(
        hostIsTopmost,
        occluderPosition,
        pageLayerOccludes
      );
      if (hostState && (hostState.badgeOccluded = hideForOccluder), hideForOccluder)
        return badge.style.display = "none", !1;
    }
    return badge.style.display = "", badge.style.left = `${anchorX}px`, badge.style.top = `${anchorY}px`, logFirstBadgePlacement(badge), !0;
  }
  function logFirstBadgePlacement(badge) {
    if (!1) {
      loggedFirstBadge = !0;
      let br = badge.getBoundingClientRect();
      console.info(
        "[ai-image-detector] first badge placed:",
        JSON.stringify({
          text: badge.textContent,
          left: Math.round(br.left),
          top: Math.round(br.top),
          renderedW: Math.round(br.width),
          renderedH: Math.round(br.height),
          hostConnected: badge.isConnected
        })
      );
    }
  }
  function scheduleBadgePlacementRetry(el, state) {
    if (contextInvalidated) return;
    let used = badgePlacementRetries.get(el) ?? 0;
    used >= 2 || (badgePlacementRetries.set(el, used + 1), requestAnimationFrame(() => {
      if (!extensionAlive() || states.get(el) !== state || !state.badge) return;
      let visible = positionBadge(el, state.badge);
      openPopover?.state === state && !visible && closePopover(), scheduleBadgeCollisionReconcile(), visible ? badgePlacementRetries.delete(el) : scheduleBadgePlacementRetry(el, state);
    }));
  }
  var repositionScheduled = !1, collisionReconcileScheduled = !1, idleHitTestScheduled = !1, searchThumbRetryScheduled = !1, pendingHitTest = !1, pendingAllowNativeSkip = !0, lastScrollAt = 0, SCROLL_SETTLE_MS = 180;
  function scheduleIdle(fn, timeout = 160) {
    if (typeof requestIdleCallback == "function") {
      requestIdleCallback(() => fn(), { timeout });
      return;
    }
    setTimeout(fn, Math.min(timeout, 48));
  }
  function scheduleIdleHitTest() {
    idleHitTestScheduled || contextInvalidated || byId.size === 0 || (idleHitTestScheduled = !0, scheduleIdle(() => {
      if (idleHitTestScheduled = !1, !(!enabled || !started || contextInvalidated)) {
        if (performance.now() - lastScrollAt < SCROLL_SETTLE_MS) {
          scheduleIdleHitTest();
          return;
        }
        repositionAll({ hitTest: !0 });
      }
    }));
  }
  function scheduleSearchThumbnailUpgradeRetry() {
    searchThumbRetryScheduled || contextInvalidated || (searchThumbRetryScheduled = !0, scheduleIdle(() => {
      searchThumbRetryScheduled = !1, !(!enabled || !started || contextInvalidated) && retrySearchThumbnailUpgrades();
    }, 250));
  }
  function scheduleBadgeCollisionReconcile() {
    collisionReconcileScheduled || contextInvalidated || (collisionReconcileScheduled = !0, requestAnimationFrame(() => {
      if (collisionReconcileScheduled = !1, !!extensionAlive())
        try {
          reconcileBadgeCollisions();
        } catch {
          contextInvalidated = !0;
        }
    }));
  }
  function reconcileBadgeCollisions() {
    let rendered = [];
    for (let [id, host] of byId) {
      let state = states.get(host), badge = state?.badge;
      !state || !badge?.isConnected || badge.style.display === "none" || (badge.style.visibility = "", rendered.push({
        id,
        phase: state.phase,
        url: state.url,
        isImage: host instanceof HTMLImageElement,
        host: paintedRect(host),
        badge: badge.getBoundingClientRect(),
        element: badge
      }));
    }
    let priority = (item) => (item.phase === "scored" ? 4 : item.phase === "no-model" ? 3 : 1) + (item.isImage ? 1 : 0);
    rendered.sort((a, b) => priority(b) - priority(a));
    let keepers = [];
    for (let item of rendered)
      keepers.some((keeper) => shouldSuppressDuplicateBadge(item, keeper)) ? item.element.style.visibility = "hidden" : keepers.push(item);
  }
  function repositionAll(options) {
    !enabled || !started || contextInvalidated || (options?.hitTest && (pendingHitTest = !0, pendingAllowNativeSkip = !1), options?.allowNativeSkip === !1 && (pendingAllowNativeSkip = !1), !repositionScheduled && (repositionScheduled = !0, requestAnimationFrame(() => {
      let hitTest = pendingHitTest, allowNativeSkip = pendingAllowNativeSkip;
      if (pendingHitTest = !1, pendingAllowNativeSkip = !0, repositionScheduled = !1, !!extensionAlive())
        try {
          invalidatePageChrome();
          for (let [id, el] of byId) {
            let state = states.get(el);
            if (state) {
              if (!el.isConnected) {
                sweepOne(id, el);
                continue;
              }
              nativeAnchorPositioning && state.overlayParked && openPopover?.host !== el || allowNativeSkip && nativeAnchorPositioning && openPopover?.host !== el && (state.badge && nativeBadgeBindings.get(state.badge) || state.unblurVeil && nativeVeilBindings.get(state.unblurVeil)) || (state.unblurVeil && positionUnblurVeil(el, state.unblurVeil), state.badge && !positionBadge(el, state.badge, { deferHitTest: !hitTest }) && openPopover?.state === state && closePopover());
            }
          }
          openPopover && (openPopover.host.isConnected ? positionPopover(openPopover.host, openPopover.el) : closePopover()), hitTest ? scheduleBadgeCollisionReconcile() : scheduleIdleHitTest();
        } catch {
          markContextInvalidated();
        }
    })));
  }
  window.addEventListener(
    "scroll",
    () => {
      lastScrollAt = performance.now(), repositionAll();
    },
    { capture: !0, passive: !0 }
  );
  window.addEventListener("resize", () => repositionAll({ allowNativeSkip: !1 }), { passive: !0 });
  function sweepOne(id, el) {
    let state = states.get(el);
    openPopover?.state === state && closePopover(), state && removeUnblurVeil(state), removeBadge(state), viewportPriorityObserver.unobserve(el), layoutObserver.unobserve(el), overlayActivityObserver.unobserve(el), states.delete(el), byId.delete(id), el instanceof HTMLImageElement && (waitingForOrigin.delete(el), clearSearchThumbFallback(el)), scheduleBadgeCollisionReconcile();
  }
  var port = null, suppressPortReconnect = !1, hudTimer = null;
  function extensionAlive() {
    if (contextInvalidated) return !1;
    try {
      if (chrome.runtime?.id) return !0;
    } catch {
    }
    return markContextInvalidated(), !1;
  }
  function markContextInvalidated() {
    if (!contextInvalidated) {
      contextInvalidated = !0, enabled = !1, started = !1, port = null, hudTimer && (clearInterval(hudTimer), hudTimer = null);
      try {
        io.disconnect();
      } catch {
      }
      try {
        viewportPriorityObserver.disconnect();
      } catch {
      }
      try {
        overlayActivityObserver.disconnect();
      } catch {
      }
      try {
        layoutObserver.disconnect();
      } catch {
      }
      try {
        mo.disconnect();
      } catch {
      }
      try {
        closePopover();
      } catch {
      }
      try {
        hideOverlayNodes(document), removeOverlayNodes(document);
      } catch {
      }
      overlayRoot = null, deferredWhileHidden.clear(), cancelUpgradeProbeWaiters();
      for (let [id, el] of [...byId])
        try {
          sweepOne(id, el);
        } catch {
          byId.delete(id), states.delete(el);
        }
    }
  }
  function ensurePort() {
    if (port) return port;
    if (!extensionAlive()) return null;
    let connected;
    try {
      connected = chrome.runtime.connect({ name: PORT_SCAN });
    } catch {
      return markContextInvalidated(), null;
    }
    return port = connected, connected.onMessage.addListener(onScanUpdate), connected.onDisconnect.addListener(() => {
      try {
        chrome.runtime.lastError;
      } catch {
        markContextInvalidated();
        return;
      }
      port === connected && (port = null, !(suppressPortReconnect || contextInvalidated || !enabled) && extensionAlive() && (registry.reset(), setTimeout(() => {
        suppressPortReconnect || !enabled || !extensionAlive() || probeModelReadiness().then((status) => {
          if (status === "recovered" || !enabled || !extensionAlive()) return;
          let probeEl = null, probeState = null;
          for (let [, el] of byId) {
            let s = states.get(el);
            s && (s.phase === "pending" ? requestScan(el, s) : status === "unavailable" && s.phase === "no-model" && !probeEl && (probeEl = el, probeState = s));
          }
          probeEl && probeState && modelGate.allowProbe() && (probeState.phase = "pending", probeState.update = null, viewportPriorityObserver.observe(probeEl), renderBadge(probeEl, probeState), requestScan(probeEl, probeState));
        });
      }, 250)));
    }), port;
  }
  window.addEventListener("pagehide", () => {
    suppressPortReconnect = !0;
    try {
      port?.disconnect();
    } catch {
      markContextInvalidated();
    }
    port = null, registry.reset();
  });
  window.addEventListener("pageshow", (event) => {
    suppressPortReconnect = !1, !(!event.persisted || !extensionAlive()) && chrome.storage.local.get([ENABLED_FLAG, BLUR_AI_FLAG]).then((got) => {
      let blur = readStoredFlag(receivedLiveBlur, got[BLUR_AI_FLAG], BLUR_AI_DEFAULT);
      blur !== null && applyBlurSetting(blur);
      let nextEnabled = readStoredFlag(receivedLiveEnabled, got[ENABLED_FLAG], !0);
      nextEnabled !== null && applyEnabledSetting(nextEnabled), enabled && retryPendingScans();
    }).catch(() => {
    });
  });
  function requestScan(el, state, requestedPriority) {
    if (!enabled || state.holdScan) return;
    let cached = registry.get(state.url);
    if (cached) {
      applyUpdate(el, state, cached);
      return;
    }
    if (modelGate.unavailable) {
      state.phase = "no-model", renderBadge(el, state);
      return;
    }
    if (!registry.join(state.url, state.id)) return;
    let rect = el.getBoundingClientRect(), width = el instanceof HTMLImageElement && el.naturalWidth ? el.naturalWidth : Math.round(rect.width), height = el instanceof HTMLImageElement && el.naturalHeight ? el.naturalHeight : Math.round(rect.height), priority = requestedPriority ?? currentScanPriority(el);
    state.priority = Math.max(state.priority, priority), ensurePort()?.postMessage({
      type: MSG.SCAN_REQUEST,
      id: state.id,
      url: state.url,
      width,
      height,
      priority: state.priority
    });
  }
  function retryPendingScans() {
    if (enabled)
      for (let el of byId.values()) {
        let state = states.get(el);
        !state || state.phase !== "pending" || state.holdScan || requestScan(el, state, state.priority);
      }
  }
  function promoteScan(state, priority) {
    if (state.phase !== "pending" || priority <= state.priority) return;
    state.priority = priority;
    let requestId = registry.requestIdFor(state.url);
    requestId && ensurePort()?.postMessage({ type: MSG.SCAN_PRIORITY, id: requestId, priority });
  }
  function onScanUpdate(msg) {
    if (!enabled || msg.type !== MSG.SCAN_UPDATE) return;
    let img = byId.get(msg.id), state = img ? states.get(img) : void 0, url = msg.url ?? state?.url ?? registry.urlForWaiter(msg.id);
    if (url) {
      if (msg.state === "no-model" && modelGate.provenUsable) {
        retryStaleNoModel(url, msg.id);
        return;
      }
      msg.state === "no-model" && enterModelUnavailableState(), msg.state === "scored" && registry.remember(url, msg);
      for (let id of registry.settle(url, msg.id)) {
        let el = byId.get(id), s = el && states.get(el);
        el && s && applyUpdate(el, s, msg);
      }
    }
  }
  function applyUpdate(el, state, update) {
    state.phase = update.state, state.update = { ...update, id: state.id }, update.state !== "pending" && viewportPriorityObserver.unobserve(el), update.state === "no-model" ? enterModelUnavailableState() : update.state === "scored" && onModelBecameUsable(), !1, renderBadge(el, state);
  }
  function considerImage(img, priority) {
    if (!enabled) return !1;
    let state = states.get(img), url = img.currentSrc || img.src;
    if (url.startsWith("blob:")) {
      let cachedBlob = blobResolved.get(img);
      if (cachedBlob && cachedBlob.src === url)
        url = cachedBlob.dataUrl;
      else
        return blobInFlight.has(img) || (blobInFlight.add(img), resolveBlobUrl(img, url)), showAwaitingSourceBadge(img, url), !1;
    }
    let isUpgradeRescan = !1;
    if (img.complete && img.naturalWidth > 0) {
      let cachedUpgrade = upgradeResolved.get(img), searchThumb = isSearchThumbnail(url);
      if (searchThumb && viewerOriginal && thumbBelongsToViewer(img, viewerOriginal.keys))
        (cachedUpgrade?.url !== viewerOriginal.url || cachedUpgrade.src !== url) && upgradeResolved.set(img, { src: url, url: viewerOriginal.url }), url = viewerOriginal.url, isUpgradeRescan = !0;
      else if (cachedUpgrade && cachedUpgrade.src === url && cachedUpgrade.url)
        url = cachedUpgrade.url, isUpgradeRescan = !0;
      else {
        if (upgradeInFlight.has(img))
          return showAwaitingSourceBadge(img, url), !1;
        if (!cachedUpgrade || cachedUpgrade.src !== url || searchThumb && !cachedUpgrade.url) {
          let candidates = upgradeCandidatesFor(img, url);
          if (candidates.length === 0) {
            if (searchThumb && !searchThumbFallbackDue.has(img))
              return waitingForOrigin.add(img), scheduleSearchThumbFallback(img), showAwaitingSourceBadge(img, url), !1;
            searchThumb || upgradeResolved.set(img, { src: url, url: null });
          } else {
            let sameFile = candidates.find((c) => c.confidence === "same-file");
            if (sameFile)
              waitingForOrigin.delete(img), clearSearchThumbFallback(img), upgradeResolved.set(img, { src: url, url: sameFile.url }), url = sameFile.url, isUpgradeRescan = !0;
            else
              return upgradeInFlight.add(img), showAwaitingSourceBadge(img, url), resolveUpgrade(img, url, candidates), !1;
          }
        }
      }
    }
    if (state && state.url === url && state.epoch === epoch && state.phase !== "no-model" && state.phase !== "skipped" && !state.holdScan)
      return isSearchThumbnail(img.currentSrc || img.src) && !upgradeResolved.get(img)?.url ? !(state.phase === "pending" || state.holdScan) : !0;
    let carriedUpdate = null, carriedBlurRevealed = !1, carriedBlurForced = !1;
    if (state) {
      isUpgradeRescan && state.phase === "scored" && (carriedUpdate = state.update, carriedBlurRevealed = !!state.blurRevealed, carriedBlurForced = !!state.blurForced);
      let wasSkipped = state.phase === "skipped";
      removeUnblurVeil(state), removeBadge(state), byId.delete(state.id), viewportPriorityObserver.unobserve(img), wasSkipped || layoutObserver.unobserve(img), states.delete(img);
    }
    let rect = paintedRect(img), candidate = classifyImageCandidate({
      url,
      complete: img.complete,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      displayedWidth: rect.width,
      displayedHeight: rect.height,
      minEdge: 64
    });
    return candidate === "wait-source" ? !1 : candidate === "wait-load" ? (waitingForLoad.has(img) || (waitingForLoad.add(img), img.addEventListener(
      "load",
      () => {
        waitingForLoad.delete(img), considerImage(img) && io.unobserve(img);
      },
      { once: !0 }
    )), !1) : candidate === "skip" ? (states.set(img, {
      id: "",
      url,
      phase: "skipped",
      badge: null,
      update: null,
      epoch,
      priority: 0
    }), Math.min(rect.width, rect.height) < 64 ? layoutObserver.observe(img) : layoutObserver.unobserve(img), !0) : (!isUpgradeRescan && !isSearchThumbnail(url) && isPreviewPaneBox(img.getBoundingClientRect(), innerWidth) && publishViewerOriginal(img, url), beginScan(img, url, priority, carriedUpdate, carriedBlurRevealed, carriedBlurForced));
  }
  function beginScan(el, url, requestedPriority = currentScanPriority(el), carriedUpdate = null, carriedBlurRevealed = !1, carriedBlurForced = !1) {
    el instanceof HTMLImageElement && (waitingForOrigin.delete(el), clearSearchThumbFallback(el));
    let id = `${pageId}:${++seq}`, state = {
      id,
      url,
      phase: modelGate.unavailable ? "no-model" : "pending",
      badge: null,
      update: carriedUpdate,
      epoch,
      priority: requestedPriority,
      ...carriedBlurRevealed ? { blurRevealed: !0 } : {},
      ...carriedBlurForced ? { blurForced: !0 } : {}
    };
    return states.set(el, state), byId.set(id, el), layoutObserver.observe(el), viewportPriorityObserver.observe(el), renderBadge(el, state), requestScan(el, state, requestedPriority), !0;
  }
  function showAwaitingSourceBadge(el, url) {
    if (!enabled || modelGate.unavailable) return;
    let rect = paintedRect(el);
    if (Math.min(rect.width, rect.height) < 64) return;
    let existing = states.get(el);
    if (existing && existing.epoch === epoch) {
      if (existing.holdScan && existing.phase === "pending") {
        existing.url = url, existing.priority = Math.max(existing.priority, currentScanPriority(el)), renderBadge(el, existing);
        return;
      }
      if (existing.phase !== "skipped") return;
    }
    existing && (removeUnblurVeil(existing), removeBadge(existing), byId.delete(existing.id), viewportPriorityObserver.unobserve(el), layoutObserver.unobserve(el), states.delete(el));
    let id = `${pageId}:${++seq}`, state = {
      id,
      url,
      phase: "pending",
      badge: null,
      update: null,
      epoch,
      priority: currentScanPriority(el),
      holdScan: !0
    };
    states.set(el, state), byId.set(id, el), layoutObserver.observe(el), viewportPriorityObserver.observe(el), renderBadge(el, state);
  }
  function overlaySourceHref(img) {
    let closest = img.closest("a"), hostRect = paintedRect(img), imgArea = Math.max(0, hostRect.width * hostRect.height), ancestor = img.parentElement;
    for (let hostDistance = 1; ancestor && hostDistance <= 4; ancestor = ancestor.parentElement, hostDistance++) {
      let rootBox = ancestor.getBoundingClientRect(), rootArea = Math.max(0, rootBox.width * rootBox.height);
      if (imgArea > 0 && rootArea > imgArea * 12) break;
      let links = ancestor.querySelectorAll("a[href]");
      for (let node of links) {
        if (!(node instanceof HTMLAnchorElement) || !node.href || node === closest || node.contains(img)) continue;
        let overlayRect = node.getBoundingClientRect();
        if (isSameVisualInteractionOverlay({
          hostRect,
          overlayRect,
          hostAncestorDistance: hostDistance,
          overlayAncestorDistance: 1,
          position: getComputedStyle(node).position
        }))
          return node.href;
      }
    }
    return null;
  }
  var ORIGIN_HREF = /[?&](?:imgurl|mediaurl|imageurl|image_url|ou|iu)=/i;
  function collectSourceHrefs(img) {
    let hrefs = [], seen = /* @__PURE__ */ new Set(), add = (href) => {
      !href || seen.has(href) || (seen.add(href), hrefs.push(href));
    };
    add(img.closest("a")?.href), add(overlaySourceHref(img)), add(originHrefAtPoint(img));
    let hostRect = paintedRect(img), imgArea = Math.max(0, hostRect.width * hostRect.height), root = img.parentElement;
    for (let depth = 1; root && depth <= 8 && root !== document.body; depth += 1, root = root.parentElement) {
      let rootBox = root.getBoundingClientRect(), rootArea = Math.max(0, rootBox.width * rootBox.height), links = imgArea > 0 && rootArea > imgArea * 12 ? root.querySelectorAll(":scope > a[href], :scope > * > a[href]") : root.querySelectorAll("a[href]");
      for (let a of links) {
        if (!(a instanceof HTMLAnchorElement) || !a.href || !ORIGIN_HREF.test(a.href) && a !== img.closest("a")) continue;
        let box2 = a.getBoundingClientRect(), overlap = smallerRectOverlap(hostRect, {
          left: box2.left,
          top: box2.top,
          right: box2.right,
          bottom: box2.bottom
        });
        (a.contains(img) || overlap >= 0.25) && add(a.href);
      }
    }
    let box = hostRect;
    return box.left > innerWidth * 0.45 && Math.min(box.width, box.height) > 160 && add(location.href), hrefs;
  }
  function originHrefAtPoint(img) {
    let hostRect = paintedRect(img);
    if (!(hostRect.width > 0 && hostRect.height > 0)) return null;
    let x = hostRect.left + hostRect.width / 2, y = hostRect.top + hostRect.height / 2;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return null;
    try {
      for (let node of document.elementsFromPoint(x, y)) {
        if (!(node instanceof Element)) continue;
        let a = node instanceof HTMLAnchorElement ? node : node.closest("a");
        if (a?.href && ORIGIN_HREF.test(a.href)) return a.href;
      }
    } catch {
      return null;
    }
    return null;
  }
  function clearSearchThumbFallback(img) {
    let timer = searchThumbFallbackTimer.get(img);
    timer && (clearTimeout(timer), searchThumbFallbackTimer.delete(img));
  }
  function scheduleSearchThumbFallback(img) {
    searchThumbFallbackDue.has(img) || searchThumbFallbackTimer.has(img) || searchThumbFallbackTimer.set(
      img,
      setTimeout(() => {
        searchThumbFallbackTimer.delete(img), searchThumbFallbackDue.add(img), considerImage(img) && io.unobserve(img);
      }, 800)
    );
  }
  function viewerOriginKeys(img, scanUrl) {
    let keys = /* @__PURE__ */ new Set(), add = (href) => {
      let key = imageResourceKey(href);
      key && keys.add(key);
    };
    add(scanUrl), add(imageUrlFromQuery(location.href));
    for (let href of collectSourceHrefs(img))
      add(imageUrlFromQuery(href)), add(href);
    let hostRect = paintedRect(img);
    for (let a of document.links) {
      if (!ORIGIN_HREF.test(a.href)) continue;
      let box = a.getBoundingClientRect();
      smallerRectOverlap(hostRect, {
        left: box.left,
        top: box.top,
        right: box.right,
        bottom: box.bottom
      }) < 0.15 || add(imageUrlFromQuery(a.href));
    }
    return keys;
  }
  function thumbNamesViewer(img, keys) {
    for (let href of collectSourceHrefs(img)) {
      let inner = imageUrlFromQuery(href) || href, key = imageResourceKey(inner);
      if (key && keys.has(key)) return !0;
    }
    return !1;
  }
  function thumbBelongsToViewer(img, keys) {
    return thumbNamesViewer(img, keys);
  }
  function bindThumbToViewer(thumb) {
    if (!thumb?.isConnected || !viewerOriginal) return;
    let src = thumb.currentSrc || thumb.src;
    if (!isSearchThumbnail(src) || src === viewerOriginal.url) return;
    let prev = upgradeResolved.get(thumb), state = states.get(thumb);
    prev?.url === viewerOriginal.url && prev.src === src && state?.url === viewerOriginal.url || (waitingForOrigin.delete(thumb), clearSearchThumbFallback(thumb), upgradeResolved.set(thumb, { src, url: viewerOriginal.url }), considerImage(thumb) && io.unobserve(thumb));
  }
  var publishingViewerOriginal = !1;
  function publishViewerOriginal(img, scanUrl) {
    if (publishingViewerOriginal || !scanUrl || isSearchThumbnail(scanUrl)) return;
    try {
      let parsed = new URL(scanUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
    } catch {
      return;
    }
    let viewer = { url: scanUrl, keys: viewerOriginKeys(img, scanUrl) };
    viewerOriginal = viewer, publishingViewerOriginal = !0;
    try {
      lastActivatedThumb && bindThumbToViewer(lastActivatedThumb);
      for (let thumb of document.images)
        thumb !== lastActivatedThumb && isSearchThumbnail(thumb.currentSrc || thumb.src) && thumbNamesViewer(thumb, viewer.keys) && bindThumbToViewer(thumb);
    } finally {
      publishingViewerOriginal = !1;
    }
  }
  function rememberActivatedThumb(ev) {
    if (!(ev instanceof MouseEvent)) return;
    let path = ev.composedPath();
    for (let node of path)
      if (node instanceof HTMLElement && (node.classList.contains("blur-veil") || node.classList.contains("blur-toggle")))
        return;
    let hit = null;
    for (let node of ev.composedPath())
      if (node instanceof HTMLImageElement) {
        hit = node;
        break;
      }
    if (!hit) {
      let x = ev.clientX, y = ev.clientY, bestArea = 1 / 0;
      for (let img of document.images) {
        let rect = img.getBoundingClientRect();
        if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom || Math.min(rect.width, rect.height) < 64) continue;
        let area = rect.width * rect.height;
        area >= bestArea || (bestArea = area, hit = img);
      }
    }
    if (hit && isSearchThumbnail(hit.currentSrc || hit.src)) {
      let st = states.get(hit);
      if (!!(st && shouldBlurImage(st))) return;
      lastActivatedThumb = hit, viewerOriginal && thumbNamesViewer(hit, viewerOriginal.keys) && bindThumbToViewer(hit);
    }
  }
  function retrySearchThumbnailUpgrades() {
    for (let img of waitingForOrigin) {
      if (!img.isConnected) {
        waitingForOrigin.delete(img), clearSearchThumbFallback(img);
        continue;
      }
      considerImage(img) && io.unobserve(img);
    }
    for (let el of byId.values()) {
      if (!(el instanceof HTMLImageElement)) continue;
      let src = el.currentSrc || el.src;
      if (!isSearchThumbnail(src)) continue;
      let bound = upgradeResolved.get(el)?.url;
      (viewerOriginal ? bound === viewerOriginal.url : bound) || considerImage(el) && io.unobserve(el);
    }
  }
  function upgradeCandidatesFor(img, url) {
    let picture = img.parentElement instanceof HTMLPictureElement ? img.parentElement : null, hrefs = collectSourceHrefs(img);
    return upgradeCandidates({
      current: url,
      shortEdge: Math.min(img.naturalWidth, img.naturalHeight),
      minShortEdge: 440,
      base: document.baseURI,
      srcset: img.getAttribute("srcset") ?? picture?.querySelector("source[srcset]")?.getAttribute("srcset"),
      dataset: { ...img.dataset },
      linkHref: hrefs[0] ?? null,
      linkHrefs: hrefs.length > 1 ? hrefs.slice(1) : void 0,
      limit: 3
    });
  }
  var upgradeProbesActive = 0, upgradeProbeWaiters = [];
  function acquireUpgradeProbeSlot() {
    return upgradeProbesActive < 2 ? (upgradeProbesActive += 1, Promise.resolve()) : new Promise((resolve, reject) => {
      upgradeProbeWaiters.push({
        resolve: () => resolve(void 0),
        reject
      });
    }).then(() => {
      upgradeProbesActive += 1;
    });
  }
  function releaseUpgradeProbeSlot() {
    upgradeProbesActive = Math.max(0, upgradeProbesActive - 1);
    let next = upgradeProbeWaiters.shift();
    next && next.resolve();
  }
  function cancelUpgradeProbeWaiters() {
    let err = new Error("cancelled");
    for (; upgradeProbeWaiters.length > 0; )
      upgradeProbeWaiters.shift()?.reject(err);
  }
  function probeImageSize(url) {
    return acquireUpgradeProbeSlot().then(
      () => new Promise((resolve) => {
        let probe = new Image(), timer, done = (value) => {
          clearTimeout(timer), probe.onload = null, probe.onerror = null, resolve(value);
        };
        timer = setTimeout(() => {
          probe.src = "data:,", done(null);
        }, 6e3), probe.onload = () => done(probe.naturalWidth > 0 ? { width: probe.naturalWidth, height: probe.naturalHeight } : null), probe.onerror = () => done(null), probe.referrerPolicy = "no-referrer", probe.decoding = "async", probe.src = url;
      }).finally(releaseUpgradeProbeSlot)
    );
  }
  async function resolveUpgrade(img, src, candidates) {
    let renderedAspect = img.naturalWidth / img.naturalHeight, renderedShortEdge = Math.min(img.naturalWidth, img.naturalHeight), chosen = null, note = "no larger source found";
    try {
      for (let candidate of candidates) {
        let probed = await probeImageSize(candidate.url);
        if (!probed) {
          note = "full-resolution source unreachable";
          continue;
        }
        if (Math.min(probed.width, probed.height) <= renderedShortEdge) {
          note = "no larger source found";
          continue;
        }
        if (candidate.confidence === "linked" && Math.abs(Math.log(probed.width / probed.height / renderedAspect)) > 0.12) {
          note = "linked image is a different picture";
          continue;
        }
        chosen = candidate.url, note = null;
        break;
      }
    } catch (err) {
      note = "source upgrade failed", !1;
    } finally {
      upgradeResolved.set(img, { src, url: chosen, note }), upgradeInFlight.delete(img), considerImage(img) && io.unobserve(img);
    }
  }
  async function resolveBlobUrl(img, blobUrl) {
    try {
      let blob = await (await fetch(blobUrl)).blob();
      if (blob.size > 2097152)
        throw new Error(`blob too large to inline: ${blob.size} bytes`);
      let dataUrl = await new Promise((resolve, reject) => {
        let reader = new FileReader();
        reader.onload = () => resolve(
          /** @type {string} */
          reader.result
        ), reader.onerror = () => reject(reader.error ?? new Error("FileReader failed")), reader.readAsDataURL(blob);
      });
      blobResolved.set(img, { src: blobUrl, dataUrl }), considerImage(img) && io.unobserve(img);
    } catch (err) {
      !1;
      let existing = states.get(img);
      existing && (removeUnblurVeil(existing), removeBadge(existing), byId.delete(existing.id), viewportPriorityObserver.unobserve(img), layoutObserver.unobserve(img)), states.set(img, {
        id: "",
        url: blobUrl,
        phase: "skipped",
        badge: null,
        update: null,
        epoch,
        priority: 0
      }), io.unobserve(img);
    } finally {
      blobInFlight.delete(img);
    }
  }
  function considerBackground(el, priority) {
    if (!enabled) return !1;
    let url = cssBackgroundUrls(getComputedStyle(el).backgroundImage).find((u) => /^(https?:|data:)/.test(u));
    if (!url) return !0;
    let state = states.get(el);
    if (state && state.url === url && state.epoch === epoch && state.phase !== "no-model" && state.phase !== "skipped")
      return !0;
    if (state) {
      let wasSkipped = state.phase === "skipped";
      removeUnblurVeil(state), removeBadge(state), byId.delete(state.id), viewportPriorityObserver.unobserve(el), wasSkipped || layoutObserver.unobserve(el), states.delete(el);
    }
    let rect = el.getBoundingClientRect(), candidate = classifyPaintedCandidate({
      url,
      displayedWidth: rect.width,
      displayedHeight: rect.height,
      minEdge: 64
    });
    return candidate === "wait-source" ? !1 : candidate === "skip" ? (states.set(el, {
      id: "",
      url,
      phase: "skipped",
      badge: null,
      update: null,
      epoch,
      priority: 0
    }), Math.min(rect.width, rect.height) < 64 ? layoutObserver.observe(el) : layoutObserver.unobserve(el), !0) : beginScan(el, url, priority);
  }
  function considerTarget(el, priority) {
    return enabled ? isOverlayNode(el) ? !0 : el instanceof HTMLImageElement ? considerImage(el, priority) : el instanceof HTMLElement ? considerBackground(el, priority) : !0 : !1;
  }
  function forEachVisibleByPriority(items, visit) {
    if (items.length === 0) return;
    let viewport = { width: window.innerWidth, height: window.innerHeight };
    items.sort((a, b) => +(b.target instanceof HTMLImageElement) - +(a.target instanceof HTMLImageElement) || compareViewportCandidates(a.rect, b.rect, viewport));
    let base = nextVisiblePriorityBase();
    for (let i = 0; i < items.length; i += 1) {
      let item = items[i];
      if (!item) continue;
      let rank = (items.length - i) / (items.length + 1);
      visit(item.target, base + rank);
    }
  }
  var viewportPriorityObserver = new IntersectionObserver(
    (entries) => {
      if (!enabled || !started || contextInvalidated || document.visibilityState === "hidden") return;
      let visible = entries.filter((entry) => entry.isIntersecting && entry.target instanceof Element).map((entry) => ({ target: entry.target, rect: entry.boundingClientRect }));
      forEachVisibleByPriority(visible, (target, priority) => {
        if (!(target instanceof HTMLElement)) return;
        let state = states.get(target);
        state && (promoteScan(state, priority), state.phase === "pending" && renderBadge(target, state));
      }), visible.length > 0 && repositionAll();
    },
    { rootMargin: "0px" }
  ), layoutObserver = new ResizeObserver((entries) => {
    if (!enabled || !started || contextInvalidated) return;
    let reposition = !1;
    for (let entry of entries) {
      if (!(entry.target instanceof HTMLElement)) continue;
      let state = states.get(entry.target);
      state?.phase === "skipped" && Math.min(entry.contentRect.width, entry.contentRect.height) >= 64 && resetImageObservation(io, entry.target), (state?.badge || state?.unblurVeil) && (reposition = !0);
    }
    reposition && repositionAll({ allowNativeSkip: !1 });
  }), OVERLAY_ACTIVITY_MARGIN = 512, overlayActivityObserver = new IntersectionObserver(
    (entries) => {
      if (!enabled || !started || contextInvalidated) return;
      let wake = !1;
      for (let entry of entries) {
        if (!(entry.target instanceof HTMLElement)) continue;
        let state = states.get(entry.target);
        if (!state) continue;
        let parked = !entry.isIntersecting;
        !!state.overlayParked !== parked && (state.overlayParked = parked, !parked && (state.badge || state.unblurVeil) && (wake = !0));
      }
      wake && repositionAll();
    },
    { rootMargin: `${OVERLAY_ACTIVITY_MARGIN}px` }
  );
  function watchOverlayActivity(el) {
    nativeAnchorPositioning && overlayActivityObserver.observe(el);
  }
  var io = new IntersectionObserver(
    (entries) => {
      if (!enabled || !started || contextInvalidated) return;
      if (document.visibilityState === "hidden") {
        for (let entry of entries)
          entry.isIntersecting && entry.target instanceof Element && deferredWhileHidden.add(entry.target);
        return;
      }
      let visible = [], near = [];
      for (let entry of entries)
        !entry.isIntersecting || !(entry.target instanceof Element) || (isRectInViewport(entry.boundingClientRect, {
          width: window.innerWidth,
          height: window.innerHeight
        }) ? visible.push({ target: entry.target, rect: entry.boundingClientRect }) : near.push(entry.target));
      forEachVisibleByPriority(visible, (el, priority) => {
        considerTarget(el, priority) && io.unobserve(el);
      });
      for (let el of near)
        considerTarget(el, 0) && io.unobserve(el);
    },
    { rootMargin: `${500}px` }
  );
  document.addEventListener("visibilitychange", () => {
    if (!enabled || !started || contextInvalidated || document.visibilityState === "hidden") return;
    let viewport = { width: window.innerWidth, height: window.innerHeight }, resumedVisible = [], resumedNear = [];
    for (let el of deferredWhileHidden) {
      if (!(el instanceof Element) || !el.isConnected) continue;
      let rect = el.getBoundingClientRect();
      isRectInViewport(rect, viewport) ? resumedVisible.push({ target: el, rect }) : resumedNear.push(el);
    }
    deferredWhileHidden.clear(), forEachVisibleByPriority(resumedVisible, (el, priority) => {
      considerTarget(el, priority) && io.unobserve(el);
    });
    let leftoverNear = resumedNear;
    scheduleIdle(() => {
      if (!(!enabled || !started || contextInvalidated))
        for (let el of leftoverNear)
          el.isConnected && considerTarget(el, 0) && io.unobserve(el);
    }, 400);
    let visible = [];
    for (let [, el] of byId) {
      if (states.get(el)?.phase !== "pending") continue;
      let rect = el.getBoundingClientRect();
      isRectInViewport(rect, viewport) && visible.push({ target: el, rect });
    }
    forEachVisibleByPriority(visible, (target, priority) => {
      if (!(target instanceof HTMLElement)) return;
      let state = states.get(target);
      state && (promoteScan(state, priority), state.phase === "pending" && renderBadge(target, state));
    }), repositionAll({ hitTest: !0 });
  });
  function onCompositorSettle(ev) {
    !(ev.target instanceof Element) || isOverlayNode(ev.target) || ev.target instanceof HTMLElement && (ev.target.classList.contains("badge") || ev.target.classList.contains("blur-veil")) || scheduleIdleHitTest();
  }
  document.addEventListener("transitionend", onCompositorSettle, { capture: !0, passive: !0 });
  document.addEventListener("animationend", onCompositorSettle, { capture: !0, passive: !0 });
  function walkTree(root, visit) {
    let stack = [root];
    for (; stack.length > 0; ) {
      let node = stack.pop();
      if (node && !isOverlayNode(node)) {
        if (node instanceof HTMLImageElement) {
          visit(node), node.shadowRoot && stack.push(node.shadowRoot);
          continue;
        }
        if (node instanceof Element) {
          visit(node), node.shadowRoot && stack.push(node.shadowRoot);
          for (let i = node.children.length - 1; i >= 0; i -= 1) {
            let child = node.children[i];
            child && stack.push(child);
          }
        }
      }
    }
  }
  function needsDiscoveryObserve(el) {
    if (!(el instanceof HTMLElement)) return !0;
    let state = states.get(el);
    return !state || state.holdScan ? !0 : state.phase !== "scored" && state.phase !== "unscannable";
  }
  function observeImages(root) {
    if (enabled && !(root instanceof Element && isOverlayNode(root))) {
      if (root instanceof HTMLImageElement) {
        needsDiscoveryObserve(root) && io.observe(root);
        return;
      }
      if (root instanceof Element) {
        let images = [], backgrounds = [];
        walkTree(root, (el) => {
          el instanceof HTMLImageElement ? images.push(el) : el instanceof HTMLElement && isBackgroundWatchTag(el.tagName) && backgrounds.push(el);
        });
        for (let image of images)
          needsDiscoveryObserve(image) && io.observe(image);
        if (root === document.documentElement && backgrounds.length > 32) {
          let deferred = backgrounds;
          scheduleIdle(() => {
            if (!(!enabled || !started || contextInvalidated))
              for (let background of deferred)
                background.isConnected && needsDiscoveryObserve(background) && io.observe(background);
          }, 400);
        } else
          for (let background of backgrounds)
            needsDiscoveryObserve(background) && io.observe(background);
        return;
      }
      if ("querySelectorAll" in root)
        for (let img of root.querySelectorAll("img"))
          needsDiscoveryObserve(img) && io.observe(img);
    }
  }
  function stopObservingTree(root) {
    walkTree(root, (el) => {
      io.unobserve(el), viewportPriorityObserver.unobserve(el), layoutObserver.unobserve(el), overlayActivityObserver.unobserve(el);
    });
  }
  var mo = new MutationObserver((records) => {
    if (!enabled || !started || contextInvalidated) return;
    let removed = !1, occlusionDirty = !1, retryThumbs = !1, removedRoots = [], resetTargets = /* @__PURE__ */ new Set();
    for (let rec of records) {
      for (let node of rec.addedNodes)
        node instanceof Element && !isOverlayNode(node) && (observeImages(node), occlusionDirty = !0, (node instanceof HTMLAnchorElement || node.querySelector?.("a[href]")) && (retryThumbs = !0));
      if (rec.removedNodes.length > 0) {
        removed = !0, occlusionDirty = !0;
        for (let node of rec.removedNodes)
          node instanceof Element && removedRoots.push(node);
      }
      if (rec.type === "attributes" && rec.target instanceof Element) {
        if (isOverlayNode(rec.target)) continue;
        let name = rec.attributeName;
        rec.target instanceof HTMLImageElement ? attributeResetsObservation(!0, name) && resetTargets.add(rec.target) : name === "href" ? retryThumbs = !0 : attributeResetsObservation(!1, name) && (occlusionDirty = !0, rec.target instanceof HTMLElement && isBackgroundWatchTag(rec.target.tagName) && resetTargets.add(rec.target));
      }
    }
    for (let el of resetTargets) resetImageObservation(io, el);
    if (retryThumbs && scheduleSearchThumbnailUpgradeRetry(), removed) {
      for (let root of removedRoots)
        root.isConnected || stopObservingTree(root);
      for (let [id, el] of byId)
        el.isConnected || sweepOne(id, el);
    }
    occlusionDirty && scheduleIdleHitTest();
  });
  function boot() {
    if (started || contextInvalidated || !enabled) return;
    try {
      clearOverlayHide(document);
    } catch {
    }
    ensurePort();
    let root = document.documentElement;
    if (!root) {
      waitingForDocumentRoot || (waitingForDocumentRoot = !0, document.addEventListener(
        "readystatechange",
        () => {
          waitingForDocumentRoot = !1, enabled && boot();
        },
        { once: !0 }
      ));
      return;
    }
    started = !0, reobserveTrackedElements(), observeImages(root), mo.observe(root, {
      childList: !0,
      subtree: !0,
      attributes: !0,
      attributeFilter: ["src", "srcset", "style", "class", "href"]
    }), resumePendingScans(), syncAllImageBlurs(), byId.size > 0 && repositionAll({ allowNativeSkip: !1 }), console.info(
      `[ai-image-detector] scanner active in ${window === top ? "top frame" : "iframe"}, ${document.images.length} <img> present at boot`
    ), !1;
  }
  function reobserveTrackedElements() {
    for (let el of byId.values()) {
      if (!el.isConnected) continue;
      layoutObserver.observe(el), viewportPriorityObserver.observe(el);
      let state = states.get(el);
      (state?.badge || state?.unblurVeil) && watchOverlayActivity(el);
    }
  }
  function resumePendingScans() {
    for (let [, el] of byId) {
      if (!el.isConnected) continue;
      let state = states.get(el);
      !state || state.holdScan || (state.phase === "pending" || state.phase === "no-model") && requestScan(el, state);
    }
  }
  function startHud() {
    let root = ensureOverlay(), hud = root.querySelector(".hud");
    hud || (hud = document.createElement("div"), hud.className = "hud", root.appendChild(hud)), hudTimer && (clearInterval(hudTimer), hudTimer = null);
    let tick = () => {
      if (!extensionAlive()) return;
      let imgs = document.images.length, queued = 0, scored = 0, skipped = 0, failed = 0, setup = 0;
      for (let [, el] of byId) {
        let s = states.get(el);
        s && (s.phase === "skipped" ? skipped++ : s.phase === "scored" ? scored++ : s.phase === "pending" ? queued++ : s.phase === "unscannable" ? failed++ : s.phase === "no-model" && setup++);
      }
      hud.textContent = `AID dev \xB7 ${imgs} img \xB7 ${byId.size} tracked \xB7 ${scored} scored \xB7 ${queued} pending \xB7 ${failed} failed \xB7 ${setup} setup \xB7 ${skipped} too-small`;
    };
    tick(), hudTimer = setInterval(tick, 500);
  }
  var enabledWanted = !1, enabledApplyTimer = null;
  function applyEnabledSetting(on) {
    if (enabledWanted = !!on, !enabledWanted)
      try {
        hideOverlayNodes(document);
      } catch {
      }
    enabledApplyTimer == null && (enabledApplyTimer = setTimeout(flushEnabledSetting, 0));
  }
  function flushEnabledSetting() {
    if (enabledApplyTimer = null, enabledWanted) {
      if (enabled && started) {
        try {
          clearOverlayHide(document);
        } catch {
        }
        return;
      }
      enabled = !0, started || boot();
      return;
    }
    !enabled && !started || (enabled = !1, started && pauseScanning());
  }
  function pauseScanning() {
    enabled = !1, started = !1;
    try {
      io.disconnect(), viewportPriorityObserver.disconnect(), layoutObserver.disconnect(), overlayActivityObserver.disconnect(), mo.disconnect();
    } catch {
    }
    hudTimer && (clearInterval(hudTimer), hudTimer = null);
    try {
      hideOverlayNodes(document);
    } catch {
    }
    try {
      closePopover();
    } catch {
    }
    let openPort = port;
    port = null;
    try {
      openPort?.disconnect();
    } catch {
      markContextInvalidated();
    }
    registry.reset(), cancelUpgradeProbeWaiters(), lastActivatedThumb?.isConnected || (lastActivatedThumb = null);
  }
  function rescanVisible() {
    !enabled || !started || (epoch += 1, observeImages(document.documentElement));
  }
  function applyBlurSetting(on) {
    let next = !!on, changed = next !== blurAiImages;
    if (blurAiImages = next, changed)
      for (let el of byId.values()) {
        let state = states.get(el);
        state && (state.blurRevealed = !1, next || (state.blurForced = !1));
      }
    syncAllImageBlurs();
  }
  chrome.runtime.onMessage.addListener((msg) => {
    if (extensionAlive()) {
      if (msg?.type === MSG.ENABLED_SETTING) {
        receivedLiveEnabled = !0, applyEnabledSetting(!!msg.enabled);
        return;
      }
      if (msg?.type === MSG.BLUR_SETTING) {
        receivedLiveBlur = !0, applyBlurSetting(msg.enabled);
        return;
      }
      msg?.type === MSG.MODEL_READY && applyModelReady();
    }
  });
  chrome.storage.local.get([ENABLED_FLAG, BLUR_AI_FLAG]).then((got) => {
    let blur = readStoredFlag(receivedLiveBlur, got[BLUR_AI_FLAG], BLUR_AI_DEFAULT);
    blur !== null && applyBlurSetting(blur);
    let nextEnabled = readStoredFlag(receivedLiveEnabled, got[ENABLED_FLAG], !0);
    nextEnabled !== null && applyEnabledSetting(nextEnabled);
  }).catch((err) => {
    if (receivedLiveEnabled) return;
    let message = err instanceof Error ? err.message : String(err);
    if (/context invalidated/i.test(message)) {
      markContextInvalidated();
      return;
    }
    console.warn("[ai-image-detector] storage read failed, scanning anyway:", err), enabled = !0, boot();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    extensionAlive() && area === "local" && (BLUR_AI_FLAG in changes && (receivedLiveBlur = !0, applyBlurSetting(blurFromStorage(changes[BLUR_AI_FLAG]?.newValue))), ENABLED_FLAG in changes && (receivedLiveEnabled = !0, applyEnabledSetting(enabledFromStorage(changes[ENABLED_FLAG]?.newValue))));
  });
})();
