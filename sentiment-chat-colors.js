(function initialiseSentimentChatColors() {
  "use strict";

  const STORAGE_KEY = "sentimentConversations";
  const ATTRIBUTE = "data-sentinel-sentiment-tone";
  const STYLE_ID = "sentinel-sentiment-chat-colors";
  const STRONGLY_POSITIVE_THRESHOLD = 0.65;
  const POSITIVE_THRESHOLD = 0.15;
  const NEGATIVE_THRESHOLD = -0.40;
  const STRONGLY_NEGATIVE_THRESHOLD = -0.65;

  let refreshTimer = null;
  let refreshSequence = 0;

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      a[${ATTRIBUTE}] {
        border-left: 4px solid var(--sentinel-chat-tone-border) !important;
        background: var(--sentinel-chat-tone-background) !important;
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

  function classifyConversationTone(record) {
    const messages = Number(record?.messages || 0);
    if (!messages) return null;

    const averageScore = Number(record.scoreSum || 0) / messages;
    if (averageScore >= STRONGLY_POSITIVE_THRESHOLD) return "strongly-positive";
    if (averageScore > POSITIVE_THRESHOLD) return "positive";
    if (averageScore >= -POSITIVE_THRESHOLD) return "neutral";
    if (averageScore > NEGATIVE_THRESHOLD) return "slightly-negative";
    if (averageScore > STRONGLY_NEGATIVE_THRESHOLD) return "negative";
    return "strongly-negative";
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

  async function sha256Fingerprint(value) {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map(byte => byte.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 32);
  }

  function getLocalStorage(keys) {
    return new Promise(resolve => chrome.storage.local.get(keys, resolve));
  }

  async function refreshChatColors() {
    const sequence = ++refreshSequence;
    const stored = await getLocalStorage([STORAGE_KEY]);
    const conversations = stored[STORAGE_KEY] || {};
    const links = Array.from(document.querySelectorAll('a[href*="/c/"]'));

    const assignments = await Promise.all(links.map(async link => {
      const conversationKey = getConversationKeyFromLink(link);
      if (!conversationKey) return { link, tone: null, averageScore: null };

      const conversationId = await sha256Fingerprint(
        `${location.hostname}|${conversationKey}`
      );
      const record = conversations[conversationId];
      const tone = classifyConversationTone(record);
      const averageScore = record?.messages
        ? Number((Number(record.scoreSum || 0) / Number(record.messages)).toFixed(3))
        : null;
      const color = averageScore === null ? null : getScoreColor(averageScore);
      return { link, tone, averageScore, color };
    }));

    if (sequence !== refreshSequence) return;

    assignments.forEach(({ link, tone, averageScore, color }) => {
      if (!tone) {
        link.removeAttribute(ATTRIBUTE);
        link.removeAttribute("data-sentinel-sentiment-score");
        link.style.removeProperty("--sentinel-chat-tone-background");
        link.style.removeProperty("--sentinel-chat-tone-border");
        return;
      }
      link.setAttribute(ATTRIBUTE, tone);
      link.setAttribute("data-sentinel-sentiment-score", String(averageScore));
      link.style.setProperty(
        "--sentinel-chat-tone-background",
        `rgba(${color.join(", ")}, 0.24)`
      );
      link.style.setProperty(
        "--sentinel-chat-tone-border",
        `rgb(${color.join(", ")})`
      );
    });
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshChatColors().catch(error => {
        console.error("Sentinel could not colour the chat list:", error);
      });
    }, 180);
  }

  injectStyles();
  scheduleRefresh();

  const observer = new MutationObserver(scheduleRefresh);
  observer.observe(document.body, { childList: true, subtree: true });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes[STORAGE_KEY]) scheduleRefresh();
  });
})();
