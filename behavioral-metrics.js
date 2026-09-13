(function initialiseSentinelBehaviouralMetrics() {
  "use strict";

  if (window.__sentinelBehaviouralMetricsLoaded) return;
  window.__sentinelBehaviouralMetricsLoaded = true;

  const STORAGE_KEY = "sentinelBehaviouralMetricsV1";
  const SESSION_KEY = "tms_behaviouralMetrics";
  const SESSION_VERSION_KEY = "tms_behaviouralMetricsVersion";
  const METRICS_VERSION = 5;
  const STUDY_START_DATE = "2026-09-14";
  const STUDY_END_DATE = "2026-09-19";
  const EDIT_EPISODE_GAP_MS = 1200;
  const COMPOSER_SELECTORS = [
    "#prompt-textarea",
    '[data-testid="composer-text-input"]',
    'textarea[placeholder*="Ask"]',
    'textarea[placeholder*="Message"]',
    '[contenteditable="true"][role="textbox"]',
    'form [contenteditable="true"]',
    'div.ProseMirror[contenteditable="true"]'
  ];

  let draft = null;
  let persistenceQueue = Promise.resolve();
  let scanTimer = null;
  const knownUserMessages = new WeakSet();

  function isDisabled() {
    const today = localDateKey(new Date());
    return document.documentElement.hasAttribute("data-sentinel-temporary-chat") ||
      today < STUDY_START_DATE ||
      today > STUDY_END_DATE;
  }

  function hasExtensionContext() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  function storageGet(keys) {
    return new Promise(resolve => {
      try {
        if (!hasExtensionContext()) return resolve({});
        chrome.storage.local.get(keys, result => {
          if (chrome.runtime.lastError) return resolve({});
          resolve(result || {});
        });
      } catch {
        resolve({});
      }
    });
  }

  function storageSet(values) {
    return new Promise(resolve => {
      try {
        if (!hasExtensionContext()) return resolve(false);
        chrome.storage.local.set(values, () => {
          if (chrome.runtime.lastError) return resolve(false);
          resolve(true);
        });
      } catch {
        resolve(false);
      }
    });
  }

  function emptyTotals() {
    return {
      prompts: 0,
      promptsWithPaste: 0,
      pasteEvents: 0,
      promptsWithEdits: 0,
      editActions: 0,
      revisionEpisodes: 0
    };
  }

  function normaliseTotals(value) {
    const totals = emptyTotals();
    Object.keys(totals).forEach(key => {
      const number = Number(value?.[key]);
      totals[key] = Number.isFinite(number) && number >= 0 ? number : 0;
    });
    return totals;
  }

  function addRecord(totals, record) {
    totals.prompts += 1;
    totals.promptsWithPaste += record.pasteEvents > 0 ? 1 : 0;
    totals.pasteEvents += record.pasteEvents;
    totals.promptsWithEdits += record.editActions > 0 ? 1 : 0;
    totals.editActions += record.editActions;
    totals.revisionEpisodes += record.revisionEpisodes;
    return totals;
  }

  function addTotals(targetValue, sourceValue) {
    const target = normaliseTotals(targetValue);
    const source = normaliseTotals(sourceValue);
    Object.keys(target).forEach(key => {
      target[key] += source[key];
    });
    return target;
  }

  function localDateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  async function sha256Fingerprint(value) {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map(byte => byte.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 32);
  }

  function getCanonicalConversationKey() {
    const path = location.pathname.replace(/\/+$/, "");
    const match = path.match(/^\/c\/([^/]+)/);
    return match ? `/c/${match[1]}` : null;
  }

  async function getConversationStorageId() {
    const conversationKey = getCanonicalConversationKey();
    return conversationKey
      ? sha256Fingerprint(`${location.hostname}|${conversationKey}`)
      : null;
  }

  async function waitForConversationStorageId(timeoutMs = 4000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const conversationId = await getConversationStorageId();
      if (conversationId) return conversationId;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return null;
  }

  function normaliseConversationMetrics(value) {
    const daily = Object.fromEntries(
      Object.entries(value?.daily || {}).map(([date, totals]) => [date, normaliseTotals(totals)])
    );
    return {
      totals: normaliseTotals(value?.totals || value),
      daily
    };
  }

  function round(value, digits = 1) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
  }

  function summarise(totals) {
    const prompts = totals.prompts || 0;
    return {
      pasteEvents: totals.pasteEvents,
      editActions: totals.editActions,
      revisionEpisodes: totals.revisionEpisodes,
      copyPasteRate: prompts ? round((totals.promptsWithPaste / prompts) * 100) : 0,
      editingRate: prompts ? round((totals.promptsWithEdits / prompts) * 100) : 0
    };
  }

  function loadSessionTotals() {
    try {
      if (sessionStorage.getItem(SESSION_VERSION_KEY) !== String(METRICS_VERSION)) {
        sessionStorage.removeItem(SESSION_KEY);
        sessionStorage.setItem(SESSION_VERSION_KEY, String(METRICS_VERSION));
      }
      return normaliseTotals(JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null"));
    } catch {
      return emptyTotals();
    }
  }

  async function removeStoredTimingMetrics() {
    const sessionTotals = loadSessionTotals();
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(sessionTotals));

    const stored = await storageGet([STORAGE_KEY]);
    const state = stored[STORAGE_KEY];
    if (!state) return;

    const daily = Object.fromEntries(
      Object.entries(state.daily || {}).map(([date, values]) => [date, normaliseTotals(values)])
    );
    const conversations = Object.fromEntries(
      Object.entries(state.conversations || {}).map(([id, values]) => [
        id,
        normaliseConversationMetrics(values)
      ])
    );
    // Versions before v5 also contained a legacy global subtotal that could
    // not be linked to individual chats. Rebuild the aggregate from the
    // attributable conversation records so deleted test chats cannot remain
    // permanently represented in the New Chat visualisations.
    const isLegacyAggregate = Number(state.version || 0) < METRICS_VERSION;
    const attributableTotals = Object.values(conversations).reduce(
      (totals, conversation) => addTotals(totals, conversation.totals),
      emptyTotals()
    );
    const attributableDaily = {};
    Object.values(conversations).forEach(conversation => {
      Object.entries(conversation.daily || {}).forEach(([date, totals]) => {
        attributableDaily[date] = addTotals(attributableDaily[date], totals);
      });
    });
    await storageSet({
      [STORAGE_KEY]: {
        version: METRICS_VERSION,
        totals: isLegacyAggregate ? attributableTotals : normaliseTotals(state.totals),
        daily: isLegacyAggregate ? attributableDaily : daily,
        conversations,
        updatedAt: state.updatedAt || new Date().toISOString()
      }
    });
  }

  function persistRecord(record) {
    const sessionTotals = addRecord(loadSessionTotals(), record);
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(sessionTotals));

    persistenceQueue = persistenceQueue.then(async () => {
      const conversationId = await waitForConversationStorageId();
      const capturedAt = new Date(record?.recordedAt || Date.now());
      const today = localDateKey(capturedAt);
      const stored = await storageGet([STORAGE_KEY]);
      const state = stored[STORAGE_KEY] || {};
      const totals = addRecord(normaliseTotals(state.totals), record);
      const daily = Object.fromEntries(
        Object.entries(state.daily || {}).map(([date, values]) => [date, normaliseTotals(values)])
      );
      daily[today] = addRecord(normaliseTotals(daily[today]), record);
      const conversations = Object.fromEntries(
        Object.entries(state.conversations || {}).map(([id, values]) => [
          id,
          normaliseConversationMetrics(values)
        ])
      );
      if (conversationId) {
        const conversation = normaliseConversationMetrics(conversations[conversationId]);
        conversation.totals = addRecord(conversation.totals, record);
        conversation.daily[today] = addRecord(
          normaliseTotals(conversation.daily[today]),
          record
        );
        conversations[conversationId] = conversation;
      }

      await storageSet({
        [STORAGE_KEY]: {
          version: METRICS_VERSION,
          totals,
          daily,
          conversations,
          updatedAt: new Date().toISOString()
        }
      });

      const currentPageSession = summarise(sessionTotals);
      const allTime = summarise(totals);
      const metricRows = [
        {
          metric: "pasteEvents",
          currentPrompt: record.pasteEvents,
          currentPageSession: currentPageSession.pasteEvents,
          allTime: allTime.pasteEvents
        },
        {
          metric: "editActions",
          currentPrompt: record.editActions,
          currentPageSession: currentPageSession.editActions,
          allTime: allTime.editActions
        },
        {
          metric: "revisionEpisodes",
          currentPrompt: record.revisionEpisodes,
          currentPageSession: currentPageSession.revisionEpisodes,
          allTime: allTime.revisionEpisodes
        },
        {
          metric: "copyPasteRate",
          currentPrompt: "—",
          currentPageSession: currentPageSession.copyPasteRate,
          allTime: allTime.copyPasteRate
        },
        {
          metric: "editingRate",
          currentPrompt: "—",
          currentPageSession: currentPageSession.editingRate,
          allTime: allTime.editingRate
        }
      ];

      console.group("Sentinel behavioural metrics:");
      console.table(metricRows);
      console.groupEnd();
    }).catch(error => {
      console.error("Sentinel could not persist behavioural metrics:", error);
    });
  }

  function findComposerFromTarget(target) {
    if (!(target instanceof Element)) return null;
    for (const selector of COMPOSER_SELECTORS) {
      if (target.matches(selector)) return target;
      const composer = target.closest(selector);
      if (composer) return composer;
    }
    return null;
  }

  function findComposerFromEvent(event) {
    const direct = findComposerFromTarget(event?.target);
    if (direct) return direct;

    const path = typeof event?.composedPath === "function" ? event.composedPath() : [];
    for (const item of path) {
      const composer = findComposerFromTarget(item);
      if (composer) return composer;
    }

    const active = findComposerFromTarget(document.activeElement);
    if (active) return active;

    const selectionNode = window.getSelection()?.anchorNode;
    const selectionElement = selectionNode instanceof Element
      ? selectionNode
      : selectionNode?.parentElement;
    const selectedComposer = findComposerFromTarget(selectionElement);
    if (selectedComposer) return selectedComposer;

    return draft?.composer?.isConnected ? draft.composer : null;
  }

  function composerHasText(composer) {
    if (!composer) return false;
    const text = composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement
      ? composer.value
      : composer.innerText || composer.textContent;
    return Boolean(String(text || "").trim());
  }

  function ensureDraft(composer) {
    if (draft?.awaitingSubmission && !draft.finalised) return draft;
    if (draft?.composer === composer && !draft.finalised) return draft;
    draft = {
      composer,
      hasInput: false,
      editSequenceActive: false,
      lastEditAt: null,
      lastPasteAt: null,
      awaitingSubmission: false,
      finalised: false,
      pasteEvents: 0,
      editActions: 0,
      revisionEpisodes: 0
    };
    return draft;
  }

  function noteInput(composer, inputType = "") {
    if (isDisabled()) return;
    const current = ensureDraft(composer);
    if (current.awaitingSubmission || current.finalised) return;
    current.hasInput = true;

    // Deletion, cut, undo, and redo are already counted by noteEdit. Ordinary
    // typing or another insertion ends the current consecutive edit sequence.
    const continuesEditSequence = /^(delete|historyUndo|historyRedo)/i.test(inputType);
    if (!continuesEditSequence) current.editSequenceActive = false;
  }

  function noteEdit(composer) {
    if (isDisabled()) return;
    const current = ensureDraft(composer);
    if (current.awaitingSubmission || current.finalised) return;

    const now = performance.now();
    current.hasInput = true;
    current.editActions += 1;
    if (
      !current.editSequenceActive ||
      current.lastEditAt === null ||
      now - current.lastEditAt >= EDIT_EPISODE_GAP_MS
    ) {
      current.revisionEpisodes += 1;
    }
    current.editSequenceActive = true;
    current.lastEditAt = now;
  }

  function notePaste(composer) {
    if (isDisabled() || !composer) return;
    const current = ensureDraft(composer);
    if (current.awaitingSubmission || current.finalised) return;

    const now = performance.now();
    current.hasInput = true;
    current.editSequenceActive = false;
    // Browsers can emit both paste and beforeinput(insertFromPaste) for one
    // user action. Treat that pair as one paste event.
    if (current.lastPasteAt === null || now - current.lastPasteAt >= 300) {
      current.pasteEvents += 1;
    }
    current.lastPasteAt = now;
  }

  function composerHasSelection(composer) {
    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      return Number.isInteger(composer.selectionStart)
        && Number.isInteger(composer.selectionEnd)
        && composer.selectionStart !== composer.selectionEnd;
    }

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return false;
    return composer.contains(selection.anchorNode) && composer.contains(selection.focusNode);
  }

  function markSubmission(composer) {
    if (isDisabled()) return;
    const current = ensureDraft(composer);
    const hasDraftContent = composerHasText(composer)
      || current.hasInput
      || current.pasteEvents > 0;
    if (current.awaitingSubmission || current.finalised || !hasDraftContent) return;
    current.awaitingSubmission = true;
  }

  function finaliseSubmittedDraft() {
    if (!draft?.awaitingSubmission || draft.finalised || isDisabled()) return;
    draft.finalised = true;
    const record = {
      recordedAt: new Date().toISOString(),
      pasteEvents: draft.pasteEvents,
      editActions: draft.editActions,
      revisionEpisodes: draft.revisionEpisodes
    };
    persistRecord(record);
    draft = null;
  }

  function isSendButton(element) {
    if (!(element instanceof Element)) return false;
    const button = element.closest('button, [role="button"]');
    if (!button) return false;
    const label = [
      button.getAttribute("aria-label"),
      button.getAttribute("data-testid"),
      button.getAttribute("title")
    ].filter(Boolean).join(" ");
    return /send|submit/i.test(label);
  }

  function scanForSubmittedMessages() {
    document.querySelectorAll('[data-message-author-role="user"]').forEach(message => {
      if (knownUserMessages.has(message)) return;
      knownUserMessages.add(message);
      if (draft?.awaitingSubmission) finaliseSubmittedDraft();
    });
  }

  function scheduleMessageScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanForSubmittedMessages, 80);
  }

  document.addEventListener("focusin", event => {
    if (isDisabled()) return;
    const composer = findComposerFromTarget(event.target);
    if (composer) ensureDraft(composer);
  }, true);

  document.addEventListener("paste", event => {
    notePaste(findComposerFromEvent(event));
  }, true);

  document.addEventListener("cut", event => {
    const composer = findComposerFromEvent(event);
    if (composer) noteEdit(composer);
  }, true);

  document.addEventListener("beforeinput", event => {
    const composer = findComposerFromEvent(event);
    if (!composer) return;
    const inputType = event.inputType || "";
    if (/^insertFromPaste/i.test(inputType)) {
      notePaste(composer);
      return;
    }
    const replacesSelection = /^insertText$/i.test(inputType)
      && composerHasSelection(composer);
    noteInput(composer, inputType);
    if (replacesSelection) noteEdit(composer);
  }, true);

  document.addEventListener("keydown", event => {
    const composer = findComposerFromTarget(event.target);
    if (!composer || event.isComposing) return;

    if (event.key === "Enter" && !event.shiftKey) {
      markSubmission(composer);
      return;
    }

    const key = String(event.key || "").toLowerCase();
    const isDeletion = key === "backspace" || key === "delete";
    const isUndoRedo = (event.ctrlKey || event.metaKey) && (key === "z" || key === "y");
    if (isDeletion || isUndoRedo) noteEdit(composer);
  }, true);

  document.addEventListener("click", event => {
    if (!isSendButton(event.target)) return;
    const form = event.target.closest("form");
    const composer = form
      ? COMPOSER_SELECTORS.map(selector => form.querySelector(selector)).find(Boolean)
      : draft?.composer;
    if (composer) markSubmission(composer);
  }, true);

  document.addEventListener("submit", event => {
    const form = event.target instanceof HTMLFormElement ? event.target : null;
    if (!form) return;
    const composer = COMPOSER_SELECTORS
      .map(selector => form.querySelector(selector))
      .find(Boolean);
    if (composer) markSubmission(composer);
  }, true);

  window.addEventListener("sentinel:temporary-chat-change", event => {
    if (event.detail?.active) draft = null;
  });

  document.querySelectorAll('[data-message-author-role="user"]').forEach(message => {
    knownUserMessages.add(message);
  });

  persistenceQueue = removeStoredTimingMetrics().catch(error => {
    console.error("Sentinel could not remove old timing metrics:", error);
  });

  const observer = new MutationObserver(scheduleMessageScan);
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
