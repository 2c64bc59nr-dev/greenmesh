import * as FileSystem from "expo-file-system";
import AudioRecord from "@fugood/react-native-audio-pcm-stream";
import { initWhisper, releaseAllWhisper } from "whisper.rn";

/**
 * On-device dictation: record the microphone, transcribe with Whisper locally.
 *
 * The capture module emits raw 16-bit PCM chunks as base64 and writes nothing
 * itself, so this module assembles them into a WAV (Whisper wants mono 16 kHz
 * 16-bit) and hands the file to whisper.rn. Nothing leaves the phone - the same
 * rule as the chat models.
 */

const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
// AudioSource.VOICE_RECOGNITION - tuned for speech, no AGC surprises
const AUDIO_SOURCE = 6;

let context = null;
let loadedPath = null;
let chunks = [];
let recording = false;
let frames = 0;
let startedAt = 0;
let listenerAttached = false;
let frameListener = null;

export const isLoaded = () => Boolean(context);
export const currentPath = () => loadedPath;
export const isRecording = () => recording;
export const frameCount = () => frames;

export function onFrame(callback) {
  frameListener = callback;
}

export async function loadModel(path, { onProgress } = {}) {
  if (context && loadedPath === path) return { path, reused: true };
  await unload();
  if (onProgress) onProgress(0.1);
  context = await initWhisper({ filePath: path });
  loadedPath = path;
  if (onProgress) onProgress(1);
  return { path, reused: false };
}

export async function unload() {
  if (!context) return false;
  try {
    await context.release();
  } catch (error) {
    // releasing is best effort; the next init takes a fresh context anyway
  }
  context = null;
  loadedPath = null;
  return true;
}

export async function release() {
  await unload();
  try {
    await releaseAllWhisper();
  } catch (error) {
    // nothing to release
  }
}

/**
 * Start capturing. Chunks are collected in memory: a few minutes of speech is a
 * few megabytes, and the transcript only needs the audio once.
 */
export async function startRecording({ onFrame: perFrame } = {}) {
  if (recording) return false;
  if (perFrame) frameListener = perFrame;

  if (!listenerAttached) {
    AudioRecord.on("data", (base64) => {
      if (!recording) return;
      chunks.push(base64);
      frames += 1;
      if (frameListener) frameListener(frames);
    });
    listenerAttached = true;
  }

  // The native module declares init() with a Promise, so the call returns one.
  // Wrapping it in a callback-style promise instead would hang forever.
  try {
    const maybePromise = AudioRecord.init({
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
      bitsPerSample: BITS_PER_SAMPLE,
      audioSource: AUDIO_SOURCE,
      // ~130 ms at 16 kHz: small enough for a responsive stop, large enough
      // that the audio thread is not woken constantly.
      bufferSize: 4096,
      wavFile: "dictation.wav",
    });
    if (maybePromise && typeof maybePromise.then === "function") await maybePromise;
  } catch (error) {
    throw new Error(`could not open the microphone: ${(error && error.message) || error}`);
  }

  chunks = [];
  frames = 0;
  startedAt = Date.now();
  recording = true;
  AudioRecord.start();
  return true;
}

/** Stop capturing and report what was collected. */
export function stopRecording() {
  if (!recording) return { chunks: [], frames: 0, seconds: 0 };
  recording = false;
  try {
    AudioRecord.stop();
  } catch (error) {
    // the native side may already have released the recorder
  }
  const collected = chunks.slice();
  chunks = [];
  const seconds = (Date.now() - startedAt) / 1000;
  return { chunks: collected, frames: frames, seconds };
}

/**
 * base64 -> bytes -> base64, because each chunk is padded on its own.
 *
 * The native capture module occasionally emits a chunk that is not valid base64
 * (a partial buffer around start/stop). Dropping those is correct - they are a
 * few milliseconds of silence - while a whole recording of them would be a bug,
 * so the count is reported back to the caller.
 */
function concatBase64(chunks) {
  const VALID = /^[A-Za-z0-9+/]*={0,2}$/;
  const usable = [];
  let dropped = 0;
  for (const chunk of chunks) {
    if (typeof chunk !== "string" || chunk.length === 0) continue;
    if (chunk.length % 4 !== 0 || !VALID.test(chunk)) {
      dropped += 1;
      continue;
    }
    usable.push(chunk);
  }
  if (usable.length === 0) throw new Error("the microphone returned no usable audio");

  const parts = [];
  let total = 0;
  for (const chunk of usable) {
    const binary = atob(chunk);
    parts.push(binary);
    total += binary.length;
  }
  const merged = new Array(total);
  let offset = 0;
  for (const part of parts) {
    for (let index = 0; index < part.length; index += 1) merged[offset + index] = part.charCodeAt(index);
    offset += part.length;
  }
  // Build the byte string in blocks: one huge concat blows the string limit.
  let binary = "";
  const BLOCK = 8192;
  for (let index = 0; index < merged.length; index += BLOCK) {
    binary += String.fromCharCode.apply(null, merged.slice(index, index + BLOCK));
  }
  return { binary, bytes: merged.length, dropped, usedChunks: usable.length };
}

function wavHeader(dataBytes) {
  const blockAlign = (CHANNELS * BITS_PER_SAMPLE) / 8;
  const byteRate = SAMPLE_RATE * blockAlign;
  const buffer = new ArrayBuffer(44);
  const view = new DataView(buffer);
  const write = (offset, text) => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, BITS_PER_SAMPLE, true);
  write(36, "data");
  view.setUint32(40, dataBytes, true);
  const bytes = new Uint8Array(buffer);
  let header = "";
  for (let index = 0; index < bytes.length; index += 1) header += String.fromCharCode(bytes[index]);
  return header;
}

/** Write collected PCM as a WAV the transcriber can read. */
export async function writeWav(chunks, fileName = "dictation.wav") {
  const { binary, bytes, dropped, usedChunks } = concatBase64(chunks);
  if (bytes === 0) throw new Error("no audio was captured");
  const base64 = btoa(`${wavHeader(bytes)}${binary}`);
  const uri = `${FileSystem.cacheDirectory}${fileName}`;
  await FileSystem.writeAsStringAsync(uri, base64, { encoding: FileSystem.EncodingType.Base64 });
  return {
    uri,
    bytes,
    dropped,
    chunks: usedChunks,
    seconds: bytes / (SAMPLE_RATE * (BITS_PER_SAMPLE / 8)),
  };
}

/**
 * Transcribe a WAV file. `onProgress` gets 0..100 from whisper.cpp, and
 * `onPartial` gets growing text so the UI can show it arriving.
 */
export async function transcribe(uri, { language, onProgress, onPartial, maxThreads } = {}) {
  if (!context) throw new Error("no Whisper model is loaded");
  const options = {};
  if (language && language !== "auto") options.language = language;
  if (maxThreads) options.maxThreads = maxThreads;
  if (onProgress) options.onProgress = (progress) => onProgress(progress);
  if (onPartial) options.onNewSegments = (result) => onPartial(result && result.result ? result.result : "");

  const { promise } = context.transcribe(uri, options);
  const result = await promise;
  const text = (result && (result.result || result.text)) || "";
  return { text: String(text).trim(), segments: (result && result.segments) || [] };
}

/** Record -> WAV -> text, the whole dictation in one call. */
export async function transcribeRecording(chunks, { language, onProgress, onPartial, maxThreads } = {}) {
  const { uri, seconds } = await writeWav(chunks);
  const { text } = await transcribe(uri, { language, onProgress, onPartial, maxThreads });
  return { text, seconds, uri };
}

export default {
  frameCount,
  isLoaded,
  isRecording,
  loadModel,
  onFrame,
  release,
  startRecording,
  stopRecording,
  transcribe,
  transcribeRecording,
  unload,
  writeWav,
};
