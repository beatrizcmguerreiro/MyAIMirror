const OFFSCREEN_DOCUMENT_PATH = "sentiment-engine.html";
let creatingOffscreenDocument;

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
      justification: "Run the local ONNX sentiment model outside the service worker."
    }).finally(() => {
      creatingOffscreenDocument = undefined;
    });
  }

  await creatingOffscreenDocument;
}

async function analyzeWithOffscreenModel(text, explain = false) {
  await ensureOffscreenDocument();
  return chrome.runtime.sendMessage({
    target: "sentinel-offscreen",
    type: "sentinel:run-sentiment",
    text,
    explain
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "sentinel:analyze-sentiment") return false;

  const text = typeof message.text === "string" ? message.text.trim() : "";
  if (!text) {
    sendResponse({ ok: false, error: "empty-text" });
    return false;
  }

  analyzeWithOffscreenModel(text, message.explain === true)
    .then(sendResponse)
    .catch(error => {
      console.error("Sentinel could not start the local sentiment engine:", error);
      sendResponse({ ok: false, error: "local-model-unavailable" });
    });

  return true;
});
