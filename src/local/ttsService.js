import * as Speech from "expo-speech";
import * as FileSystem from "expo-file-system";
import { Audio } from "expo-av";

/**
 * Speaking replies aloud.
 *
 * Two engines, and the app says which one is talking:
 *
 *  1. `system` - the phone's own speech engine (`expo-speech`): zero download,
 *     works offline on every Android phone. The default, and always available.
 *  2. `piper` - a downloaded Piper voice, synthesised by sherpa-onnx's VITS
 *     engine. That engine is loaded LAZILY, inside a try/catch, on purpose: its
 *     native module pulls in a filesystem peer whose codegen fails on this
 *     toolchain, and a hard import took the whole app - and the node - down with
 *     it. An optional engine must degrade to "not available here", never crash.
 */

let speaking = false;
let lastSpoken = null;
let ttsEngine = null;
let ttsEngineDir = null;
let sound = null;
let voiceEngineError = null;

function loadSherpa() {
  try {
    // Deliberately not a top-level import: see the note above.
    const sherpa = require("react-native-sherpa-onnx/tts");
    if (!sherpa || typeof sherpa.createTTS !== "function") {
      throw new Error("the on-device voice engine is missing from this build");
    }
    voiceEngineError = null;
    return sherpa;
  } catch (error) {
    voiceEngineError = String((error && error.message) || error);
    return null;
  }
}

export function voiceEngineAvailable() {
  if (ttsEngine) return true;
  return Boolean(loadSherpa());
}

export function voiceEngineProblem() {
  return voiceEngineError;
}

export function isSpeaking() {
  return speaking;
}

export function getLastSpoken() {
  return lastSpoken;
}

export function loadedVoiceDir() {
  return ttsEngineDir;
}

/** Bring a Piper voice into memory (idempotent for the same folder). */
export async function loadVoice(dir) {
  if (!dir) throw new Error("no voice folder was given");
  if (ttsEngine && ttsEngineDir === dir) return { dir, reused: true };
  const sherpa = loadSherpa();
  if (!sherpa) {
    throw new Error(
      `the on-device voice engine is not usable in this build (${voiceEngineError}). Downloading voices still works; speaking with them needs the engine fixed.`
    );
  }
  await unloadVoice();
  ttsEngine = await sherpa.createTTS(sherpa.fileModelPath(dir));
  ttsEngineDir = dir;
  return { dir, reused: false };
}

export async function unloadVoice() {
  if (sound) {
    try {
      await sound.unloadAsync();
    } catch (error) {
      // already gone
    }
    sound = null;
  }
  if (ttsEngine) {
    try {
      await ttsEngine.destroy();
    } catch (error) {
      // releasing is best effort
    }
    ttsEngine = null;
    ttsEngineDir = null;
  }
  return true;
}

/**
 * Speak with a downloaded Piper voice. Resolves when the clip has finished
 * playing (or the safety timeout fires), so callers can report real durations.
 */
export async function speakWithVoice(text, { dir, speed = 1, maxChars = 600 } = {}) {
  const clean = String(text || "")
    .replace(/```[\s\S]*?```/g, " code block ")
    .replace(/[#*_>`]/g, "")
    .trim();
  if (!clean) return { spoken: false, reason: "nothing to say" };
  const cut = clean.length > maxChars ? `${clean.slice(0, maxChars)}...` : clean;
  lastSpoken = cut;

  await loadVoice(dir);
  const sherpa = loadSherpa();
  speaking = true;
  try {
    const audio = await ttsEngine.generateSpeech(cut, { speed });
    const samples = (audio && audio.samples) || [];
    const sampleRate = (audio && audio.sampleRate) || 22050;
    if (!samples.length) throw new Error("the voice produced no audio");

    // The engine hands back float samples; sherpa can write them to a WAV.
    const file = `${FileSystem.cacheDirectory}tts-${Date.now()}.wav`;
    await sherpa.saveAudioToFile(audio, file);

    if (sound) {
      try {
        await sound.unloadAsync();
      } catch (error) {
        // previous clip already finished
      }
      sound = null;
    }
    const created = await Audio.Sound.createAsync({ uri: file });
    sound = created.sound;
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        speaking = false;
        resolve();
      };
      sound.setOnPlaybackStatusUpdate((status) => {
        if (status && (status.didJustFinish || status.error)) finish();
      });
      sound.playAsync().catch(() => finish());
      // Safety: never leave `speaking` stuck if no status ever arrives.
      setTimeout(finish, Math.max(15000, (samples.length / sampleRate) * 1000 + 10000));
    });

    return {
      spoken: true,
      engine: "piper",
      chars: cut.length,
      seconds: Math.round((samples.length / sampleRate) * 10) / 10,
      sampleRate,
      file,
    };
  } catch (error) {
    speaking = false;
    throw new Error(`the on-device voice failed: ${(error && error.message) || error}`);
  }
}

/** The phone's own engine. */
export async function speak(text, { rate = 1.0, language, maxChars = 600 } = {}) {
  const clean = String(text || "")
    .replace(/```[\s\S]*?```/g, " code block ")
    .replace(/[#*_>`]/g, "")
    .trim();
  if (!clean) return { spoken: false, reason: "nothing to say" };

  const cut = clean.length > maxChars ? `${clean.slice(0, maxChars)}...` : clean;
  lastSpoken = cut;
  speaking = true;
  try {
    await Speech.stop();
    Speech.speak(cut, {
      rate,
      language: language && language !== "auto" ? language : undefined,
      onDone: () => {
        speaking = false;
      },
      onStopped: () => {
        speaking = false;
      },
      onError: () => {
        speaking = false;
      },
    });
    return { spoken: true, engine: "system", chars: cut.length };
  } catch (error) {
    speaking = false;
    throw new Error(`the phone's speech engine refused: ${(error && error.message) || error}`);
  }
}

export async function stopSpeaking() {
  speaking = false;
  try {
    if (sound) await sound.stopAsync();
  } catch (error) {
    // nothing was playing
  }
  try {
    await Speech.stop();
  } catch (error) {
    // nothing was speaking
  }
  return true;
}

/** What the device offers, so Settings can show something real. */
export async function listSystemVoices() {
  try {
    return await Speech.getAvailableVoicesAsync();
  } catch (error) {
    return [];
  }
}

export default { getLastSpoken, isSpeaking, listSystemVoices, speak, stopSpeaking, loadVoice, unloadVoice, speakWithVoice, loadedVoiceDir };
