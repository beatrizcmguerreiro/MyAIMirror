(function initialiseSentinelConversationDeletionSync() {
  "use strict";

  if (window.__sentinelConversationDeletionSyncLoaded) return;
  window.__sentinelConversationDeletionSyncLoaded = true;

  const ANALYSES_KEY = "conversationAnalysesV1";
  const BEHAVIOURAL_KEY = "sentinelBehaviouralMetricsV1";
  const REFLECTIONS_KEY = "sentinelPostResponseReflectionsV1";
  const THEMES_KEY = "sentinelThemeMetricsV1";
  let pendingConversationKey = null;
  const conversationKeysByTitle = new Map();

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

  function conversationKeyFromLink(link) {
    try {
      const url = new URL(link.href, location.origin);
      const match = url.pathname.match(/^\/c\/([^/]+)/);
      return match ? `/c/${match[1]}` : null;
    } catch {
      return null;
    }
  }

  function findConversationLink(target) {
    if (!(target instanceof Element)) return null;
    if (target.closest('[role="dialog"], [aria-modal="true"]')) return null;
    const directLink = target.closest('a[href*="/c/"]');
    if (directLink) return directLink;

    let current = target;
    for (let depth = 0; current && depth < 7; depth += 1) {
      if (current === document.body || current === document.documentElement) break;
      const rect = current.getBoundingClientRect();
      const isInSidebar = rect.left >= 0 && rect.right <= Math.min(520, window.innerWidth * 0.4);
      if (!isInSidebar) break;
      const link = current.querySelector?.('a[href*="/c/"]');
      if (link) return link;
      current = current.parentElement;
    }
    return null;
  }

  function currentConversationKey() {
    const match = location.pathname.match(/^\/c\/([^/]+)/);
    return match ? `/c/${match[1]}` : null;
  }

  function normaliseText(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function rememberVisibleConversationLinks() {
    Array.from(document.querySelectorAll('a[href*="/c/"]')).forEach(link => {
      const key = conversationKeyFromLink(link);
      const title = normaliseText(link.textContent);
      if (!key || !title) return;
      const keys = conversationKeysByTitle.get(title) || new Set();
      keys.add(key);
      conversationKeysByTitle.set(title, keys);
    });
  }

  function findDeleteDialogFromButton(button) {
    const semanticDialog = button.closest('[role="dialog"], [aria-modal="true"]');
    if (semanticDialog && /delete chat/i.test(semanticDialog.textContent || "")) {
      return semanticDialog;
    }

    let current = button.parentElement;
    for (let depth = 0; current && depth < 10; depth += 1) {
      const text = current.textContent || "";
      if (/delete chat/i.test(text) && /this will delete/i.test(text)) return current;
      current = current.parentElement;
    }
    return null;
  }

  function conversationKeyFromDialog(dialog) {
    if (!dialog) return null;
    const emphasizedTitle = Array.from(dialog.querySelectorAll("strong, b"))
      .map(element => String(element.textContent || "").trim())
      .find(Boolean);
    const dialogText = String(dialog.textContent || "");
    const sentenceMatch = dialogText.match(/this will delete\s+(.+?)(?:\.|visit settings|$)/i);
    const title = emphasizedTitle || sentenceMatch?.[1]?.trim();
    if (!title) return null;

    const expected = normaliseText(title);
    rememberVisibleConversationLinks();
    const matches = Array.from(document.querySelectorAll('a[href*="/c/"]'))
      .filter(link => {
        if (normaliseText(link.textContent) === expected) return true;
        return Array.from(link.querySelectorAll("span, div"))
          .some(element => normaliseText(element.textContent) === expected);
      });
    if (matches.length === 1) return conversationKeyFromLink(matches[0]);

    // ChatGPT can replace or remove the sidebar row while opening the
    // confirmation dialog. Keep a small, in-memory title-to-route index so
    // the confirmed deletion can still be tied to the correct local record.
    const rememberedKeys = Array.from(conversationKeysByTitle.get(expected) || []);
    return rememberedKeys.length === 1 ? rememberedKeys[0] : null;
  }

  async function sha256Fingerprint(value) {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map(byte => byte.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 32);
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

  function subtractTotals(totalValue, removedValue) {
    const totals = normaliseTotals(totalValue);
    const removed = normaliseTotals(removedValue);
    Object.keys(totals).forEach(key => {
      totals[key] = Math.max(0, totals[key] - removed[key]);
    });
    return totals;
  }

  async function removeConversationData(conversationKey) {
    if (!conversationKey) return;
    const conversationId = await sha256Fingerprint(
      `${location.hostname}|${conversationKey}`
    );
    const stored = await storageGet([
      ANALYSES_KEY,
      BEHAVIOURAL_KEY,
      REFLECTIONS_KEY,
      THEMES_KEY
    ]);
    const analyses = { ...(stored[ANALYSES_KEY] || {}) };
    const behavioural = stored[BEHAVIOURAL_KEY];
    const reflections = Array.isArray(stored[REFLECTIONS_KEY])
      ? stored[REFLECTIONS_KEY]
      : [];
    const remainingReflections = reflections.filter(record =>
      record?.conversationId !== conversationId
    );
    const themes = { ...(stored[THEMES_KEY] || {}) };
    const themeConversations = { ...(themes.conversations || {}) };
    let changed = false;

    if (Object.hasOwn(analyses, conversationId)) {
      delete analyses[conversationId];
      changed = true;
    }

    let nextBehavioural = behavioural;
    const conversation = behavioural?.conversations?.[conversationId];
    if (conversation) {
      const conversations = { ...behavioural.conversations };
      delete conversations[conversationId];
      const daily = { ...(behavioural.daily || {}) };
      Object.entries(conversation.daily || {}).forEach(([date, values]) => {
        daily[date] = subtractTotals(daily[date], values);
      });
      nextBehavioural = {
        ...behavioural,
        totals: subtractTotals(behavioural.totals, conversation.totals || conversation),
        daily,
        conversations,
        updatedAt: new Date().toISOString()
      };
      changed = true;
    }

    if (remainingReflections.length !== reflections.length) changed = true;

    if (Object.hasOwn(themeConversations, conversationId)) {
      delete themeConversations[conversationId];
      themes.conversations = themeConversations;
      themes.updatedAt = new Date().toISOString();
      changed = true;
    }

    if (!changed) return;
    await storageSet({
      [ANALYSES_KEY]: analyses,
      ...(nextBehavioural ? { [BEHAVIOURAL_KEY]: nextBehavioural } : {}),
      [REFLECTIONS_KEY]: remainingReflections,
      [THEMES_KEY]: themes
    });
    console.info("Sentinel removed stored metrics for deleted conversation.");
    window.dispatchEvent(new CustomEvent("sentinel:conversation-data-removed", {
      detail: { conversationKey }
    }));
  }

  function isDeleteConfirmation(button) {
    const label = String(button.textContent || "").trim().toLowerCase();
    if (label !== "delete") return false;
    return Boolean(findDeleteDialogFromButton(button));
  }

  document.addEventListener("pointerdown", event => {
    rememberVisibleConversationLinks();
    const link = findConversationLink(event.target);
    const key = link ? conversationKeyFromLink(link) : null;
    if (key) pendingConversationKey = key;
  }, true);

  // Capture the conversation identity as soon as the confirmation dialog is
  // mounted. This avoids depending on the sidebar row still existing when the
  // user presses the final Delete button.
  const dialogObserver = new MutationObserver(mutations => {
    rememberVisibleConversationLinks();
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) continue;
        const candidates = [node, ...node.querySelectorAll('[role="dialog"], [aria-modal="true"]')];
        for (const candidate of candidates) {
          if (!/delete chat/i.test(candidate.textContent || "")) continue;
          const key = conversationKeyFromDialog(candidate);
          if (key) pendingConversationKey = key;
        }
      }
    }
  });
  dialogObserver.observe(document.documentElement, { childList: true, subtree: true });

  document.addEventListener("click", event => {
    const button = event.target instanceof Element
      ? event.target.closest('button, [role="button"]')
      : null;
    if (!button) return;
    const isDeleteButton = normaliseText(button.textContent) === "delete";
    if (!isDeleteButton) return;
    const dialog = findDeleteDialogFromButton(button);
    if (!dialog) return;
    // Prefer the title in the live confirmation dialog. The pending sidebar
    // route remains a fallback for ChatGPT variants that omit the title.
    const conversationKey = conversationKeyFromDialog(dialog) ||
      pendingConversationKey ||
      currentConversationKey();
    if (!conversationKey || !isDeleteConfirmation(button)) return;
    pendingConversationKey = null;
    // Let ChatGPT complete its own deletion first; this only removes Sentinel's
    // corresponding local aggregates.
    setTimeout(() => {
      removeConversationData(conversationKey);
    }, 300);
  }, true);
})();
