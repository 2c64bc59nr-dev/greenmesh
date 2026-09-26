import { createSlice, createAsyncThunk } from "@reduxjs/toolkit";
import * as hf from "../../local/hfStore";
import * as tts from "../../local/ttsService";
import * as log from "../../server/eventLog";

/**
 * Speech: speaking replies out loud, and the Hugging Face downloads behind it.
 *
 * The engine is the phone's own speech synthesiser; downloaded Piper voices are
 * listed and stored for the VITS engine, which is the next piece of wiring.
 */

const initial = {
  voices: [],
  downloading: null,
  progress: 0,
  hfRepo: "",
  hfFile: "",
  hfDownloading: false,
  hfResult: null,
  speaking: false,
  error: null,
  settings: {
    // "system" = the phone's engine. "piper" is reserved for a downloaded voice.
    engine: "system",
    voiceId: null,
    rate: 1,
    autoSpeak: false,
  },
};

export const refreshVoices = createAsyncThunk("speech/refreshVoices", async () => hf.listVoices());

export const downloadVoice = createAsyncThunk("speech/downloadVoice", async (id, { dispatch }) => {
  const voice = hf.voiceById(id);
  if (!voice) throw new Error(`Unknown voice: ${id}`);
  log.info("tts.download", { voice: id, size: voice.sizeLabel });
  try {
    const result = await hf.downloadVoice(voice, (progress) => dispatch(setProgress(progress)));
    log.info("tts.download.done", { voice: id, bytes: result.size });
    await dispatch(refreshVoices()).unwrap().catch(() => {});
    return result;
  } catch (error) {
    log.error("tts.download.failed", { voice: id, message: String(error && error.message) });
    throw error;
  }
});

export const deleteVoice = createAsyncThunk("speech/deleteVoice", async (id, { dispatch }) => {
  await hf.deleteVoice(id);
  log.info("tts.deleted", { voice: id });
  await dispatch(refreshVoices()).unwrap().catch(() => {});
  return id;
});

/** Download any file from any Hugging Face repo (chat, STT or TTS). */
export const downloadFromHuggingFace = createAsyncThunk(
  "speech/downloadHf",
  async ({ repo, file }, { dispatch }) => {
    log.info("hf.download", { repo, file });
    try {
      const result = await hf.downloadHfFile({
        repo,
        file,
        onProgress: (progress) => dispatch(setProgress(progress)),
      });
      log.info("hf.download.done", { name: result.name, bytes: result.size, kind: result.kind });
      return result;
    } catch (error) {
      log.error("hf.download.failed", { repo, file, message: String(error && error.message) });
      throw error;
    }
  }
);

export const speakText = createAsyncThunk("speech/speak", async (text, { getState }) => {
  const { settings, voices } = getState().speech;
  const voice = settings.voiceId ? (voices || []).find((item) => item.id === settings.voiceId) : null;

  // A downloaded voice wins when one is selected; otherwise the phone's engine.
  if (settings.engine === "piper" && voice) {
    const result = await tts.speakWithVoice(text, { dir: voice.dir, speed: settings.rate });
    log.info("tts.spoke", { engine: "piper", chars: result.chars, seconds: result.seconds });
    return result;
  }
  const result = await tts.speak(text, { rate: settings.rate, language: "auto" });
  log.info("tts.spoke", { engine: "system", chars: result && result.chars });
  return result;
});

/** Select a downloaded voice (or go back to the phone's engine). */
export const selectVoice = createAsyncThunk("speech/selectVoice", async (id, { dispatch, getState }) => {
  if (!id) {
    await tts.unloadVoice();
    dispatch(setSpeechSettings({ engine: "system", voiceId: null }));
    log.info("tts.engine", { engine: "system" });
    return { engine: "system", voiceId: null };
  }
  const voice = (getState().speech.voices || []).find((item) => item.id === id);
  if (!voice) throw new Error(`${id} is not downloaded on this phone`);
  await tts.loadVoice(voice.dir);
  dispatch(setSpeechSettings({ engine: "piper", voiceId: id }));
  log.info("tts.engine", { engine: "piper", voice: id });
  return { engine: "piper", voiceId: id };
});

export const stopSpeech = createAsyncThunk("speech/stop", async () => {
  await tts.stopSpeaking();
  return true;
});

const speechSlice = createSlice({
  name: "speech",
  initialState: initial,
  reducers: {
    setProgress: (state, action) => {
      state.progress = action.payload;
    },
    setSpeechSettings: (state, action) => {
      state.settings = { ...state.settings, ...action.payload };
    },
    setHfTarget: (state, action) => {
      state.hfRepo = action.payload.repo !== undefined ? action.payload.repo : state.hfRepo;
      state.hfFile = action.payload.file !== undefined ? action.payload.file : state.hfFile;
    },
    setSpeaking: (state, action) => {
      state.speaking = Boolean(action.payload);
    },
    clearSpeechError: (state) => {
      state.error = null;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(refreshVoices.fulfilled, (state, action) => {
        state.voices = action.payload || [];
      })
      .addCase(downloadVoice.pending, (state, action) => {
        state.downloading = action.meta.arg;
        state.progress = 0;
        state.error = null;
      })
      .addCase(downloadVoice.fulfilled, (state) => {
        state.downloading = null;
        state.progress = 1;
      })
      .addCase(downloadVoice.rejected, (state, action) => {
        state.downloading = null;
        state.progress = 0;
        state.error = String(action.error.message || action.error);
      })
      .addCase(downloadFromHuggingFace.pending, (state) => {
        state.hfDownloading = true;
        state.progress = 0;
        state.error = null;
        state.hfResult = null;
      })
      .addCase(downloadFromHuggingFace.fulfilled, (state, action) => {
        state.hfDownloading = false;
        state.progress = 1;
        state.hfResult = action.payload;
      })
      .addCase(downloadFromHuggingFace.rejected, (state, action) => {
        state.hfDownloading = false;
        state.error = String(action.error.message || action.error);
      })
      .addCase(speakText.pending, (state) => {
        state.speaking = true;
      })
      .addCase(speakText.fulfilled, (state) => {
        state.speaking = false;
      })
      .addCase(speakText.rejected, (state, action) => {
        state.speaking = false;
        state.error = String(action.error.message || action.error);
      })
      .addCase(stopSpeech.fulfilled, (state) => {
        state.speaking = false;
      });
  },
});

export const { setProgress, setSpeechSettings, setHfTarget, setSpeaking, clearSpeechError } =
  speechSlice.actions;

export default speechSlice.reducer;
