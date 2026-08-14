/** Popup: status readout + enable toggle. Polls while open; no persistence here. */

import { MSG, TARGET } from '../shared/messages.js';
import { DEV_MOCK_FLAG, DEV_MOCK_DEFAULT, ENABLED_FLAG } from '../shared/constants.js';

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
    if (!retryable) retry.disabled = false;
    $('scanned').textContent = String(status?.scannedThisSession ?? 0);
  } catch (err) {
    $('model-state').textContent = 'unavailable';
    const detail = $('model-detail');
    detail.textContent = err instanceof Error ? err.message : String(err);
    detail.classList.add('on');
    $('model-retry').classList.add('on');
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

async function initToggles() {
  const got = await chrome.storage.local.get([ENABLED_FLAG, DEV_MOCK_FLAG]);
  const enabledBox = /** @type {HTMLInputElement} */ ($('enabled'));
  const mockBox = /** @type {HTMLInputElement} */ ($('dev-mock'));
  $('dev-controls').hidden = !__DEV_BUILD__;
  const v = got[ENABLED_FLAG];
  enabledBox.checked = v === undefined ? true : Boolean(v);
  const m = got[DEV_MOCK_FLAG];
  mockBox.checked = m === undefined ? DEV_MOCK_DEFAULT : Boolean(m);

  // The mock control and engine are compiled out of release builds.
  if (__DEV_BUILD__) {
    const note = document.createElement('div');
    note.style.cssText = 'margin-top:6px;color:#fbbf24;font-weight:600;letter-spacing:0.5px;';
    note.textContent = '\u26a0 DEV BUILD — scores are simulated, not real detection';
    $('dev-mock').closest('div')?.appendChild(note);
  }
  enabledBox.addEventListener('change', () => {
    void chrome.storage.local.set({ [ENABLED_FLAG]: enabledBox.checked });
  });
  mockBox.addEventListener('change', () => {
    void chrome.storage.local.set({ [DEV_MOCK_FLAG]: mockBox.checked });
  });
}

void initToggles();
$('model-retry').addEventListener('click', () => void retryModelDownload());
void refresh();
setInterval(refresh, 1000);
