import * as FileSystem from "expo-file-system";
import { WHISPER_DIR } from "./whisperStore";

/**
 * Hugging Face downloads for every kind of model this app uses.
 *
 * The chat models (.gguf) already came from Hugging Face; this module makes the
 * same true for speech: Whisper STT models (whisper.cpp's ggml-*.bin) and Piper
 * TTS voices (.onnx + .onnx.json). It also takes any repo/file pair, because
 * "downloadable from HF" should not be limited to the presets we happened to
 * curate - files are routed into the right folder by their extension.
 */

const HF_RESOLVE = "https://huggingface.co";
const PIPER_REPO = "rhasspy/piper-voices";

export const LLM_DIR = `${FileSystem.documentDirectory}models/`;
export const TTS_DIR = `${FileSystem.documentDirectory}tts/`;

/** Curated Piper voices: small, offline, and good enough to read a reply aloud. */
export const PIPER_VOICES = [
  {
    id: "en_US-lessac-medium",
    label: "Lessac - US English (medium)",
    language: "en",
    file: "en/en_US/lessac/medium/en_US-lessac-medium.onnx",
    sizeBytes: 63201294,
    sizeLabel: "60 MB",
    note: "Clear and neutral; the usual Piper default.",
  },
  {
    id: "en_US-amy-medium",
    label: "Amy - US English (medium)",
    language: "en",
    file: "en/en_US/amy/medium/en_US-amy-medium.onnx",
    sizeBytes: 63201294,
    sizeLabel: "60 MB",
    note: "Warmer female voice.",
  },
  {
    id: "en_GB-alba-medium",
    label: "Alba - British English (medium)",
    language: "en",
    file: "en/en_GB/alba/medium/en_GB-alba-medium.onnx",
    sizeBytes: 63201294,
    sizeLabel: "60 MB",
    note: "Scottish-accented British English.",
  },
  {
    id: "en_US-ryan-medium",
    label: "Ryan - US English (medium)",
    language: "en",
    file: "en/en_US/ryan/medium/en_US-ryan-medium.onnx",
    sizeBytes: 63201294,
    sizeLabel: "60 MB",
    note: "Deeper male voice.",
  },
  {
    id: "pl_PL-darkman-medium",
    label: "Darkman - Polski (medium)",
    language: "pl",
    file: "pl/pl_PL/darkman/medium/pl_PL-darkman-medium.onnx",
    sizeBytes: 63201294,
    sizeLabel: "60 MB",
    note: "Polski, męski głos.",
  },
  {
    id: "pl_PL-gosia-medium",
    label: "Gosia - Polski (medium)",
    language: "pl",
    file: "pl/pl_PL/gosia/medium/pl_PL-gosia-medium.onnx",
    sizeBytes: 63201294,
    sizeLabel: "60 MB",
    note: "Polski, żeński głos.",
  },
];

export const voiceById = (id) => PIPER_VOICES.find((voice) => voice.id === id) || null;

const fileUrl = (repo, path) => `${HF_RESOLVE}/${repo}/resolve/main/${path}`;

async function ensureDir(dir) {
  const info = await FileSystem.getInfoAsync(dir);
  if (!info.exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
}

/** Download one file with progress, cleaning up a partial download on failure. */
export async function downloadFile(url, target, onProgress) {
  const resumable = FileSystem.createDownloadResumable(url, target, {}, (progress) => {
    if (!onProgress) return;
    const total = progress.totalBytesExpectedToWrite || 0;
    const written = progress.totalBytesWritten || 0;
    onProgress(total > 0 ? Math.min(1, written / total) : 0, written, total);
  });
  try {
    const result = await resumable.downloadAsync();
    if (!result || !result.uri) throw new Error("download did not complete");
    const info = await FileSystem.getInfoAsync(target);
    if (!info.exists || !info.size) throw new Error("downloaded file is empty");
    return { uri: target, size: info.size };
  } catch (error) {
    await FileSystem.deleteAsync(target, { idempotent: true });
    throw new Error(`download failed: ${(error && error.message) || error}`);
  }
}

/**
 * Fetch a Piper voice: the model plus the .json config it cannot talk without.
 * Both live in their own folder so switching voices is just a path change.
 */
export async function downloadVoice(voice, onProgress) {
  await ensureDir(TTS_DIR);
  const dir = `${TTS_DIR}${voice.id}/`;
  await ensureDir(dir);
  const model = `${dir}${voice.id}.onnx`;
  const config = `${dir}${voice.id}.onnx.json`;

  const existing = await FileSystem.getInfoAsync(model);
  const existingConfig = await FileSystem.getInfoAsync(config);
  if (existing.exists && existingConfig.exists && (existing.size || 0) > 0) {
    return { id: voice.id, dir, model, config, size: existing.size || 0, alreadyThere: true };
  }

  const result = await downloadFile(fileUrl(PIPER_REPO, voice.file), model, (p, written, total) =>
    onProgress && onProgress(p * 0.95, written, total)
  );
  await downloadFile(fileUrl(PIPER_REPO, `${voice.file}.json`), config, (p) =>
    onProgress && onProgress(0.95 + p * 0.05)
  );
  return { id: voice.id, dir, model, config, size: result.size };
}

export async function listVoices() {
  await ensureDir(TTS_DIR);
  const entries = await FileSystem.readDirectoryAsync(TTS_DIR);
  const voices = [];
  for (const name of entries) {
    const dir = `${TTS_DIR}${name}/`;
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists || !info.isDirectory) continue;
    const files = await FileSystem.readDirectoryAsync(dir);
    const model = files.find((file) => file.endsWith(".onnx"));
    const config = files.find((file) => file.endsWith(".onnx.json"));
    if (!model || !config) continue;
    const modelInfo = await FileSystem.getInfoAsync(`${dir}${model}`);
    voices.push({
      id: name,
      dir,
      model: `${dir}${model}`,
      config: `${dir}${config}`,
      size: (modelInfo && modelInfo.size) || 0,
      sizeLabel: `${Math.round(((modelInfo && modelInfo.size) || 0) / 1024 / 1024)} MB`,
      preset: voiceById(name) ? name : null,
    });
  }
  return voices;
}

export async function deleteVoice(id) {
  await FileSystem.deleteAsync(`${TTS_DIR}${id}/`, { idempotent: true });
  return true;
}

/**
 * Download any single file from any Hugging Face repo. The destination is chosen
 * by what the file is: .gguf is a chat model, ggml-*.bin is Whisper, .onnx is a
 * TTS voice - everything else lands in the exports folder rather than pretending
 * to be a model.
 */
export async function downloadHfFile({ repo, file, onProgress }) {
  const cleanRepo = String(repo || "").trim().replace(/^https?:\/\/huggingface\.co\//, "").replace(/\/$/, "");
  const cleanFile = String(file || "").trim().replace(/^\/+/, "");
  if (!cleanRepo || !cleanFile) throw new Error("give a repo (user/name) and a file path inside it");

  const name = cleanFile.split("/").pop();
  let dir = EXPORT_LIKE_DIR;
  if (/\.gguf$/i.test(name)) dir = LLM_DIR;
  else if (/^ggml-.*\.bin$/i.test(name)) dir = WHISPER_DIR;
  else if (/\.onnx(\.json)?$/i.test(name)) dir = `${TTS_DIR}manual/`;

  await ensureDir(dir);
  const target = `${dir}${name}`;
  const result = await downloadFile(fileUrl(cleanRepo, cleanFile), target, onProgress);
  return { repo: cleanRepo, file: cleanFile, name, path: target, size: result.size, kind: dir };
}

const EXPORT_LIKE_DIR = `${FileSystem.documentDirectory}downloads/`;

export default {
  LLM_DIR,
  PIPER_VOICES,
  TTS_DIR,
  deleteVoice,
  downloadFile,
  downloadHfFile,
  downloadVoice,
  listVoices,
  voiceById,
};
