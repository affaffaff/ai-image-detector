/**
 * One-time model weight download: fetch -> resume -> SHA-256 verify -> OPFS.
 *
 * This is the only network access this extension performs on its own behalf: a
 * one-time download of publicly available model weights during initial setup.
 * After the file verifies, inference runs offline forever.
 *
 * Precisely: no scan ever contacts a detector service, and there is none to
 * contact. The scan path does call fetch() once per image, in
 * `offscreen.js#fetchImageBytes`, to read the bytes the page already loaded —
 * cross-origin canvas is tainted, so pixels cannot be read from the page. That
 * request goes to the image's own origin with `credentials: 'omit'` and
 * `cache: 'force-cache'`, which is why scanning keeps working after the network
 * is cut. See `docs/PRIVACY.md`.
 *
 * Resumability: the eval flow installs the extension, lets it download, then
 * cuts the network — an interrupted download must recover, not restart.
 * Partial bytes are kept in `<id>.part` in OPFS and resumed with a Range
 * request. On completion the file is hash-verified against the pinned SHA-256
 * from models/manifest.json; a mismatch deletes the file and errors loudly.
 */

/** @typedef {{id: string, url: string | null, sha256: string | null, bytes: number | null, bundledPath?: string}} ModelManifestEntry */

const PART_SUFFIX = '.part';
/** @type {Set<string>} */
const verifiedThisDocument = new Set();
/** Bytes from the most recent in-document hash, reused by session create. */
/** @type {ArrayBuffer | null} */
let retainedVerifiedBytes = null;

/** @param {ModelManifestEntry} entry */
function verificationKey(entry) {
  return `${entry.id}:${entry.sha256 ?? ''}:${entry.bytes ?? ''}`;
}

/** @param {ArrayBuffer} buf @returns {Promise<string>} lowercase hex sha-256 */
export async function sha256Hex(buf) {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** @returns {Promise<FileSystemDirectoryHandle>} */
async function modelsDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('models', { create: true });
}

/**
 * Return the number of bytes retained from an interrupted attempt.
 *
 * @param {FileSystemDirectoryHandle} dir
 * @param {string} partName
 * @returns {Promise<number>}
 */
async function partialSize(dir, partName) {
  try {
    return (await (await dir.getFileHandle(partName)).getFile()).size;
  } catch {
    return 0;
  }
}

/**
 * Recover user-visible progress from the durable OPFS partial file. This makes
 * progress survive both service-worker suspension and a full browser restart.
 *
 * @param {ModelManifestEntry} entry
 * @returns {Promise<number>} 0..1
 */
export async function getPartialDownloadProgress(entry) {
  if (entry.bytes == null || entry.bytes <= 0) return 0;
  const dir = await modelsDir();
  const size = await partialSize(dir, entry.id + PART_SUFFIX);
  return Math.min(size / entry.bytes, 1);
}

/**
 * Verify a completed partial and move it into its final name.
 *
 * @param {ModelManifestEntry} entry
 * @param {FileSystemDirectoryHandle} dir
 * @param {FileSystemFileHandle} partHandle
 * @returns {Promise<File>}
 */
async function verifyAndInstall(entry, dir, partHandle) {
  const partFile = await partHandle.getFile();
  if (entry.bytes != null && partFile.size !== entry.bytes) {
    if (partFile.size > entry.bytes) await dir.removeEntry(entry.id + PART_SUFFIX).catch(() => {});
    throw new Error(
      `model '${entry.id}' download incomplete: expected ${entry.bytes} bytes, got ${partFile.size}`,
    );
  }

  const actual = await sha256Hex(await partFile.arrayBuffer());
  if (actual !== entry.sha256?.toLowerCase()) {
    await dir.removeEntry(entry.id + PART_SUFFIX).catch(() => {});
    throw new Error(
      `model '${entry.id}' hash mismatch: expected ${entry.sha256}, got ${actual}. ` +
        'Partial file deleted; download will restart from zero.',
    );
  }

  // FileSystemFileHandle.move() is Chrome-only (110+) and missing from the TS
  // lib; our minimum_chrome_version is 116.
  await /** @type {{move: (name: string) => Promise<void>}} */ (
    /** @type {unknown} */ (partHandle)
  ).move(entry.id);
  const final = await (await dir.getFileHandle(entry.id)).getFile();
  verifiedThisDocument.add(verificationKey(entry));
  return final;
}

/** @param {string | null} value */
function contentRange(value) {
  // Some CDNs/proxies pad the header with whitespace; a strict anchored match
  // then failed and permanently killed a resumable download with "invalid
  // Content-Range".
  const match = value?.trim().match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
  if (!match) return null;
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: match[3] === '*' ? null : Number(match[3]),
  };
}

/** @param {string | null} value */
function unsatisfiedRangeTotal(value) {
  const match = value?.trim().match(/^bytes\s+\*\/(\d+)$/i);
  return match ? Number(match[1]) : null;
}

/**
 * Return the verified model file if it is already installed, else null.
 * @param {ModelManifestEntry} entry
 * @returns {Promise<File | null>}
 */
export async function getInstalledModel(entry) {
  try {
    const dir = await modelsDir();
    const handle = await dir.getFileHandle(entry.id);
    const file = await handle.getFile();
    const key = verificationKey(entry);
    if (entry.bytes != null && file.size !== entry.bytes) {
      verifiedThisDocument.delete(key);
      await dir.removeEntry(entry.id).catch(() => {});
      return null;
    }
    // Re-hash once when this offscreen document starts. This catches an
    // extension update that pins a different artifact with the same byte size.
    // Subsequent popup status polls reuse the in-memory verification result.
    if (entry.sha256 && !verifiedThisDocument.has(key)) {
      const buf = await file.arrayBuffer();
      const actual = await sha256Hex(buf);
      if (actual !== entry.sha256.toLowerCase()) {
        await dir.removeEntry(entry.id).catch(() => {});
        return null;
      }
      verifiedThisDocument.add(key);
      retainedVerifiedBytes = buf;
    }
    return file;
  } catch {
    return null;
  }
}

/**
 * Verified model bytes for InferenceSession.create. Reuses the buffer from
 * the one-time in-document hash when it is still available, so startup does
 * not read the ~24MB artifact twice.
 *
 * @param {ModelManifestEntry} entry
 * @returns {Promise<ArrayBuffer | null>}
 */
export async function getInstalledModelBytes(entry) {
  const file = await getInstalledModel(entry);
  if (!file) return null;
  if (retainedVerifiedBytes) {
    const bytes = retainedVerifiedBytes;
    retainedVerifiedBytes = null;
    return bytes;
  }
  return file.arrayBuffer();
}

/**
 * Download (or resume) a model, verify, and install it into OPFS.
 *
 * @param {ModelManifestEntry} entry
 * @param {(progress: number) => void} [onProgress] - 0..1
 * @returns {Promise<File>} the verified installed file
 */
export async function downloadAndInstall(entry, onProgress) {
  if (!entry.url || !entry.sha256) {
    throw new Error(`model '${entry.id}' has no pinned url/sha256 yet (models/manifest.json)`);
  }

  const installed = await getInstalledModel(entry);
  if (installed) return installed;

  const dir = await modelsDir();
  const partName = entry.id + PART_SUFFIX;

  let offset = await partialSize(dir, partName);
  if (entry.bytes != null && offset > entry.bytes) {
    await dir.removeEntry(partName).catch(() => {});
    offset = 0;
  }

  let highestProgress = 0;
  /** @param {number} written @param {number} total */
  const report = (written, total) => {
    if (!onProgress || total <= 0) return;
    highestProgress = Math.max(highestProgress, Math.min(written / total, 1));
    onProgress(highestProgress);
  };
  report(offset, entry.bytes ?? 0);

  // A crash can happen after the final write but before the verified rename.
  // Finish that transaction locally; no network is needed in this state.
  if (entry.bytes != null && offset === entry.bytes) {
    const completePart = await dir.getFileHandle(partName);
    return verifyAndInstall(entry, dir, completePart);
  }

  // At most one clean restart is allowed. It covers an ignored Range request,
  // a stale oversized partial, and HTTP 416 without hiding persistent failures.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    /** @type {HeadersInit} */
    const headers = offset > 0 ? { Range: `bytes=${offset}-` } : {};
    const res = await fetch(entry.url, { headers, credentials: 'omit', cache: 'no-store' });

    if (offset > 0 && res.status === 416) {
      const remoteTotal = unsatisfiedRangeTotal(res.headers.get('Content-Range'));
      if (remoteTotal != null && offset === remoteTotal) {
        const completePart = await dir.getFileHandle(partName);
        return verifyAndInstall(entry, dir, completePart);
      }
      await res.body?.cancel().catch(() => {});
      await dir.removeEntry(partName).catch(() => {});
      offset = 0;
      if (attempt === 0) continue;
    }

    if (!res.ok && res.status !== 206) {
      throw new Error(`model download failed: HTTP ${res.status}`);
    }
    if (!res.body) throw new Error('model download failed: empty body');

    const range = contentRange(res.headers.get('Content-Range'));
    if (res.status === 206 && (!range || range.start !== offset)) {
      await res.body.cancel().catch(() => {});
      throw new Error(
        `model download failed: invalid Content-Range for offset ${offset}: ` +
          `${res.headers.get('Content-Range') ?? 'missing'}`,
      );
    }

    // A host that ignores Range replies 200 with the whole file. Truncate the
    // partial and consume this response as a clean download from byte zero.
    if (offset > 0 && res.status === 200) offset = 0;

    const partHandle = await dir.getFileHandle(partName, { create: true });
    const writable = await partHandle.createWritable({ keepExistingData: offset > 0 });
    await writable.seek(offset);

    const declaredLength = Number(res.headers.get('Content-Length') ?? 0);
    const total = entry.bytes ?? range?.total ?? declaredLength + offset;
    let written = offset;
    report(written, total);
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await writable.write(value);
        written += value.byteLength;
        report(written, total);
      }
      await writable.close();
    } catch (err) {
      // Keep the partial bytes for resume; abort() would discard them.
      await writable.close().catch(() => {});
      throw err;
    } finally {
      reader.releaseLock();
    }

    return verifyAndInstall(entry, dir, partHandle);
  }

  throw new Error('model download failed after restarting an unsatisfied Range request');
}
