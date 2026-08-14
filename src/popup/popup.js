/** Popup: status readout + Detection/Blur toggles. Settings live in chrome.storage.local. */

import { MSG, TARGET } from '../shared/messages.js';
import {
  BLUR_AI_DEFAULT,
  BLUR_AI_FLAG,
  DEV_MOCK_FLAG,
  DEV_MOCK_DEFAULT,
  ENABLED_FLAG,
  readStoredFlag,
} from '../shared/constants.js';

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

let refreshing = false;

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const status = await chrome.runtime.sendMessage({ type: MSG.STATUS_GET, target: TARGET.SW });
    const model = status?.model ?? { state: 'error', detail: 'no response' };
    const el = $('model-state');
    el.textContent = model.state;
    el.className = `status ${model.state}`;
    el.title = model.detail ?? '';
    const downloading = model.state === 'downloading';
    const retryable = model.state === 'missing' || model.state === 'error';
    const prog = typeof model.progress === 'number' ? model.progress : 0;
    /** @type {HTMLElement} */ ($('prog-wrap')).classList.toggle(
      'on',
      downloading || (prog > 0 && model.state !== 'ready'),
    );
    /** @type {HTMLElement} */ ($('model-progress-fill')).style.transform = `scaleX(${prog})`;
    $('model-progress-pct').textContent = `${Math.round(prog * 100)}%`;
    const detail = $('model-detail');
    detail.textContent = model.detail ?? '';
    detail.classList.toggle('on', Boolean(model.detail));
    const retry = /** @type {HTMLButtonElement} */ ($('model-retry'));
    retry.classList.toggle('on', retryable);
    // Disabled whenever the row is not actionable — including 'downloading',
    // so the 1s refresh interval cannot re-enable the button mid-retry.
    retry.disabled = !retryable;
    $('scanned').textContent = String(status?.scannedThisSession ?? 0);
  } catch (err) {
    const state = $('model-state');
    state.textContent = 'unavailable';
    // Reset the status colour too — a stale 'ready'/'downloading' class would
    // paint an unreachable worker in green/cyan.
    state.className = 'status error';
    const detail = $('model-detail');
    detail.textContent = err instanceof Error ? err.message : String(err);
    detail.classList.add('on');
    const retry = /** @type {HTMLButtonElement} */ ($('model-retry'));
    retry.classList.add('on');
    // A previous poll may have left the button disabled (e.g. 'downloading');
    // an unreachable worker is precisely when Retry must be clickable.
    retry.disabled = false;
  } finally {
    refreshing = false;
  }
}

async function retryModelDownload() {
  const button = /** @type {HTMLButtonElement} */ ($('model-retry'));
  button.disabled = true;
  $('model-state').textContent = 'downloading';
  $('model-state').className = 'status downloading';
  try {
    await chrome.runtime.sendMessage({ type: MSG.MODEL_RETRY, target: TARGET.SW });
  } catch (err) {
    const detail = $('model-detail');
    detail.textContent = err instanceof Error ? err.message : String(err);
    detail.classList.add('on');
  } finally {
    button.disabled = false;
    await refresh();
  }
}

function initToggles() {
  const enabledBox = /** @type {HTMLInputElement} */ ($('enabled'));
  const blurBox = /** @type {HTMLInputElement} */ ($('blur-ai'));
  const mockBox = /** @type {HTMLInputElement} */ ($('dev-mock'));
  $('dev-controls').hidden = !__DEV_BUILD__;

  // Bind before storage.get. A wrapping <label> in an MV3 popup can close the
  // window on click (Chromium 408840), and any await before the listener used
  // to drop the first click so Detection/Blur snapped back on the next open.
  let enabledTouched = false;
  let blurTouched = false;
  let mockTouched = false;

  bindToggleRow(enabledBox, () => {
    enabledTouched = true;
    syncEnabledUi(enabledBox.checked);
    void pushEnabledSetting(enabledBox.checked);
  });
  bindToggleRow(blurBox, () => {
    blurTouched = true;
    void pushBlurSetting(blurBox.checked);
  });
  mockBox.addEventListener('change', () => {
    mockTouched = true;
    void chrome.storage.local.set({ [DEV_MOCK_FLAG]: mockBox.checked });
  });

  // Second write as the popup tears down. Only touched keys: rewriting an
  // unchanged blur flag would re-blur images the user just revealed.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return;
    flushTouchedToggles({
      enabledTouched,
      blurTouched,
      mockTouched,
      enabled: enabledBox.checked,
      blur: blurBox.checked,
      mock: mockBox.checked,
    });
  });

  void chrome.storage.local
    .get([ENABLED_FLAG, BLUR_AI_FLAG, DEV_MOCK_FLAG])
    .then((got) => {
      const enabled = readStoredFlag(enabledTouched, got[ENABLED_FLAG], true);
      if (enabled !== null) syncEnabledUi(enabled);
      const blur = readStoredFlag(blurTouched, got[BLUR_AI_FLAG], BLUR_AI_DEFAULT);
      if (blur !== null) {
        blurBox.checked = blur;
        syncBlurHint(blur);
      }
      const mock = readStoredFlag(mockTouched, got[DEV_MOCK_FLAG], DEV_MOCK_DEFAULT);
      if (mock !== null) mockBox.checked = mock;
    })
    .catch(() => {});

  // The mock control and engine are compiled out of release builds.
  if (__DEV_BUILD__) {
    const note = document.createElement('div');
    note.style.cssText = 'margin-top:6px;color:#fbbf24;font-weight:600;letter-spacing:0.5px;';
    note.textContent = '\u26a0 DEV BUILD — scores are simulated, not real detection';
    $('dev-mock').closest('div')?.appendChild(note);
  }
}

/**
 * Row clicks toggle the box. The input itself is not hit-testable; a <label>
 * around it used to dismiss the popup before chrome.storage.local.set ran.
 * @param {HTMLInputElement} box
 * @param {() => void} onToggle
 */
function bindToggleRow(box, onToggle) {
  const row = /** @type {HTMLElement | null} */ (box.closest('.row'));
  if (!row) {
    box.addEventListener('change', onToggle);
    return;
  }
  const flip = () => {
    box.checked = !box.checked;
    onToggle();
  };
  row.addEventListener('click', (ev) => {
    ev.preventDefault();
    flip();
  });
  row.addEventListener('keydown', (ev) => {
    if (ev.key !== ' ' && ev.key !== 'Enter') return;
    ev.preventDefault();
    flip();
  });
}

/**
 * @param {{
 *   enabledTouched: boolean,
 *   blurTouched: boolean,
 *   mockTouched: boolean,
 *   enabled: boolean,
 *   blur: boolean,
 *   mock: boolean,
 * }} state
 */
function flushTouchedToggles(state) {
  /** @type {Record<string, boolean>} */
  const payload = {};
  if (state.enabledTouched) payload[ENABLED_FLAG] = state.enabled;
  if (state.blurTouched) payload[BLUR_AI_FLAG] = state.blur;
  if (state.mockTouched) payload[DEV_MOCK_FLAG] = state.mock;
  if (Object.keys(payload).length === 0) return;
  void chrome.storage.local.set(payload);
  if (state.enabledTouched) {
    void chrome.runtime
      .sendMessage({ type: MSG.ENABLED_SETTING, target: TARGET.SW, enabled: state.enabled })
      .catch(() => {});
  }
  if (state.blurTouched) {
    void chrome.runtime
      .sendMessage({ type: MSG.BLUR_SETTING, target: TARGET.SW, enabled: state.blur })
      .catch(() => {});
  }
}

/** @param {boolean} on */
function syncEnabledUi(on) {
  /** @type {HTMLInputElement} */ ($('enabled')).checked = on;
  const row = $('enabled-row');
  if (row) row.setAttribute('aria-checked', on ? 'true' : 'false');
  const live = $('live');
  const label = $('live-label');
  live.classList.toggle('off', !on);
  label.textContent = on ? 'LIVE' : 'OFF';
}

/** @param {boolean} on */
function syncBlurHint(on) {
  const row = $('blur-row');
  if (row) row.setAttribute('aria-checked', on ? 'true' : 'false');
  const hint = $('blur-hint');
  if (!hint) return;
  hint.textContent = on
    ? 'On. AI-scored images are covered; click one to reveal it.'
    : 'Off. Turn on to hide AI-scored images; click one to reveal it.';
}

/** @param {boolean} on */
async function pushEnabledSetting(on) {
  await pushFlag(ENABLED_FLAG, MSG.ENABLED_SETTING, on);
}

/** @param {boolean} on */
async function pushBlurSetting(on) {
  syncBlurHint(on);
  await pushFlag(BLUR_AI_FLAG, MSG.BLUR_SETTING, on);
}

/**
 * Persist starts immediately (any await before storage.set used to skip the
 * write when the popup was destroyed). The service worker is notified in
 * parallel so it can persist too if this document dies. The active tab is
 * notified after storage.set so a racing storage.get cannot read the old flag.
 * @param {string} flag
 * @param {string} type
 * @param {boolean} on
 */
function pushFlag(flag, type, on) {
  const persist = chrome.storage.local.set({ [flag]: on });
  const notifySw = chrome.runtime.sendMessage({ type, target: TARGET.SW, enabled: on }).catch(() => {});
  const notifyTab = persist
    .then(() =>
      chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) =>
        Promise.all(
          tabs.map((tab) =>
            tab.id == null
              ? Promise.resolve()
              : chrome.tabs.sendMessage(tab.id, { type, enabled: on }).catch(() => {}),
          ),
        ),
      ),
    )
    .catch(() => {
      /* popup has no active http tab */
    });
  return Promise.all([persist, notifySw, notifyTab]);
}

void initToggles();
$('model-retry').addEventListener('click', () => void retryModelDownload());
void refresh();
setInterval(refresh, 1000);
