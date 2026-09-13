(function initialiseSentinelThemeMetrics() {
  "use strict";

  if (window.__sentinelThemeMetricsLoaded) return;
  window.__sentinelThemeMetricsLoaded = true;

  const STORAGE_KEY = "sentinelThemeMetricsV1";
  const STORAGE_VERSION = 1;
  const TEMPORARY_CHAT_ATTRIBUTE = "data-sentinel-temporary-chat";
  const STOP_WORDS = new Set(`
    about after again against also and any are because been before being between both but can
    could did does doing down each few for from further had has have having here how into its
    itself just may might more most must not now off once only other our ours out over own please
    same should some such than that the their theirs them themselves then there these they this
    those through too under until very was were what when where which while who whom why will with
    would you your yours yourself yourselves want need help tell give make create write explain show
    use using used like okay yes yeah hello thanks thank something anything thing things
    aos com como da das de del do dos e em entre era essa esse esta este eu isso isto mais mas me
    meu minha na nas nao no nos o os ou para pela pelo por porque qual que se sem ser seu sua tem
    uma um voce vocês quero preciso ajuda diga fazer criar escrever explicar mostrar
  `.trim().split(/\s+/));

  let scanTimer = null;
  let persistenceQueue = Promise.resolve();
  let lastSignature = "";

  function hasExtensionContext() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  function storageGet(keys) {
    return new Promise(resolve => {
      if (!hasExtensionContext()) return resolve({});
      try {
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
      if (!hasExtensionContext()) return resolve(false);
      try {
        chrome.storage.local.set(values, () => {
          if (chrome.runtime.lastError) return resolve(false);
          resolve(true);
        });
      } catch {
        resolve(false);
      }
    });
  }

  async function sha256Fingerprint(value) {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map(byte => byte.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 32);
  }

  function conversationKey() {
    const match = location.pathname.replace(/\/+$/, "").match(/^\/c\/([^/]+)/);
    return match ? `/c/${match[1]}` : null;
  }

  function normalisePrompt(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function tokenise(text) {
    return (text.toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || [])
      .map(token => token.replace(/^['’-]+|['’-]+$/g, ""))
      .filter(Boolean);
  }

  function isTopicWord(token) {
    return token.length >= 3 &&
      !STOP_WORDS.has(token) &&
      !/^\d+$/.test(token) &&
      !/^https?$/.test(token) &&
      !/^www\b/.test(token);
  }

  function extractThemes(text) {
    const tokens = tokenise(text);
    const unigramCounts = new Map();
    const phraseCounts = new Map();

    tokens.forEach(token => {
      if (!isTopicWord(token)) return;
      unigramCounts.set(token, (unigramCounts.get(token) || 0) + 1);
    });

    for (let index = 0; index < tokens.length - 1; index += 1) {
      const first = tokens[index];
      const second = tokens[index + 1];
      if (!isTopicWord(first) || !isTopicWord(second) || first === second) continue;
      const phrase = `${first} ${second}`;
      phraseCounts.set(phrase, (phraseCounts.get(phrase) || 0) + 1);
    }

    const phrases = Array.from(phraseCounts.entries())
      .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
      .slice(0, 3)
      .map(([term]) => term);
    const coveredWords = new Set(phrases.flatMap(phrase => phrase.split(" ")));
    const words = Array.from(unigramCounts.entries())
      .filter(([term]) => !coveredWords.has(term))
      .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
      .slice(0, 7)
      .map(([term]) => term);

    return [...phrases, ...words].slice(0, 8);
  }

  async function collectVisiblePrompts() {
    if (document.documentElement.hasAttribute(TEMPORARY_CHAT_ATTRIBUTE)) return;
    const key = conversationKey();
    if (!key) return;

    const prompts = Array.from(
      document.querySelectorAll('[data-message-author-role="user"]')
    ).map(message => normalisePrompt(message.innerText || message.textContent))
      .filter(Boolean);
    if (!prompts.length) return;

    const fingerprints = await Promise.all(prompts.map(prompt => sha256Fingerprint(prompt)));
    const signature = `${key}|${fingerprints.join("|")}`;
    if (signature === lastSignature) return;
    lastSignature = signature;

    const conversationId = await sha256Fingerprint(`${location.hostname}|${key}`);
    const records = Object.fromEntries(prompts.map((prompt, index) => [
      fingerprints[index],
      extractThemes(prompt)
    ]).filter(([, themes]) => themes.length));
    if (!Object.keys(records).length) return;

    persistenceQueue = persistenceQueue.then(async () => {
      const stored = await storageGet([STORAGE_KEY]);
      const state = stored[STORAGE_KEY] || {};
      const conversations = { ...(state.conversations || {}) };
      const existing = conversations[conversationId]?.prompts || {};
      const merged = { ...existing, ...records };
      if (JSON.stringify(existing) === JSON.stringify(merged)) return;

      conversations[conversationId] = { prompts: merged };
      await storageSet({
        [STORAGE_KEY]: {
          version: STORAGE_VERSION,
          conversations,
          updatedAt: new Date().toISOString()
        }
      });
    }).catch(error => {
      console.warn("My AI Mirror could not update local themes:", error);
    });
  }

  function scheduleScan(delay = 260) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(collectVisiblePrompts, delay);
  }

  const observer = new MutationObserver(() => scheduleScan());
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("popstate", () => {
    lastSignature = "";
    scheduleScan(120);
  });
  window.addEventListener("sentinel:temporary-chat-change", () => scheduleScan(0));
  const routeInterval = setInterval(() => {
    if (!hasExtensionContext()) {
      clearInterval(routeInterval);
      observer.disconnect();
      return;
    }
    const prefix = `${conversationKey() || ""}|`;
    if (!lastSignature.startsWith(prefix)) {
      lastSignature = "";
      scheduleScan(0);
    }
  }, 700);

  scheduleScan(500);
})();
