const OFFSCREEN_DOCUMENT_PATH = "sentiment-engine.html";
const PAGE_FEATURE_SCRIPTS = [
  "chat-monitor.js",
  "sentiment-chat-colors.js",
  "visualization-controls.js",
  "behavioral-metrics.js",
  "conversation-deletion-sync.js",
  "theme-metrics.js",
  "new-chat-visualizations.js",
  "post-response-reflection.js",
  "usage-overview.js",
  "pdf-report.js",
  "usage-report.js"
];
let creatingOffscreenDocument;

async function removeLegacyAnalysisStorage() {
  await chrome.storage.local.remove([
    "sentimentConversations",
    "intentConversations",
    "dailySentiment",
    "dailyCounts",
    "dailyWordCounts",
    "activeSession"
  ]);
}

async function migrateSentimentConfidenceToScore() {
  const key = "conversationAnalysesV1";
  const stored = await chrome.storage.local.get([key]);
  const conversations = stored[key] || {};
  let changed = false;

  Object.values(conversations).forEach(analyses => {
    if (!Array.isArray(analyses)) return;
    analyses.forEach(analysis => {
      const sentiment = analysis?.sentiment;
      if (!sentiment || !Object.hasOwn(sentiment, "confidence")) return;
      if (!Object.hasOwn(sentiment, "score")) {
        sentiment.score = sentiment.confidence;
      }
      delete sentiment.confidence;
      changed = true;
    });
  });

  if (changed) await chrome.storage.local.set({ [key]: conversations });
}

removeLegacyAnalysisStorage()
  .then(migrateSentimentConfidenceToScore)
  .catch(error => {
    console.error("Sentinel could not migrate legacy analysis storage:", error);
  });

async function hasOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);

  if ("getContexts" in chrome.runtime) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl]
    });
    return contexts.length > 0;
  }

  const matchedClients = await clients.matchAll();
  return matchedClients.some(client => client.url === offscreenUrl);
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;

  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ["WORKERS"],
      justification: "Run Sentinel's local ONNX language models outside the service worker."
    }).finally(() => {
      creatingOffscreenDocument = undefined;
    });
  }

  await creatingOffscreenDocument;
}

function waitForOffscreenListener(delayMs) {
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

async function sendToOffscreen(message) {
  await ensureOffscreenDocument();
  let lastError;

  // createDocument() can resolve just before the offscreen module has
  // registered its message listener. Retry that short first-load window.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      lastError = error;
      await waitForOffscreenListener(50 * (attempt + 1));
    }
  }

  throw lastError;
}

async function analyzeWithOffscreenModel(text, explain = false) {
  return sendToOffscreen({
    target: "sentinel-offscreen",
    type: "sentinel:run-sentiment",
    text,
    explain
  });
}

async function analyzeIntentWithOffscreenModel(text) {
  return sendToOffscreen({
    target: "sentinel-offscreen",
    type: "sentinel:run-intent",
    text
  });
}

async function prewarmLocalModels() {
  return sendToOffscreen({
    target: "sentinel-offscreen",
    type: "sentinel:prewarm-models"
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "sentinel:enable-page-features") {
    const tabId = sender.tab?.id;
    if (!Number.isInteger(tabId)) {
      sendResponse({ ok: false, error: "missing-tab" });
      return false;
    }

    chrome.scripting.executeScript({
      target: { tabId },
      files: PAGE_FEATURE_SCRIPTS
    }).then(() => {
      sendResponse({ ok: true });
      // Prepare local inference as soon as ChatGPT opens. Sentiment is warmed
      // first by the offscreen page because it powers the live draft preview.
      prewarmLocalModels().catch(error => {
        console.warn("Sentinel could not prewarm its local models:", error);
      });
    })
      .catch(error => {
        console.error("Sentinel could not inject its page features:", error);
        sendResponse({ ok: false, error: "feature-injection-failed" });
      });
    return true;
  }

  const isSentimentRequest = message?.type === "sentinel:analyze-sentiment";
  const isIntentRequest = message?.type === "sentinel:analyze-intent";
  if (!isSentimentRequest && !isIntentRequest) return false;

  const text = typeof message.text === "string" ? message.text.trim() : "";
  if (!text) {
    sendResponse({ ok: false, error: "empty-text" });
    return false;
  }

  const analysis = isIntentRequest
    ? analyzeIntentWithOffscreenModel(text)
    : analyzeWithOffscreenModel(text, message.explain === true);

  analysis
    .then(sendResponse)
    .catch(error => {
      const analysisName = isIntentRequest ? "intention" : "sentiment";
      console.error(`Sentinel could not start the local ${analysisName} engine:`, error);
      sendResponse({
        ok: false,
        error: isIntentRequest
          ? "local-intention-model-unavailable"
          : "local-model-unavailable"
      });
    });

  return true;
});
