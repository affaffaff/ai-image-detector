/**
 * One-time model weight download: fetch -> resume -> SHA-256 verify -> OPFS.
 *
 * This is the ONLY network access this extension ever performs, permitted
 * explicitly by the bounty rules ("one-time download of publicly available
 * model weights during initial setup"). After the file verifies, everything
 * runs offline forever. There is no fetch() anywhere in a scan path.
 *
 * Resumability: the eval flow installs the extension, lets it download, then
 * cuts the network — an interrupted download must recover, not restart.
 * Partial bytes are kept in `<id>.part` in OPFS and resumed with a Range
 * request. On completion the file is hash-verified against the pinned SHA-256
 * from models/manifest.json; a mismatch deletes the file and errors loudly.
 */

/** @typedef {{id: string, url: string | null, sha256: string | null, bytes: number | null}} ModelManifestEntry */

const PART_SUFFIX = '.part';

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
 * Return the verified model file if it is already installed, else null.
 * @param {ModelManifestEntry} entry
 * @returns {Promise<File | null>}
 */
export async function getInstalledModel(entry) {
  try {
    const dir = await modelsDir();
    const handle = await dir.getFileHandle(entry.id);
    const file = await handle.getFile();
    // Size check is cheap corruption detection; the full hash was verified at
    // install time and the file is never rewritten afterwards.
    if (entry.bytes != null && file.size !== entry.bytes) return null;
    return file;
  } catch {
    return null;
  }
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

  // How many bytes we already have from an interrupted attempt.
  let offset = 0;
  try {
    const existing = await (await dir.getFileHandle(partName)).getFile();
    offset = existing.size;
  } catch {
    /* no partial file */
  }

  /** @type {HeadersInit} */
  const headers = offset > 0 ? { Range: `bytes=${offset}-` } : {};
  const res = await fetch(entry.url, { headers, credentials: 'omit', cache: 'no-store' });

  // A host that ignores Range replies 200 with the whole file: restart clean.
  if (offset > 0 && res.status !== 206) offset = 0;
  if (!res.ok && res.status !== 206) {
    throw new Error(`model download failed: HTTP ${res.status}`);
  }
  if (!res.body) throw new Error('model download failed: empty body');

  const partHandle = await dir.getFileHandle(partName, { create: true });
  const writable = await partHandle.createWritable({ keepExistingData: offset > 0 });
  await writable.seek(offset);

  const total = entry.bytes ?? Number(res.headers.get('Content-Length') ?? 0) + offset;
  let written = offset;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await writable.write(value);
      written += value.byteLength;
      if (onProgress && total > 0) onProgress(Math.min(written / total, 1));
    }
    await writable.close();
  } catch (err) {
    // Keep the partial bytes for resume; abort() would discard them.
    await writable.close().catch(() => {});
    throw err;
  }

  // Verify BEFORE install. A corrupt or tampered file must never be loadable.
  const partFile = await partHandle.getFile();
  const actual = await sha256Hex(await partFile.arrayBuffer());
  if (actual !== entry.sha256.toLowerCase()) {
    await dir.removeEntry(partName).catch(() => {});
    throw new Error(
      `model '${entry.id}' hash mismatch: expected ${entry.sha256}, got ${actual}. ` +
        'Partial file deleted; download will restart from zero.',
    );
  }

  // Atomic-enough install: rename the verified .part into place.
  // FileSystemFileHandle.move() is Chrome-only (110+) and missing from the TS
  // lib; our minimum_chrome_version is 116.
  await /** @type {{move: (name: string) => Promise<void>}} */ (
    /** @type {unknown} */ (partHandle)
  ).move(entry.id);
  const final = await (await dir.getFileHandle(entry.id)).getFile();
  return final;
}
