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
});
var TARGET = Object.freeze({
  OFFSCREEN: "offscreen",
  SW: "sw"
});

// src/shared/constants.js
var DEV_MOCK_FLAG = "devMockInference";
var ENABLED_FLAG = "enabled";
function flagFromStorage(value, fallback) {
  return value === void 0 ? fallback : !!value;
}
function readStoredFlag(liveApplied, stored, fallback) {
  return liveApplied ? null : flagFromStorage(stored, fallback);
}
var BLUR_AI_FLAG = "blurAiOptIn", BLUR_AI_DEFAULT = !1;

// src/popup/popup.js
var $ = (id) => (
  /** @type {HTMLElement} */
  document.getElementById(id)
), refreshing = !1;
async function refresh() {
  if (!refreshing) {
    refreshing = !0;
    try {
      let status = await chrome.runtime.sendMessage({ type: MSG.STATUS_GET, target: TARGET.SW }), model = status?.model ?? { state: "error", detail: "no response" }, el = $("model-state");
      el.textContent = model.state, el.className = `status ${model.state}`, el.title = model.detail ?? "";
      let downloading = model.state === "downloading", retryable = model.state === "missing" || model.state === "error", prog = typeof model.progress == "number" ? model.progress : 0;
      $("prog-wrap").classList.toggle(
        "on",
        downloading || prog > 0 && model.state !== "ready"
      ), $("model-progress-fill").style.transform = `scaleX(${prog})`, $("model-progress-pct").textContent = `${Math.round(prog * 100)}%`;
      let detail = $("model-detail");
      detail.textContent = model.detail ?? "", detail.classList.toggle("on", !!model.detail);
      let retry = (
        /** @type {HTMLButtonElement} */
        $("model-retry")
      );
      retry.classList.toggle("on", retryable), retry.disabled = !retryable, $("scanned").textContent = String(status?.scannedThisSession ?? 0);
    } catch (err) {
      let state = $("model-state");
      state.textContent = "unavailable", state.className = "status error";
      let detail = $("model-detail");
      detail.textContent = err instanceof Error ? err.message : String(err), detail.classList.add("on");
      let retry = (
        /** @type {HTMLButtonElement} */
        $("model-retry")
      );
      retry.classList.add("on"), retry.disabled = !1;
    } finally {
      refreshing = !1;
    }
  }
}
async function retryModelDownload() {
  let button = (
    /** @type {HTMLButtonElement} */
    $("model-retry")
  );
  button.disabled = !0, $("model-state").textContent = "downloading", $("model-state").className = "status downloading";
  try {
    await chrome.runtime.sendMessage({ type: MSG.MODEL_RETRY, target: TARGET.SW });
  } catch (err) {
    let detail = $("model-detail");
    detail.textContent = err instanceof Error ? err.message : String(err), detail.classList.add("on");
  } finally {
    button.disabled = !1, await refresh();
  }
}
function initToggles() {
  let enabledBox = (
    /** @type {HTMLInputElement} */
    $("enabled")
  ), blurBox = (
    /** @type {HTMLInputElement} */
    $("blur-ai")
  ), mockBox = (
    /** @type {HTMLInputElement} */
    $("dev-mock")
  );
  $("dev-controls").hidden = !0;
  let enabledTouched = !1, blurTouched = !1, mockTouched = !1;
  bindToggleRow(enabledBox, () => {
    enabledTouched = !0, syncEnabledUi(enabledBox.checked), pushEnabledSetting(enabledBox.checked);
  }), bindToggleRow(blurBox, () => {
    blurTouched = !0, pushBlurSetting(blurBox.checked);
  }), mockBox.addEventListener("change", () => {
    mockTouched = !0, chrome.storage.local.set({ [DEV_MOCK_FLAG]: mockBox.checked });
  }), document.addEventListener("visibilitychange", () => {
    document.visibilityState === "hidden" && flushTouchedToggles({
      enabledTouched,
      blurTouched,
      mockTouched,
      enabled: enabledBox.checked,
      blur: blurBox.checked,
      mock: mockBox.checked
    });
  }), chrome.storage.local.get([ENABLED_FLAG, BLUR_AI_FLAG, DEV_MOCK_FLAG]).then((got) => {
    let enabled = readStoredFlag(enabledTouched, got[ENABLED_FLAG], !0);
    enabled !== null && syncEnabledUi(enabled);
    let blur = readStoredFlag(blurTouched, got[BLUR_AI_FLAG], BLUR_AI_DEFAULT);
    blur !== null && (blurBox.checked = blur, syncBlurHint(blur));
    let mock = readStoredFlag(mockTouched, got[DEV_MOCK_FLAG], !1);
    mock !== null && (mockBox.checked = mock);
  }).catch(() => {
  });
}
function bindToggleRow(box, onToggle) {
  let row = (
    /** @type {HTMLElement | null} */
    box.closest(".row")
  );
  if (!row) {
    box.addEventListener("change", onToggle);
    return;
  }
  let flip = () => {
    box.checked = !box.checked, onToggle();
  };
  row.addEventListener("click", (ev) => {
    ev.preventDefault(), flip();
  }), row.addEventListener("keydown", (ev) => {
    ev.key !== " " && ev.key !== "Enter" || (ev.preventDefault(), flip());
  });
}
function flushTouchedToggles(state) {
  let payload = {};
  state.enabledTouched && (payload[ENABLED_FLAG] = state.enabled), state.blurTouched && (payload[BLUR_AI_FLAG] = state.blur), state.mockTouched && (payload[DEV_MOCK_FLAG] = state.mock), Object.keys(payload).length !== 0 && (chrome.storage.local.set(payload), state.enabledTouched && chrome.runtime.sendMessage({ type: MSG.ENABLED_SETTING, target: TARGET.SW, enabled: state.enabled }).catch(() => {
  }), state.blurTouched && chrome.runtime.sendMessage({ type: MSG.BLUR_SETTING, target: TARGET.SW, enabled: state.blur }).catch(() => {
  }));
}
function syncEnabledUi(on) {
  $("enabled").checked = on;
  let row = $("enabled-row");
  row && row.setAttribute("aria-checked", on ? "true" : "false");
  let live = $("live"), label = $("live-label");
  live.classList.toggle("off", !on), label.textContent = on ? "LIVE" : "OFF";
}
function syncBlurHint(on) {
  let row = $("blur-row");
  row && row.setAttribute("aria-checked", on ? "true" : "false");
  let hint = $("blur-hint");
  hint && (hint.textContent = on ? "On. AI-scored images are covered; click one to reveal it." : "Off. Turn on to hide AI-scored images; click one to reveal it.");
}
async function pushEnabledSetting(on) {
  await pushFlag(ENABLED_FLAG, MSG.ENABLED_SETTING, on);
}
async function pushBlurSetting(on) {
  syncBlurHint(on), await pushFlag(BLUR_AI_FLAG, MSG.BLUR_SETTING, on);
}
function pushFlag(flag, type, on) {
  let persist = chrome.storage.local.set({ [flag]: on }), notifySw = chrome.runtime.sendMessage({ type, target: TARGET.SW, enabled: on }).catch(() => {
  }), notifyTab = persist.then(
    () => chrome.tabs.query({ active: !0, currentWindow: !0 }).then(
      (tabs) => Promise.all(
        tabs.map(
          (tab) => tab.id == null ? Promise.resolve() : chrome.tabs.sendMessage(tab.id, { type, enabled: on }).catch(() => {
          })
        )
      )
    )
  ).catch(() => {
  });
  return Promise.all([persist, notifySw, notifyTab]);
}
initToggles();
$("model-retry").addEventListener("click", () => {
  retryModelDownload();
});
refresh();
setInterval(refresh, 1e3);
