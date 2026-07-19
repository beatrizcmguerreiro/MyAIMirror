import { env, pipeline } from "./sentiment-runtime/transformers-browser.min.js";

const MODEL_ID = "Xenova/twitter-roberta-base-sentiment-latest";
const MODEL_METHOD = "cardiff-twitter-roberta-sentiment-latest";
const MODEL_REVISION = "f3ec4d0925f90c3ca7ee7814f52d6ee7cf180445";
const MODEL_VERSION = `${MODEL_REVISION}-q8`;

// The model is downloaded once and cached by the browser. Only model assets are
// fetched remotely; prompts are processed by the model locally on the device.
env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;
env.useWasmCache = false;
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.wasmPaths = {
  mjs: chrome.runtime.getURL("sentiment-runtime/onnx-runtime-loader.mjs"),
  wasm: chrome.runtime.getURL("sentiment-runtime/onnx-runtime.wasm")
};

let classifierPromise;
let lastProgressBucket = -1;

function reportModelProgress(event) {
  if (event?.status === "progress" && Number.isFinite(event.progress)) {
    const bucket = Math.floor(event.progress / 10) * 10;
    if (bucket !== lastProgressBucket) {
      lastProgressBucket = bucket;
      console.info(`Sentinel sentiment model download: ${bucket}%`);
    }
    return;
  }

  if (["initiate", "ready", "done"].includes(event?.status)) {
    console.info(`Sentinel sentiment model: ${event.status}`);
  }
}

function getClassifier() {
  if (!classifierPromise) {
    console.info("Sentinel sentiment model: loading");
    classifierPromise = pipeline("text-classification", MODEL_ID, {
      dtype: "q8",
      device: "wasm",
      revision: MODEL_REVISION,
      progress_callback: reportModelProgress
    }).then(classifier => {
      console.info("Sentinel sentiment model: ready");
      return classifier;
    }).catch(error => {
      classifierPromise = undefined;
      throw error;
    });
  }
  return classifierPromise;
}

function normalizePrediction(prediction) {
  const label = String(prediction.label || "").toLowerCase();
  if (!new Set(["positive", "neutral", "negative"]).has(label)) {
    throw new Error(`Unexpected sentiment label: ${prediction.label}`);
  }

  const probability = Number(prediction.score);
  const signedScore = label === "positive"
    ? probability
    : label === "negative"
      ? -probability
      : 0;

  return {
    label,
    score: Number(signedScore.toFixed(3)),
    confidence: Number(probability.toFixed(3)),
    method: MODEL_METHOD,
    version: MODEL_VERSION
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (
    message?.target !== "sentinel-offscreen" ||
    message?.type !== "sentinel:run-sentiment"
  ) return false;

  const text = typeof message.text === "string" ? message.text.trim() : "";
  if (!text) {
    sendResponse({ ok: false, error: "empty-text" });
    return false;
  }

  // The raw prompt is used only for this inference call and is never persisted.
  console.info("Sentinel sentiment analysis: processing locally");
  getClassifier()
    .then(classifier => classifier(text, { top_k: 1 }))
    .then(output => {
      const prediction = Array.isArray(output) ? output[0] : output;
      const sentiment = normalizePrediction(prediction);
      console.info(
        `Sentinel sentiment result: ${sentiment.label} (${sentiment.confidence})`
      );
      sendResponse({ ok: true, sentiment });
    })
    .catch(error => {
      console.error("Sentinel offscreen sentiment analysis failed:", error);
      sendResponse({ ok: false, error: "local-model-unavailable" });
    });

  return true;
});
