/** Popup: status readout + enable toggle. Polls while open; no persistence here. */

import { MSG, TARGET } from '../shared/messages.js';
import { DEV_MOCK_FLAG, DEV_MOCK_DEFAULT, DEV_BUILD, ENABLED_FLAG } from '../shared/constants.js';

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

async function refresh() {
  try {
    const status = await chrome.runtime.sendMessage({ type: MSG.STATUS_GET, target: TARGET.SW });
    const model = status?.model ?? { state: 'error', detail: 'no response' };
    const el = $('model-state');
    el.textContent = model.state;
    el.className = `status ${model.state}`;
    el.title = model.detail ?? '';
    const bar = /** @type {HTMLProgressElement} */ ($('model-progress'));
    bar.hidden = model.state !== 'downloading';
    if (typeof model.progress === 'number') bar.value = model.progress;
    $('scanned').textContent = String(status?.scannedThisSession ?? 0);
  } catch {
    $('model-state').textContent = 'unavailable';
  }
}

async function initToggles() {
  const got = await chrome.storage.local.get([ENABLED_FLAG, DEV_MOCK_FLAG]);
  const enabledBox = /** @type {HTMLInputElement} */ ($('enabled'));
  const mockBox = /** @type {HTMLInputElement} */ ($('dev-mock'));
  const v = got[ENABLED_FLAG];
  enabledBox.checked = v === undefined ? true : Boolean(v);
  const m = got[DEV_MOCK_FLAG];
  mockBox.checked = m === undefined ? DEV_MOCK_DEFAULT : Boolean(m);

  // In release builds the mock is an opt-in debugging aid; in dev builds it is
  // on by default and the popup says so loudly.
  if (DEV_BUILD) {
    const note = document.createElement('div');
    note.style.cssText = 'margin-top:6px;color:#f0b429;font-weight:600;';
    note.textContent = 'DEV BUILD — scores are simulated, not real detection';
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
void refresh();
setInterval(refresh, 1000);
