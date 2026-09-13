(function initialiseSentimentChatColors() {
  "use strict";

  const STORAGE_KEY = "conversationAnalysesV1";
  const PREFERENCES_KEY = "visualizationPreferences";
  const ATTRIBUTE = "data-sentinel-sentiment-tone";
  const STYLE_ID = "sentinel-sentiment-chat-colors";
  const STRONGLY_POSITIVE_THRESHOLD = 0.65;
  const POSITIVE_THRESHOLD = 0.15;
  const NEGATIVE_THRESHOLD = -0.40;
  const STRONGLY_NEGATIVE_THRESHOLD = -0.65;

  let refreshTimer = null;
  let refreshSequence = 0;
  let observer = null;
  let reconciliationInterval = null;
  const hydrationRefreshTimers = new Set();

  function hasExtensionContext() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      [${ATTRIBUTE}] {
        border-left: 2px solid var(--sentinel-chat-tone-border) !important;
        background: var(--sentinel-chat-tone-background) !important;
        box-shadow: none !important;
        transition: background-color 160ms ease, border-color 160ms ease !important;
      }
    `;
    document.head.appendChild(style);
  }

  function interpolateColor(stops, value) {
    const clamped = Math.max(stops[0][0], Math.min(stops[stops.length - 1][0], value));
    for (let index = 0; index < stops.length - 1; index += 1) {
      const [startValue, startColor] = stops[index];
      const [endValue, endColor] = stops[index + 1];
      if (clamped > endValue) continue;

      const progress = (clamped - startValue) / (endValue - startValue);
      return startColor.map((channel, channelIndex) =>
        Math.round(channel + (endColor[channelIndex] - channel) * progress)
      );
    }
    return stops[stops.length - 1][1];
  }

  function getScoreColor(score) {
    if (score >= -POSITIVE_THRESHOLD && score <= POSITIVE_THRESHOLD) {
      return [142, 142, 147];
    }

    if (score > POSITIVE_THRESHOLD) {
      return interpolateColor([
        [0.15, [187, 247, 208]],
        [0.40, [134, 239, 172]],
        [0.70, [34, 197, 94]],
        [1.00, [21, 128, 61]]
      ], score);
    }

    return interpolateColor([
      [-1.00, [153, 27, 27]],
      [-0.80, [239, 68, 68]],
      [-0.60, [249, 115, 22]],
      [-0.40, [245, 158, 11]],
      [-0.15, [250, 204, 21]]
    ], score);
  }

  function getConversationAverageScore(analyses) {
    const scores = (Array.isArray(analyses) ? analyses : [])
      .map(analysis => analysis?.sentiment)
      .filter(sentiment =>
        sentiment &&
        ["positive", "neutral", "negative"].includes(sentiment.label)
      )
      .map(sentiment => {
        const score = Number(sentiment.score || 0);
        if (sentiment.label === "positive") return score;
        if (sentiment.label === "negative") return -score;
        return 0;
      });
    if (!scores.length) return null;
    return scores.reduce((sum, score) => sum + score, 0) / scores.length;
  }

  function classifyConversationTone(analyses) {
    const averageScore = getConversationAverageScore(analyses);
    return classifyAverageScore(averageScore);
  }

  function classifyAverageScore(averageScore) {
    if (averageScore === null) return null;
    if (averageScore >= STRONGLY_POSITIVE_THRESHOLD) return "strongly-positive";
    if (averageScore > POSITIVE_THRESHOLD) return "positive";
    if (averageScore >= -POSITIVE_THRESHOLD) return "neutral";
    if (averageScore > NEGATIVE_THRESHOLD) return "slightly-negative";
    if (averageScore > STRONGLY_NEGATIVE_THRESHOLD) return "negative";
    return "strongly-negative";
  }

  function getCurrentSessionAverageScore() {
    try {
      const session = JSON.parse(
        sessionStorage.getItem("tms_sessionSentiment") || "null"
      );
      const messages = Number(session?.messages || 0);
      if (!messages) return null;
      return Number(session.scoreSum || 0) / messages;
    } catch {
      return null;
    }
  }

  function getCurrentConversationKey() {
    const path = location.pathname.replace(/\/+$/, "");
    const match = path.match(/^\/c\/([^/]+)/);
    return match ? `/c/${match[1]}` : null;
  }

  function getConversationKeyFromLink(link) {
    try {
      const url = new URL(link.href, location.origin);
      if (url.origin !== location.origin) return null;
      const match = url.pathname.match(/^\/c\/([^/]+)/);
      return match ? `/c/${match[1]}` : null;
    } catch {
      return null;
    }
  }

  function isChatHistoryLink(link) {
    if (
      !(link instanceof HTMLAnchorElement) ||
      link.closest('[role="dialog"]') ||
      !getConversationKeyFromLink(link)
    ) return false;

    // ChatGPT changes the sidebar wrapper frequently and no longer always uses
    // a <nav>. Prefer semantic sidebar containers, with position as a fallback
    // for virtualised history rows that are mounted directly in the left rail.
    if (link.closest('nav, aside, [data-testid*="sidebar"], [class*="sidebar"]')) {
      return true;
    }

    const rect = link.getBoundingClientRect();
    const leftRailLimit = Math.min(520, window.innerWidth * 0.4);
    return rect.width > 80 && rect.left >= 0 && rect.right <= leftRailLimit;
  }

  function getChatHistoryVisualElement(link) {
    // The conversation anchor is ChatGPT's rounded history item. Colouring
    // one of its outer wrappers creates a square block behind the row.
    return link;
  }

  function clearChatColor(element) {
    element.removeAttribute(ATTRIBUTE);
    element.removeAttribute("data-sentinel-sentiment-score");
    element.style.removeProperty("--sentinel-chat-tone-background");
    element.style.removeProperty("--sentinel-chat-tone-border");
  }

  function isSentinelTemporarilyDisabled() {
    return document.documentElement.hasAttribute("data-sentinel-temporary-chat");
  }

  async function sha256Fingerprint(value) {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map(byte => byte.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 32);
  }

  function getLocalStorage(keys) {
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

  async function refreshChatColors() {
    const sequence = ++refreshSequence;
    const allCandidateLinks = Array.from(document.querySelectorAll(
      `a[href*="/c/"]`
    ));
    const previouslyColouredElements = Array.from(
      document.querySelectorAll(`[${ATTRIBUTE}]`)
    );
    if (isSentinelTemporarilyDisabled()) {
      previouslyColouredElements.forEach(clearChatColor);
      return;
    }

    const stored = await getLocalStorage([STORAGE_KEY, PREFERENCES_KEY]);
    // A newer refresh owns the current DOM state. An older asynchronous read
    // must never remove colours that the newer refresh has already applied.
    if (sequence !== refreshSequence) return;
    if (isSentinelTemporarilyDisabled()) {
      previouslyColouredElements.forEach(clearChatColor);
      return;
    }

    const conversations = stored[STORAGE_KEY] || {};
    const chatColorsEnabled = stored[PREFERENCES_KEY]?.chatColors !== false;
    const links = allCandidateLinks.filter(isChatHistoryLink);
    const currentConversationKey = getCurrentConversationKey();
    const currentSessionAverageScore = getCurrentSessionAverageScore();

    if (!chatColorsEnabled) {
      previouslyColouredElements.forEach(clearChatColor);
      return;
    }

    const assignments = await Promise.all(links.map(async link => {
      const conversationKey = getConversationKeyFromLink(link);
      if (!conversationKey) return { link, tone: null, averageScore: null };

      const conversationId = await sha256Fingerprint(
        `${location.hostname}|${conversationKey}`
      );
      const analyses = conversations[conversationId];
      const storedAverageScore = getConversationAverageScore(analyses);
      // The current session remains stable while ChatGPT replaces or remaps
      // its generated-title row. Prefer it for the active route so a temporary
      // identity mismatch cannot remove the live conversation colour.
      const rawAverageScore = conversationKey === currentConversationKey &&
        currentSessionAverageScore !== null
        ? currentSessionAverageScore
        : storedAverageScore;
      const tone = classifyAverageScore(rawAverageScore);
      const averageScore = rawAverageScore === null
        ? null
        : Number(rawAverageScore.toFixed(3));
      const color = averageScore === null ? null : getScoreColor(averageScore);
      return {
        link,
        visualElement: getChatHistoryVisualElement(link),
        tone,
        averageScore,
        color
      };
    }));

    if (sequence !== refreshSequence) return;
    if (isSentinelTemporarilyDisabled()) {
      previouslyColouredElements.forEach(clearChatColor);
      return;
    }

    const assignedElements = new Set(
      assignments.map(assignment => assignment.visualElement)
    );
    previouslyColouredElements
      .filter(element => !assignedElements.has(element))
      .forEach(clearChatColor);

    assignments.forEach(({ link, visualElement, tone, averageScore, color }) => {
      if (visualElement !== link) clearChatColor(link);
      if (!tone) {
        clearChatColor(visualElement);
        return;
      }
      visualElement.setAttribute(ATTRIBUTE, tone);
      visualElement.setAttribute(
        "data-sentinel-sentiment-score",
        String(averageScore)
      );
      visualElement.style.setProperty(
        "--sentinel-chat-tone-background",
        `rgba(${color.join(", ")}, 0.24)`
      );
      visualElement.style.setProperty(
        "--sentinel-chat-tone-border",
        `rgb(${color.join(", ")})`
      );
    });
  }

  function scheduleRefresh() {
    if (!hasExtensionContext()) {
      clearTimeout(refreshTimer);
      if (reconciliationInterval !== null) {
        clearInterval(reconciliationInterval);
        reconciliationInterval = null;
      }
      observer?.disconnect();
      document.querySelectorAll(`[${ATTRIBUTE}]`).forEach(clearChatColor);
      return;
    }
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshChatColors().catch(error => {
        console.error("Sentinel could not colour the chat list:", error);
      });
    }, 180);
  }

  function refreshDuringSidebarHydration() {
    // The first prompt creates the permanent chat route and sidebar row while
    // ChatGPT is still streaming DOM mutations. Debounced refreshes can be
    // postponed throughout that process, so sample the row directly at a few
    // points during its short hydration window.
    [0, 180, 450, 900, 1600, 2800].forEach(delay => {
      const timer = setTimeout(() => {
        hydrationRefreshTimers.delete(timer);
        if (!hasExtensionContext()) return;
        refreshChatColors().catch(error => {
          console.error("Sentinel could not colour the new chat row:", error);
        });
      }, delay);
      hydrationRefreshTimers.add(timer);
    });
  }

  injectStyles();
  scheduleRefresh();

  observer = new MutationObserver(scheduleRefresh);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    // A new ChatGPT history row is often mounted before its permanent
    // /c/<id> URL exists. React then updates only the href attribute, which a
    // child-list-only observer cannot see.
    attributes: true,
    attributeFilter: ["href", "class", "aria-current", "data-state"],
    // ChatGPT commonly keeps the same history-row element and changes only
    // its text node when the generated conversation title arrives.
    characterData: true
  });

  // Cover the remaining hydration window even if ChatGPT replaces an element
  // in a way that does not produce a useful mutation for the first refresh.
  setTimeout(scheduleRefresh, 500);
  setTimeout(scheduleRefresh, 1500);

  // ChatGPT may reconcile a generated-title row without exposing a stable
  // mutation that survives React's commit. Periodically restore colours from
  // the already stored aggregate; this performs no model inference.
  reconciliationInterval = setInterval(scheduleRefresh, 1000);

  try {
    if (hasExtensionContext()) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (
          areaName === "local" &&
          (changes[STORAGE_KEY] || changes[PREFERENCES_KEY])
        ) scheduleRefresh();
      });
    }
  } catch {
    observer.disconnect();
  }
  window.addEventListener("sentinel:temporary-chat-change", scheduleRefresh);
  window.addEventListener("sentinel:sentiment-updated", refreshDuringSidebarHydration);
  window.addEventListener("pagehide", () => {
    clearTimeout(refreshTimer);
    hydrationRefreshTimers.forEach(clearTimeout);
    hydrationRefreshTimers.clear();
    if (reconciliationInterval !== null) clearInterval(reconciliationInterval);
    observer?.disconnect();
  }, { once: true });
})();
