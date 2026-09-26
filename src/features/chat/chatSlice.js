import { createSlice, createAsyncThunk } from "@reduxjs/toolkit";
import * as Network from "expo-network";
import { chatCompletion, listModels, ping } from "../../api/openAiApi";
import * as llama from "../../local/llamaService";
import * as modelStore from "../../local/modelStore";
import { DEFAULT_SYSTEM_PROMPT } from "../../local/llamaService";
import * as server from "../../server/inferenceServer";
import * as keepAwake from "../../server/keepAwake";
import { DEFAULT_API_KEY } from "../../config";
import { mergeConversations, parseAny } from "./transfer";
import { pickTextFile, writeExportFile } from "./transferFiles";

const NETWORK_HINT =
  "Network error: check the API address, whether the server is reachable and that the phone has internet.";

const failureDetail = (error) => {
  if (error && error.response && error.response.data) return JSON.stringify(error.response.data);
  if (error && error.message === "Network Error") return NETWORK_HINT;
  return (error && error.message) || "Unknown error";
};

const makeId = () => `conv-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

/* --------------------------- Remote (OpenAI-compatible) -------------------- */

export const sendMessage = createAsyncThunk(
  "chat/sendMessage",
  async ({ conversationId, messages }, { getState, rejectWithValue }) => {
    try {
      const { settings } = getState().chat;
      const content = await chatCompletion({
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        model: settings.model,
        messages,
        temperature: settings.temperature,
        maxTokens: settings.maxTokens,
      });
      return { conversationId, content };
    } catch (error) {
      return rejectWithValue(failureDetail(error));
    }
  }
);

export const fetchModels = createAsyncThunk(
  "chat/fetchModels",
  async (_, { getState, rejectWithValue }) => {
    try {
      const { settings } = getState().chat;
      return await listModels({ apiKey: settings.apiKey, baseUrl: settings.baseUrl });
    } catch (error) {
      return rejectWithValue(failureDetail(error));
    }
  }
);

export const testConnection = createAsyncThunk("chat/testConnection", async (_, { getState }) => {
  const { settings } = getState().chat;
  return await ping({ apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.model });
});

/* ------------------------------ Local (llama.cpp) -------------------------- */

export const loadLocalModel = createAsyncThunk(
  "chat/loadLocalModel",
  async ({ path, name, mmprojPath }, { dispatch, getState, rejectWithValue }) => {
    try {
      const { local } = getState().chat;
      let files = null;
      try {
        files = await modelStore.listGgufFiles();
      } catch (error) {
        files = null;
      }

      // Photos need an mmproj projector. An explicit choice wins, then the one
      // already selected in the UI, then a name match against the model.
      let projector = mmprojPath || local.mmprojPath || null;
      if (projector && files && !files.some((file) => file.path === projector)) projector = null;
      if (!projector && files) {
        const guessed = modelStore.guessProjector(name || path, files);
        projector = guessed ? guessed.path : null;
      }

      await llama.loadModel(
        path,
        {
          nCtx: local.params.nCtx,
          nThreads: local.params.nThreads,
          systemPrompt: local.params.systemPrompt,
          mmprojPath: projector,
        },
        (progress) => dispatch(setLocalLoadProgress(progress))
      );
      server.setServerModelName(name);
      const info = llama.getMultimodalInfo();
      server.setHealthInfo({ model: name, n_ctx: local.params.nCtx, vision: Boolean(info.vision) });
      const config = llama.getLoadedConfig() || {};
      return {
        path,
        name,
        mmprojPath: projector,
        vision: Boolean(info.vision),
        multimodalError: config.multimodalError || null,
      };
    } catch (error) {
      const detail = failureDetail(error);
      return rejectWithValue(
        /unknown model architecture|unsupported/i.test(detail)
          ? `Unsupported model architecture: ${detail}`
          : detail
      );
    }
  }
);

export const unloadLocalModel = createAsyncThunk("chat/unloadLocalModel", async () => {
  await llama.unloadModel();
  server.setServerModelName(null);
  return true;
});

export const refreshLocalModels = createAsyncThunk("chat/refreshLocalModels", async () => {
  const files = await modelStore.listGgufFiles();
  return {
    models: files.filter((file) => !file.isProjector),
    projectors: files.filter((file) => file.isProjector),
  };
});

/**
 * Download a preset: the model, and its projector when the preset has one, so
 * photo input works the moment the model is loaded.
 */
export const downloadModelPreset = createAsyncThunk(
  "chat/downloadModelPreset",
  async ({ url, mmprojUrl }, { dispatch, rejectWithValue }) => {
    try {
      const file = await modelStore.downloadModel(url, modelStore.fileNameFromUrl(url), (progress) =>
        dispatch(setDownloadProgress(progress))
      );
      let projector = null;
      if (mmprojUrl) {
        projector = await modelStore.downloadModel(
          mmprojUrl,
          modelStore.fileNameFromUrl(mmprojUrl),
          (progress) => dispatch(setDownloadProgress(progress))
        );
      }
      return { model: file, projector };
    } catch (error) {
      return rejectWithValue(failureDetail(error));
    }
  }
);

export const downloadLocalModel = createAsyncThunk(
  "chat/downloadLocalModel",
  async ({ url, name }, { dispatch, rejectWithValue }) => {
    try {
      const fileName = name || modelStore.fileNameFromUrl(url);
      return await modelStore.downloadModel(url, fileName, (progress) =>
        dispatch(setDownloadProgress(progress))
      );
    } catch (error) {
      return rejectWithValue(failureDetail(error));
    }
  }
);

export const deleteLocalModel = createAsyncThunk(
  "chat/deleteLocalModel",
  async ({ path }, { dispatch, getState }) => {
    const { local } = getState().chat;
    if (local.path === path && local.ready) {
      await llama.unloadModel();
      server.setServerModelName(null);
      server.setHealthInfo({ model: null, vision: false });
      dispatch(localUnloaded());
    }
    await modelStore.deleteModel(path);
    dispatch(refreshLocalModels());
    return path;
  }
);

/* ------------------------- Inference server (this phone) -------------------- */

export const startInferenceServer = createAsyncThunk(
  "chat/startInferenceServer",
  async (_, { getState, rejectWithValue }) => {
    try {
      const { server: serverState } = getState().chat;
      await server.startServer({ port: serverState.port, apiKey: serverState.apiKey });
      // Hold a wake lock so doze cannot silence the node mid-job.
      keepAwake.startServingNotification();
      const ip = await Network.getIpAddressAsync().catch(() => null);
      return { port: serverState.port, ip: ip || null };
    } catch (error) {
      return rejectWithValue(
        `${failureDetail(error)} (port ${getState().chat.server.port} may be in use)`
      );
    }
  }
);

/**
 * Export chats to a file (JSON Lines by default) and open the share sheet.
 * Without `conversationId` the whole history goes out.
 */
export const exportChats = createAsyncThunk(
  "chat/exportChats",
  async ({ format = "jsonl", conversationId = null, share = true } = {}, { getState }) => {
    const state = getState().chat;
    const all = (state.order || []).map((id) => state.conversations[id]).filter(Boolean);
    const chosen = conversationId ? all.filter((conversation) => conversation.id === conversationId) : all;
    if (chosen.length === 0) throw new Error("There are no chats to export.");
    return writeExportFile(chosen, format, { share, suffix: conversationId ? "-1" : "" });
  }
);

/**
 * Import chats: pick a file, work out which format it is, merge it in. Chats
 * already present (same title and opening message) are skipped, not duplicated.
 */
export const importChats = createAsyncThunk("chat/importChats", async (_, { dispatch, getState }) => {
  const picked = await pickTextFile();
  if (picked.canceled) return { canceled: true };

  const parsed = parseAny(picked.text);
  if (parsed.error) throw new Error(`Could not read ${picked.name}: ${parsed.error}`);

  const state = getState().chat;
  const existing = (state.order || []).map((id) => state.conversations[id]).filter(Boolean);
  const added = mergeConversations(existing, parsed.conversations);
  if (added.length) dispatch(chatSlice.actions.addConversations(added));

  return {
    imported: added.length,
    skipped: parsed.conversations.length - added.length,
    format: parsed.format,
    file: picked.name,
  };
});

export const stopInferenceServer = createAsyncThunk("chat/stopInferenceServer", async () => {
  await server.stopServer();
  // Deliberately NOT stopping the keep-alive service here: a node whose
  // listener is down must stay unfrozen (foreground service) so it can heal
  // itself. Turning the node off is an explicit act - the notification's "Stop
  // serving" action, or the Settings toggle.
  return true;
});

/** Apply a new required key; takes effect on the running listener immediately. */
export const applyServerApiKey = createAsyncThunk(
  "chat/applyServerApiKey",
  async (value, { dispatch }) => {
    server.setRequiredApiKey(value);
    dispatch(setServerApiKey(value));
    return value;
  }
);

/** Change the port; if the server is running it is restarted on the new port. */
export const changeServerPort = createAsyncThunk(
  "chat/changeServerPort",
  async (port, { getState, dispatch, rejectWithValue }) => {
    const { server: serverState } = getState().chat;
    dispatch(setServerPort(port));
    if (!serverState.running) return { port, restarted: false };
    try {
      await server.stopServer();
      await server.startServer({ port, apiKey: serverState.apiKey });
      return { port, restarted: true };
    } catch (error) {
      return rejectWithValue(`Could not restart on port ${port}: ${failureDetail(error)}`);
    }
  }
);

export const refreshServerStatus = createAsyncThunk("chat/refreshServerStatus", async () => {
  const ip = await Network.getIpAddressAsync().catch(() => null);
  return { ip: ip || null, log: server.getRequestLog(), stats: server.getStats() };
});

/* --------------------------------- Slice ---------------------------------- */

const initialState = {
  settings: {
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-4o-mini",
    temperature: 0.7,
    maxTokens: 512,
    availableModels: [],
    autoStartServer: true,
    // Load the model this phone used last, as soon as the app comes up: a node
    // that reboots empty answers 503 until a human presses Load.
    autoLoadModel: true,
  },
  mode: "api",
  conversations: {},
  order: [],
  currentId: null,
  status: "idle",
  error: null,
  api: { fetchingModels: false, testing: false, testResult: null },
  server: {
    running: false,
    starting: false,
    port: 8080,
    apiKey: "",
    ip: null,
    error: null,
    log: [],
    stats: { requests: 0, completions: 0 },
  },
  local: {
    models: [],
    projectors: [],
    path: null,
    name: null,
    mmprojPath: null,
    vision: false,
    multimodalError: null,
    // Remembered so a node can bring itself back after a reboot or an app update
    // without anyone touching the phone.
    lastModelPath: null,
    lastModelName: null,
    ready: false,
    loading: false,
    loadProgress: 0,
    downloadProgress: null,
    downloading: false,
    error: null,
    params: {
      nCtx: 2048,
      nThreads: 4,
      temperature: 0.7,
      maxTokens: 256,
      topP: 0.95,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
    },
  },
};

const chatSlice = createSlice({
  name: "chat",
  initialState,
  reducers: {
    updateSettings: (state, action) => {
      state.settings = { ...state.settings, ...action.payload };
    },
    updateLocalParams: (state, action) => {
      state.local.params = { ...state.local.params, ...action.payload };
    },
    setMode: (state, action) => {
      state.mode = action.payload;
      state.error = null;
    },
    openConversation: (state, action) => {
      state.currentId = action.payload;
    },
    backToList: (state) => {
      state.currentId = null;
    },
    newConversation: (state) => {
      const id = makeId();
      state.conversations[id] = {
        id,
        title: "New chat",
        messages: [],
        createdAt: Date.now(),
      };
      state.order.unshift(id);
      state.currentId = id;
      state.error = null;
    },
    /**
     * Chats arriving from an import. Ids and timestamps are minted by the caller
     * (transfer.mergeConversations) so nothing collides with what is stored.
     */
    addConversations: (state, action) => {
      const incoming = Array.isArray(action.payload) ? action.payload : [];
      for (const conversation of incoming) {
        if (!conversation || !conversation.id) continue;
        state.conversations[conversation.id] = {
          id: conversation.id,
          title: conversation.title || "Imported chat",
          messages: conversation.messages || [],
          createdAt: conversation.createdAt || Date.now(),
        };
        state.order.unshift(conversation.id);
      }
      state.error = null;
    },
    deleteConversation: (state, action) => {
      const id = action.payload;
      delete state.conversations[id];
      state.order = state.order.filter((item) => item !== id);
      if (state.currentId === id) state.currentId = null;
    },
    renameConversation: (state, action) => {
      const { id, title } = action.payload;
      const conversation = state.conversations[id];
      if (conversation) conversation.title = title || conversation.title;
    },
    clearAllConversations: (state) => {
      state.conversations = {};
      state.order = [];
      state.currentId = null;
    },
    addUserMessage: (state, action) => {
      const { id, content, image } = action.payload;
      const conversation = state.conversations[id];
      if (!conversation) return;
      conversation.messages.push({
        role: "user",
        content: content || "",
        image: image || null,
        ts: Date.now(),
      });
      if (conversation.messages.length === 1) {
        const title = (content && content.trim()) || (image ? "Photo" : "New chat");
        conversation.title = title.slice(0, 40);
      }
      state.error = null;
    },
    beginAssistantMessage: (state, action) => {
      const conversation = state.conversations[action.payload];
      if (conversation) conversation.messages.push({ role: "assistant", content: "", ts: Date.now() });
    },
    updateAssistantMessage: (state, action) => {
      const { id, content } = action.payload;
      const conversation = state.conversations[id];
      if (!conversation) return;
      const last = conversation.messages[conversation.messages.length - 1];
      if (last && last.role === "assistant") last.content = content;
    },
    dropEmptyAssistantMessage: (state, action) => {
      const conversation = state.conversations[action.payload];
      if (!conversation) return;
      const last = conversation.messages[conversation.messages.length - 1];
      if (last && last.role === "assistant" && !last.content) conversation.messages.pop();
    },
    setError: (state, action) => {
      state.error = action.payload;
      state.status = action.payload ? "error" : "idle";
    },
    clearError: (state) => {
      state.error = null;
      state.status = "idle";
    },
    setLocalLoadProgress: (state, action) => {
      state.local.loadProgress = action.payload;
    },
    setDownloadProgress: (state, action) => {
      state.local.downloadProgress = action.payload;
    },
    localUnloaded: (state) => {
      state.local.ready = false;
      state.local.path = null;
      state.local.name = null;
      state.local.vision = false;
      state.local.multimodalError = null;
      state.local.loadProgress = 0;
    },
    setLocalProjector: (state, action) => {
      state.local.mmprojPath = action.payload || null;
      state.local.multimodalError = null;
    },
    clearMultimodalError: (state) => {
      state.local.multimodalError = null;
    },
    clearLocalError: (state) => {
      state.local.error = null;
    },
    setServerPort: (state, action) => {
      state.server.port = action.payload;
    },
    setServerApiKey: (state, action) => {
      state.server.apiKey = action.payload;
    },
    clearServerError: (state) => {
      state.server.error = null;
    },
    clearServerLog: (state) => {
      state.server.log = [];
    },
    resetUserData: (state) => {
      state.settings = { ...initialState.settings };
      state.conversations = {};
      state.order = [];
      state.currentId = null;
      state.mode = "api";
      state.local.params = { ...initialState.local.params };
      state.error = null;
      state.status = "idle";
      state.api = { fetchingModels: false, testing: false, testResult: null };
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(sendMessage.pending, (state) => {
        state.status = "loading";
        state.error = null;
      })
      .addCase(sendMessage.fulfilled, (state, action) => {
        state.status = "idle";
        const { conversationId, content } = action.payload;
        const conversation = state.conversations[conversationId];
        if (conversation) conversation.messages.push({ role: "assistant", content, ts: Date.now() });
      })
      .addCase(sendMessage.rejected, (state, action) => {
        state.status = "error";
        state.error = action.payload || "Unknown error";
      })

      .addCase(fetchModels.pending, (state) => {
        state.api.fetchingModels = true;
        state.error = null;
      })
      .addCase(fetchModels.fulfilled, (state, action) => {
        state.api.fetchingModels = false;
        state.settings.availableModels = action.payload;
        if (!action.payload.length) state.error = "The endpoint returned no models";
      })
      .addCase(fetchModels.rejected, (state, action) => {
        state.api.fetchingModels = false;
        state.error = action.payload || "Could not fetch the model list";
      })

      .addCase(testConnection.pending, (state) => {
        state.api.testing = true;
        state.api.testResult = null;
      })
      .addCase(testConnection.fulfilled, (state, action) => {
        state.api.testing = false;
        state.api.testResult = action.payload;
      })
      .addCase(testConnection.rejected, (state, action) => {
        state.api.testing = false;
        state.api.testResult = { ok: false, error: action.error.message };
      })

      .addCase(loadLocalModel.pending, (state) => {
        state.local.loading = true;
        state.local.ready = false;
        state.local.error = null;
        state.local.loadProgress = 0;
      })
      .addCase(loadLocalModel.fulfilled, (state, action) => {
        state.local.loading = false;
        state.local.ready = true;
        state.local.path = action.payload.path;
        state.local.name = action.payload.name;
        state.local.mmprojPath = action.payload.mmprojPath || null;
        state.local.vision = Boolean(action.payload.vision);
        state.local.multimodalError = action.payload.multimodalError || null;
        // remember what to reload on the next boot
        state.local.lastModelPath = action.payload.path;
        state.local.lastModelName = action.payload.name;
        state.local.loadProgress = 1;
      })
      .addCase(loadLocalModel.rejected, (state, action) => {
        state.local.loading = false;
        state.local.ready = false;
        state.local.error = action.payload || "Could not load the model";
      })

      .addCase(unloadLocalModel.fulfilled, (state) => {
        state.local.ready = false;
        state.local.path = null;
        state.local.name = null;
        state.local.loadProgress = 0;
      })

      .addCase(refreshLocalModels.fulfilled, (state, action) => {
        const { models, projectors } = action.payload || {};
        state.local.models = models || [];
        state.local.projectors = projectors || [];
        // a deleted projector must not stay selected
        if (
          state.local.mmprojPath &&
          !state.local.projectors.some((file) => file.path === state.local.mmprojPath)
        ) {
          state.local.mmprojPath = null;
          state.local.vision = false;
        }
      })
      .addCase(refreshLocalModels.rejected, (state, action) => {
        state.local.error = action.error.message || "Could not read the model list";
      })

      .addCase(downloadLocalModel.pending, (state) => {
        state.local.downloading = true;
        state.local.downloadProgress = 0;
        state.local.error = null;
      })
      .addCase(downloadLocalModel.fulfilled, (state) => {
        state.local.downloading = false;
        state.local.downloadProgress = 1;
      })
      .addCase(downloadLocalModel.rejected, (state, action) => {
        state.local.downloading = false;
        state.local.downloadProgress = null;
        state.local.error = action.payload || "Download failed";
      })

      .addCase(downloadModelPreset.pending, (state) => {
        state.local.downloading = true;
        state.local.downloadProgress = 0;
        state.local.error = null;
      })
      .addCase(downloadModelPreset.fulfilled, (state, action) => {
        state.local.downloading = false;
        state.local.downloadProgress = 1;
        // pre-select the projector that came with the preset
        if (action.payload.projector) state.local.mmprojPath = action.payload.projector.path;
      })
      .addCase(downloadModelPreset.rejected, (state, action) => {
        state.local.downloading = false;
        state.local.downloadProgress = null;
        state.local.error = action.payload || "Download failed";
      })

      .addCase(startInferenceServer.pending, (state) => {
        state.server.starting = true;
        state.server.error = null;
      })
      .addCase(startInferenceServer.fulfilled, (state, action) => {
        state.server.starting = false;
        state.server.running = true;
        state.server.port = action.payload.port;
        state.server.ip = action.payload.ip;
      })
      .addCase(startInferenceServer.rejected, (state, action) => {
        state.server.starting = false;
        state.server.running = false;
        state.server.error = action.payload || "Could not start the server";
      })

      .addCase(stopInferenceServer.fulfilled, (state) => {
        state.server.running = false;
      })

      .addCase(changeServerPort.fulfilled, (state, action) => {
        state.server.running = Boolean(action.payload.restarted) || state.server.running;
        state.server.port = action.payload.port;
        state.server.error = null;
      })
      .addCase(changeServerPort.rejected, (state, action) => {
        state.server.error = action.payload || "Could not change the port";
      })

      .addCase(refreshServerStatus.fulfilled, (state, action) => {
        state.server.ip = action.payload.ip;
        state.server.log = action.payload.log;
        state.server.stats = action.payload.stats;
      });
  },
});

export const {
  updateSettings,
  updateLocalParams,
  setMode,
  openConversation,
  backToList,
  newConversation,
  deleteConversation,
  renameConversation,
  clearAllConversations,
  addUserMessage,
  beginAssistantMessage,
  updateAssistantMessage,
  dropEmptyAssistantMessage,
  setError,
  clearError,
  setLocalLoadProgress,
  setDownloadProgress,
  localUnloaded,
  clearLocalError,
  setLocalProjector,
  clearMultimodalError,
  addConversations,
  setServerPort,
  setServerApiKey,
  clearServerError,
  clearServerLog,
  resetUserData,
} = chatSlice.actions;

export default chatSlice.reducer;
