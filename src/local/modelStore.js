import * as FileSystem from "expo-file-system";

export const MODELS_DIR = `${FileSystem.documentDirectory}models/`;

const ensureDir = async () => {
  const info = await FileSystem.getInfoAsync(MODELS_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(MODELS_DIR, { intermediates: true });
  }
};

const prettySize = (bytes) => {
  if (!bytes && bytes !== 0) return "";
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(0)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
};

/** A multimodal projector (mmproj) is loaded next to the model to enable photos. */
export const isProjectorName = (name) => /mmproj|projector/i.test(String(name));

/** Every .gguf in the app folder, flagged as model or projector. */
export async function listGgufFiles() {
  await ensureDir();
  const names = await FileSystem.readDirectoryAsync(MODELS_DIR);
  const files = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith(".gguf")) continue;
    const path = `${MODELS_DIR}${name}`;
    const info = await FileSystem.getInfoAsync(path);
    files.push({
      name,
      path,
      size: info.size || 0,
      sizeLabel: prettySize(info.size),
      isProjector: isProjectorName(name),
      isVision: isProjectorName(name),
    });
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

/** Plain model list (kept for the existing UI callers). */
export async function listModels() {
  const files = await listGgufFiles();
  return files.filter((file) => !file.isProjector);
}

export async function listProjectors() {
  const files = await listGgufFiles();
  return files.filter((file) => file.isProjector);
}

const interestingTokens = (name) =>
  String(name)
    .toLowerCase()
    .replace(/mmproj/gi, " ")
    .replace(/\.gguf$/i, "")
    .split(/[^a-z0-9.]+/)
    .filter((token) => token.length > 2 && !/^(q\d(_\d)?|q\d|f16|f32|it|instruct|model|bf16|iq\d(_\w+)?)$/.test(token));

/**
 * Pick the projector that belongs to a model by token overlap. Deliberately no
 * blind fallback: pairing a text model with the wrong mmproj fails at load
 * time, so an unmatched projector has to be chosen by hand in the UI.
 */
export function guessProjector(modelName, files) {
  const projectors = (files || []).filter((file) => file.isProjector);
  if (!projectors.length) return null;

  const target = interestingTokens(modelName);
  let best = null;
  let bestScore = 0;
  for (const projector of projectors) {
    const score = interestingTokens(projector.name).filter((token) => target.includes(token)).length;
    if (score > bestScore) {
      best = projector;
      bestScore = score;
    }
  }
  return best;
}

export async function deleteModel(path) {
  await FileSystem.deleteAsync(path, { idempotent: true });
}

/** Download a GGUF into the app's private models dir, reporting 0..1 progress. */
export async function downloadModel(url, fileName, onProgress) {
  await ensureDir();
  const target = `${MODELS_DIR}${fileName}`;

  const existing = await FileSystem.getInfoAsync(target);
  if (existing.exists) {
    await FileSystem.deleteAsync(target, { idempotent: true });
  }

  const resumable = FileSystem.createDownloadResumable(url, target, {}, (progress) => {
    const total = progress.totalBytesExpectedToWrite || 0;
    const written = progress.totalBytesWritten || 0;
    if (onProgress) onProgress(total > 0 ? written / total : 0, written, total);
  });

  const result = await resumable.downloadAsync();
  if (!result || !result.uri) throw new Error("Download failed");
  return { path: result.uri, name: fileName };
}

/** Turn a URL into a safe file name. */
export function fileNameFromUrl(url) {
  const clean = String(url).split("?")[0];
  const last = clean.split("/").filter(Boolean).pop() || "model.gguf";
  const safe = last.replace(/[^A-Za-z0-9._-]/g, "_");
  return safe.toLowerCase().endsWith(".gguf") ? safe : `${safe}.gguf`;
}

/** Free space in bytes (null when the platform does not report it). */
export async function freeSpace() {
  try {
    const info = await FileSystem.getFreeDiskStorageAsync();
    return typeof info === "number" ? info : null;
  } catch (error) {
    return null;
  }
}

export const formatBytes = prettySize;

export default {
  MODELS_DIR,
  listModels,
  listProjectors,
  listGgufFiles,
  guessProjector,
  isProjectorName,
  deleteModel,
  downloadModel,
  fileNameFromUrl,
  freeSpace,
  formatBytes,
};
