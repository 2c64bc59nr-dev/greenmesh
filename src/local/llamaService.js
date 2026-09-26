import { initLlama } from "llama.rn";
import { containsMedia, withSystemPrompt, DEFAULT_IMAGE_PROMPT } from "../features/chat/messageFormat";

export const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful assistant. Answer concisely and in the user's language.";

let context = null;
let loadedModelConfig = null;
let multimodal = { enabled: false, vision: false, audio: false };

export const isLoaded = () => context !== null;
export const getLoadedConfig = () => loadedModelConfig;
export const isVisionReady = () => multimodal.enabled && multimodal.vision;
export const getMultimodalInfo = () => ({ ...multimodal });

/**
 * Load a GGUF model on the CPU.
 * params: { nCtx, nThreads, systemPrompt, mmprojPath }
 *
 * When mmprojPath is given the multimodal projector is loaded as well, which is
 * what makes photo input work (vision-capable models only, e.g. Gemma 3 or
 * InternVL; Gemma 3n ships no projector and stays text-only).
 */
export async function loadModel(path, params = {}, onProgress) {
  await unloadModel();

  const nCtx = params.nCtx || 2048;
  const nThreads = params.nThreads || 4;
  const mmprojPath = params.mmprojPath || null;

  context = await initLlama(
    {
      model: path,
      n_ctx: nCtx,
      n_threads: nThreads,
      n_gpu_layers: 0, // CPU-only inference
      use_mlock: false,
      use_progress_callback: typeof onProgress === "function",
      // Media tokens must not be shifted out of the context window.
      ...(mmprojPath ? { ctx_shift: false } : {}),
    },
    typeof onProgress === "function" ? onProgress : undefined
  );

  multimodal = { enabled: false, vision: false, audio: false };
  let multimodalError = null;

  if (mmprojPath) {
    try {
      const ok = await context.initMultimodal({ path: mmprojPath, use_gpu: false });
      if (ok) {
        let support = null;
        try {
          support = await context.getMultimodalSupport();
        } catch (error) {
          support = null;
        }
        multimodal = {
          enabled: true,
          vision: support ? Boolean(support.vision) : true,
          audio: support ? Boolean(support.audio) : false,
        };
      } else {
        multimodalError = "The projector file was rejected by llama.cpp";
      }
    } catch (error) {
      multimodalError = (error && error.message) || "Could not load the projector";
    }
  }

  loadedModelConfig = {
    path,
    nCtx,
    nThreads,
    mmprojPath,
    systemPrompt: params.systemPrompt || DEFAULT_SYSTEM_PROMPT,
    vision: multimodal.vision,
    multimodalError,
  };
  return context;
}

/**
 * Release the loaded model.
 * The reference is dropped BEFORE awaiting release, and releaseAllLlama() is
 * deliberately not used: calling it while a release is in flight deadlocks the
 * next initLlama (observed as an eternal "Loading model... 0%").
 */
export async function unloadModel() {
  const previous = context;
  context = null;
  loadedModelConfig = null;
  multimodal = { enabled: false, vision: false, audio: false };
  if (!previous) return;
  try {
    await previous.release();
  } catch (error) {
    // context is already dropped; a failed release must not block the next load
  }
}

async function buildPrompt(messages, systemPrompt) {
  const system = systemPrompt && systemPrompt.trim() ? systemPrompt.trim() : DEFAULT_SYSTEM_PROMPT;
  const withSystem = messages.some((message) => message.role === "system")
    ? messages
    : [{ role: "system", content: system }, ...messages];

  try {
    const formatted = await context.getFormattedChat(withSystem, null, { jinja: true });
    const prompt = typeof formatted === "string" ? formatted : formatted && formatted.prompt;
    if (prompt) return prompt;
  } catch (error) {
    // GGUF without an embedded chat template
  }

  return `${withSystem.map((m) => `${m.role}: ${m.content}`).join("\n")}\nassistant:`;
}

/**
 * Run a completion. params: { temperature, topP, maxTokens, systemPrompt,
 * imagePrompt, onToken }
 *
 * Messages carrying a photo are handed to llama.rn as a message array (llama.cpp
 * injects the media tokens through mtmd); plain text keeps using the formatted
 * prompt, which is what streaming already relies on.
 */
export async function complete(messages, params = {}) {
  if (!context) throw new Error("No local model is loaded");

  const {
    temperature = 0.7,
    topP = 0.95,
    maxTokens = 256,
    systemPrompt,
    imagePrompt,
    onToken,
  } = params;

  const media = containsMedia(messages);
  if (media && !multimodal.enabled) {
    throw new Error(
      "This model has no vision projector (mmproj). Load a vision model such as Gemma 3 4B on the Model tab, or switch to API mode."
    );
  }
  if (media && !multimodal.vision) {
    throw new Error("The loaded projector does not support images.");
  }

  const system = systemPrompt && systemPrompt.trim() ? systemPrompt.trim() : DEFAULT_SYSTEM_PROMPT;
  const prompt = media ? null : await buildPrompt(messages, system);

  let streamed = "";

  const result = await context.completion(
    {
      ...(media
        ? { messages: withSystemPrompt(messages, system, imagePrompt || DEFAULT_IMAGE_PROMPT) }
        : { prompt }),
      n_predict: maxTokens,
      temperature,
      top_p: topP,
      stop: ["<|end_of_text|>", "<|end_of_text|>", "</s>", "\nuser:", "user:"],
    },
    (data) => {
      if (data && data.token && onToken) {
        streamed += data.token;
        onToken(streamed);
      }
    }
  );

  return ((result && result.text) || streamed || "").trim();
}
