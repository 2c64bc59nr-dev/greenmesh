import * as FileSystem from "expo-file-system";

/**
 * Whisper models for on-device dictation.
 *
 * These are whisper.cpp's GGML models (not .gguf like the chat models), so they
 * get their own directory rather than being mixed into the language-model list.
 * Presets are the quantised ones: same transcript quality in practice on a phone,
 * a fraction of the download and the memory.
 */

export const WHISPER_DIR = `${FileSystem.documentDirectory}whisper/`;

const BASE_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";

export const PRESETS = [
  {
    id: "tiny.en.q5_1",
    name: "ggml-tiny.en-q5_1.bin",
    label: "Tiny - English",
    sizeBytes: 32166155,
    sizeLabel: "31 MB",
    note: "Fastest. Good for short, clear dictation. English only.",
  },
  {
    id: "base.en.q5_1",
    name: "ggml-base.en-q5_1.bin",
    label: "Base - English",
    sizeBytes: 59721011,
    sizeLabel: "57 MB",
    note: "The usual pick: accurate enough for notes and chat, still quick.",
  },
  {
    id: "base.q5_1",
    name: "ggml-base-q5_1.bin",
    label: "Base - multilingual",
    sizeBytes: 59707625,
    sizeLabel: "57 MB",
    note: "Same size, any language (Polish, English, ~99 languages).",
  },
  {
    id: "small.q5_1",
    name: "ggml-small-q5_1.bin",
    label: "Small - multilingual",
    sizeBytes: 190085487,
    sizeLabel: "181 MB",
    note: "Clearly better on accents and noisy rooms; slower on a phone.",
  },
];

export const presetById = (id) => PRESETS.find((preset) => preset.id === id) || null;
export const presetForName = (name) => PRESETS.find((preset) => preset.name === name) || null;
export const urlFor = (preset) => `${BASE_URL}${preset.name}`;

export const isWhisperModel = (name) => /^ggml-.*\.bin$/i.test(String(name || ""));

async function ensureDir() {
  const info = await FileSystem.getInfoAsync(WHISPER_DIR);
  if (!info.exists) await FileSystem.makeDirectoryAsync(WHISPER_DIR, { intermediates: true });
}

/** Models actually present on disk, newest info read fresh each call. */
export async function listWhisperModels() {
  await ensureDir();
  const names = await FileSystem.readDirectoryAsync(WHISPER_DIR);
  const files = [];
  for (const name of names) {
    if (!isWhisperModel(name)) continue;
    const path = `${WHISPER_DIR}${name}`;
    const info = await FileSystem.getInfoAsync(path);
    files.push({
      name,
      path,
      size: info.size || 0,
      sizeLabel: `${Math.round((info.size || 0) / 1024 / 1024)} MB`,
      preset: presetForName(name) ? presetForName(name).id : null,
    });
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

export async function deleteWhisperModel(name) {
  await FileSystem.deleteAsync(`${WHISPER_DIR}${name}`, { idempotent: true });
  return true;
}

/**
 * Download a preset. Progress is reported 0..1 so the UI can show a bar; the
 * partial file is removed if the download fails, so a broken file can never be
 * mistaken for a usable model.
 */
export async function downloadPreset(preset, onProgress) {
  await ensureDir();
  const target = `${WHISPER_DIR}${preset.name}`;
  const existing = await FileSystem.getInfoAsync(target);
  if (existing.exists && (existing.size || 0) > 0) {
    return { name: preset.name, path: target, size: existing.size || 0, alreadyThere: true };
  }

  const resumable = FileSystem.createDownloadResumable(
    urlFor(preset),
    target,
    {},
    (progress) => {
      if (!onProgress) return;
      const total = progress.totalBytesExpectedToWrite || preset.sizeBytes;
      const written = progress.totalBytesWritten || 0;
      onProgress(total > 0 ? Math.min(1, written / total) : 0, written, total);
    }
  );

  try {
    const result = await resumable.downloadAsync();
    if (!result || !result.uri) throw new Error("download did not complete");
    const info = await FileSystem.getInfoAsync(target);
    return { name: preset.name, path: target, size: (info && info.size) || 0 };
  } catch (error) {
    await FileSystem.deleteAsync(target, { idempotent: true });
    throw new Error(`Could not download ${preset.label}: ${(error && error.message) || error}`);
  }
}

export default {
  PRESETS,
  WHISPER_DIR,
  deleteWhisperModel,
  downloadPreset,
  isWhisperModel,
  listWhisperModels,
  presetById,
  presetForName,
  urlFor,
};
