import { createSlice, createAsyncThunk } from "@reduxjs/toolkit";
import * as whisper from "../../local/whisperService";
import * as whisperStore from "../../local/whisperStore";

/**
 * Dictation: record the phone's microphone and turn it into text with a local
 * Whisper model. One utterance is one transcript - the recording runs from the
 * moment the mic button is pressed until it is released (push to talk) or
 * pressed again (tap to start / tap to stop).
 */

const state = {
  models: [],
  path: null,
  name: null,
  loaded: false,
  loading: false,
  downloading: null,
  progress: 0,
  error: null,
  // idle | recording | transcribing
  status: "idle",
  frames: 0,
  seconds: 0,
  liveText: "",
  lastText: "",
  settings: {
    // "auto" lets Whisper detect the language; setting it explicitly is faster
    // and stops an English model from inventing a translation.
    language: "auto",
    autoSend: false,
  },
};

export const refreshWhisperModels = createAsyncThunk("dictation/refreshModels", async () =>
  whisperStore.listWhisperModels()
);

export const downloadWhisperPreset = createAsyncThunk(
  "dictation/download",
  async (presetId, { dispatch }) => {
    const preset = whisperStore.presetById(presetId);
    if (!preset) throw new Error(`Unknown Whisper model: ${presetId}`);
    const result = await whisperStore.downloadPreset(preset, (progress) =>
      dispatch(setDownloadProgress(progress))
    );
    await dispatch(refreshWhisperModels()).unwrap().catch(() => {});
    return result;
  }
);

export const deleteWhisperModel = createAsyncThunk("dictation/delete", async (name, { dispatch }) => {
  await whisperStore.deleteWhisperModel(name);
  await dispatch(refreshWhisperModels()).unwrap().catch(() => {});
  return name;
});

/** Load a Whisper model into memory (idempotent for the same file). */
export const loadWhisperModel = createAsyncThunk("dictation/load", async ({ path, name } = {}, { getState }) => {
  const current = getState().dictation;
  const target = path || current.path;
  if (!target) throw new Error("No Whisper model is chosen yet - download one in Settings first.");
  await whisper.loadModel(target);
  return { path: target, name: name || current.name || "whisper" };
});

/** What a first tap on the mic downloads: multilingual, same size as base.en. */
export const DEFAULT_PRESET_ID = "base.q5_1";

/** Start listening. Loads the model first if it is not up yet. */
export const startDictation = createAsyncThunk("dictation/start", async (_, { dispatch, getState }) => {
  if (!whisper.isLoaded()) {
    let { path, name } = getState().dictation;

    if (!path) {
      await dispatch(refreshWhisperModels()).unwrap().catch(() => {});
      const installed = getState().dictation.models || [];
      if (installed.length) ({ path, name } = installed[0]);
    }

    // First ever use: fetch a model for the user rather than sending them to
    // Settings. Progress lands in the UI through the download state.
    if (!path) {
      await dispatch(downloadWhisperPreset(DEFAULT_PRESET_ID)).unwrap();
      await dispatch(refreshWhisperModels()).unwrap().catch(() => {});
      const installed = getState().dictation.models || [];
      if (!installed.length) {
        throw new Error("The dictation model could not be installed - check this phone's connection.");
      }
      ({ path, name } = installed[0]);
    }

    if (!path) throw new Error("No Whisper model is installed on this phone yet.");
    await dispatch(loadWhisperModel({ path, name })).unwrap();
  }
  await whisper.startRecording({ onFrame: (frames) => dispatch(setFrames(frames)) });
  return true;
});

/**
 * Stop listening and transcribe what was captured. Resolution is the transcript,
 * so the caller can drop it straight into the composer.
 */
export const stopDictation = createAsyncThunk("dictation/stop", async (_, { dispatch, getState }) => {
  const { chunks, frames, seconds } = whisper.stopRecording();
  dispatch(setCaptured({ frames, seconds }));
  if (!chunks.length) {
    dispatch(setStatus("idle"));
    return { text: "", seconds, frames, empty: true };
  }
  if (!whisper.isLoaded()) {
    dispatch(setStatus("idle"));
    throw new Error("The Whisper model is not loaded, so that recording could not be transcribed.");
  }
  dispatch(setStatus("transcribing"));
  const language = getState().dictation.settings.language;
  const result = await whisper.transcribeRecording(chunks, {
    language,
    onPartial: (text) => dispatch(setLiveText(text)),
  });
  return result;
});

export const cancelDictation = createAsyncThunk("dictation/cancel", async (_, { dispatch }) => {
  whisper.stopRecording();
  dispatch(setStatus("idle"));
  dispatch(setLiveText(""));
  return true;
});

const dictationSlice = createSlice({
  name: "dictation",
  initialState: state,
  reducers: {
    setStatus: (state_, action) => {
      state_.status = action.payload;
      if (action.payload === "recording") {
        state_.error = null;
        state_.liveText = "";
        state_.frames = 0;
        state_.seconds = 0;
      }
    },
    setFrames: (state_, action) => {
      state_.frames = action.payload;
      state_.seconds = action.payload * 0.13;
    },
    setCaptured: (state_, action) => {
      state_.frames = action.payload.frames;
      state_.seconds = action.payload.seconds;
    },
    setLiveText: (state_, action) => {
      state_.liveText = action.payload;
    },
    setDownloadProgress: (state_, action) => {
      state_.progress = action.payload;
    },
    setDictationSettings: (state_, action) => {
      state_.settings = { ...state_.settings, ...action.payload };
    },
    clearDictationError: (state_) => {
      state_.error = null;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(refreshWhisperModels.fulfilled, (state_, action) => {
        state_.models = action.payload || [];
      })
      .addCase(refreshWhisperModels.rejected, (state_, action) => {
        state_.error = String(action.error.message || action.error);
      })
      .addCase(downloadWhisperPreset.pending, (state_, action) => {
        state_.downloading = action.meta.arg;
        state_.progress = 0;
        state_.error = null;
      })
      .addCase(downloadWhisperPreset.fulfilled, (state_, action) => {
        state_.downloading = null;
        state_.progress = 1;
        // First model on the phone becomes the default: dictation should work
        // straight after a download.
        if (!state_.path && action.payload && action.payload.path) {
          state_.path = action.payload.path;
          state_.name = action.payload.name;
        }
      })
      .addCase(downloadWhisperPreset.rejected, (state_, action) => {
        state_.downloading = null;
        state_.progress = 0;
        state_.error = String(action.error.message || action.error);
      })
      .addCase(deleteWhisperModel.fulfilled, (state_, action) => {
        if (state_.name === action.payload) {
          state_.name = null;
          state_.path = null;
          state_.loaded = false;
        }
      })
      .addCase(loadWhisperModel.pending, (state_) => {
        state_.loading = true;
        state_.error = null;
      })
      .addCase(loadWhisperModel.fulfilled, (state_, action) => {
        state_.loading = false;
        state_.loaded = true;
        state_.path = action.payload.path;
        state_.name = action.payload.name;
      })
      .addCase(loadWhisperModel.rejected, (state_, action) => {
        state_.loading = false;
        state_.loaded = false;
        state_.error = String(action.error.message || action.error);
      })
      .addCase(startDictation.pending, (state_) => {
        state_.status = "preparing";
        state_.error = null;
        state_.liveText = "";
      })
      .addCase(startDictation.fulfilled, (state_) => {
        state_.status = "recording";
        state_.liveText = "";
      })
      .addCase(startDictation.rejected, (state_, action) => {
        state_.status = "idle";
        state_.error = String(action.error.message || action.error);
      })
      .addCase(stopDictation.fulfilled, (state_, action) => {
        state_.status = "idle";
        state_.lastText = action.payload.text || "";
        state_.liveText = "";
      })
      .addCase(stopDictation.rejected, (state_, action) => {
        state_.status = "idle";
        state_.liveText = "";
        state_.error = String(action.error.message || action.error);
      });
  },
});

export const {
  setStatus,
  setFrames,
  setCaptured,
  setLiveText,
  setDownloadProgress,
  setDictationSettings,
  clearDictationError,
} = dictationSlice.actions;

export default dictationSlice.reducer;
