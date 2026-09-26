import { configureStore } from "@reduxjs/toolkit";
import { persistStore, persistReducer, createTransform } from "redux-persist";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { DEFAULT_SYSTEM_PROMPT } from "../local/llamaService";
import chatReducer from "../features/chat/chatSlice";
import routerReducer from "../features/router/routerSlice";
import dictationReducer from "../features/dictation/dictationSlice";
import speechReducer from "../features/speech/speechSlice";

// Only user-authored data is written to disk: settings, conversations and the
// local sampling parameters. Everything transient (loading flags, progress,
// errors, model list) is rebuilt from defaults on every launch, so a restart
// can never restore a "half loaded" model.
const LOCAL_TRANSIENT = {
  models: [],
  projectors: [],
  path: null,
  name: null,
  vision: false,
  multimodalError: null,
  ready: false,
  loading: false,
  loadProgress: 0,
  downloadProgress: null,
  downloading: false,
  error: null,
};

const DEFAULT_PARAMS = {
  nCtx: 2048,
  nThreads: 4,
  temperature: 0.7,
  maxTokens: 256,
  topP: 0.95,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
};

const DEFAULT_SETTINGS = {
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o-mini",
  temperature: 0.7,
  maxTokens: 512,
  availableModels: [],
  autoStartServer: true,
};

const chatTransform = createTransform(
  // inbound: what actually gets persisted
  (state) => ({
    settings: state.settings,
    conversations: state.conversations,
    order: state.order,
    currentId: state.currentId,
    mode: state.mode,
    local: {
      params: state.local.params,
      mmprojPath: state.local.mmprojPath || null,
      lastModelPath: state.local.lastModelPath || null,
      lastModelName: state.local.lastModelName || null,
    },
    server: { port: state.server.port, apiKey: state.server.apiKey },
  }),
  // outbound: merge the stored data back over defaults
  (persisted) => ({
    ...persisted,
    settings: { ...DEFAULT_SETTINGS, ...(persisted.settings || {}) },
    conversations: persisted.conversations || {},
    order: persisted.order || [],
    status: "idle",
    error: null,
    api: { fetchingModels: false, testing: false, testResult: null },
    server: {
      running: false,
      starting: false,
      port: (persisted.server && persisted.server.port) || 8080,
      apiKey: (persisted.server && persisted.server.apiKey) || "",
      ip: null,
      error: null,
      log: [],
      stats: { requests: 0, completions: 0 },
    },
    local: {
      ...LOCAL_TRANSIENT,
      mmprojPath: (persisted.local && persisted.local.mmprojPath) || null,
      lastModelPath: (persisted.local && persisted.local.lastModelPath) || null,
      lastModelName: (persisted.local && persisted.local.lastModelName) || null,
      params: { ...DEFAULT_PARAMS, ...((persisted.local && persisted.local.params) || {}) },
    },
  }),
  { whitelist: ["chat"] }
);

// The mesh is remembered between launches: which phones exist, which policy is
// active and whether this node is a coordinator. Transient flags (probe results,
// in-flight counts, logs) restart clean so a stale "busy" can never lock the UI.
const ROUTER_DEFAULTS = {
  coordinator: false,
  policy: "least-busy",
  port: 8080,
  autoDiscover: true,
  scanEverySec: 180,
  nodes: [],
  scanning: false,
  scanProgress: { done: 0, total: 0 },
  rotation: 0,
  log: [],
  error: null,
  lastJob: null,
  batch: null,
  busy: false,
};

const routerTransform = createTransform(
  (state) => ({
    policy: state.policy,
    port: state.port,
    planMode: Boolean(state.planMode),
    // A node that is a coordinator must still be one after a reboot, otherwise
    // an unattended phone silently turns into a plain worker.
    coordinator: Boolean(state.coordinator),
    autoDiscover: state.autoDiscover !== false,
    scanEverySec: state.scanEverySec || ROUTER_DEFAULTS.scanEverySec,
    nodes: (state.nodes || []).map((node) => ({
      id: node.id,
      ip: node.ip,
      port: node.port,
      apiKey: node.apiKey || "",
      self: Boolean(node.self),
      kind: node.kind || "greenmesh-app",
      baseUrl: node.baseUrl || null,
      verified: Boolean(node.verified),
      model: node.model || null,
    })),
  }),
  (persisted) => ({
    ...ROUTER_DEFAULTS,
    policy: persisted.policy || ROUTER_DEFAULTS.policy,
    port: persisted.port || ROUTER_DEFAULTS.port,
    planMode: Boolean(persisted.planMode),
    coordinator: Boolean(persisted.coordinator),
    autoDiscover:
      persisted.autoDiscover === undefined ? ROUTER_DEFAULTS.autoDiscover : Boolean(persisted.autoDiscover),
    scanEverySec: persisted.scanEverySec || ROUTER_DEFAULTS.scanEverySec,
    nodes: (persisted.nodes || []).map((node) => ({
      ...node,
      ok: false,
      latencyMs: null,
      inflight: 0,
      jobs: 0,
      failures: 0,
      lastSeen: null,
      lastError: null,
    })),
  }),
  { whitelist: ["router"] }
);

// Dictation survives a restart as: which Whisper model to use and how the user
// likes it configured. Anything mid-recording restarts clean.
const DICTATION_DEFAULTS = {
  language: "auto",
  autoSend: false,
};

const DICTATION_TRANSIENT = {
  models: [],
  loaded: false,
  loading: false,
  downloading: null,
  progress: 0,
  error: null,
  status: "idle",
  frames: 0,
  seconds: 0,
  liveText: "",
  lastText: "",
};

const dictationTransform = createTransform(
  (state) => ({
    path: state.path || null,
    name: state.name || null,
    settings: state.settings,
  }),
  (persisted) => ({
    ...DICTATION_TRANSIENT,
    path: (persisted && persisted.path) || null,
    name: (persisted && persisted.name) || null,
    settings: { ...DICTATION_DEFAULTS, ...((persisted && persisted.settings) || {}) },
  }),
  // Applied to the dictation key itself, not to individual fields inside it.
  { whitelist: ["dictation"] }
);

// Speech settings survive a restart; what is being spoken does not.
const SPEECH_DEFAULTS = {
  engine: "system",
  voiceId: null,
  rate: 1,
  autoSpeak: false,
};

const SPEECH_TRANSIENT = {
  voices: [],
  downloading: null,
  progress: 0,
  hfRepo: "",
  hfFile: "",
  hfDownloading: false,
  hfResult: null,
  speaking: false,
  error: null,
};

const speechTransform = createTransform(
  (state) => ({ settings: state.settings, hfRepo: state.hfRepo, hfFile: state.hfFile }),
  (persisted) => ({
    ...SPEECH_TRANSIENT,
    settings: { ...SPEECH_DEFAULTS, ...((persisted && persisted.settings) || {}) },
    hfRepo: (persisted && persisted.hfRepo) || "",
    hfFile: (persisted && persisted.hfFile) || "",
  }),
  { whitelist: ["speech"] }
);

const persistConfig = {
  key: "greenmesh-ai-chat",
  version: 1,
  storage: AsyncStorage,
  whitelist: ["chat", "router", "dictation", "speech"],
  transforms: [chatTransform, routerTransform, dictationTransform, speechTransform],
};

const rootReducer = persistReducer(
  persistConfig,
  (state = {}, action) => ({
    chat: chatReducer(state.chat, action),
    router: routerReducer(state.router, action),
    dictation: dictationReducer(state.dictation, action),
    speech: speechReducer(state.speech, action),
  })
);

export const store = configureStore({
  reducer: rootReducer,
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      // redux-persist dispatches its own action types with non-serializable payloads
      serializableCheck: false,
      immutableCheck: false,
    }),
});

export const persistor = persistStore(store);

export { DEFAULT_PARAMS, DEFAULT_SETTINGS };
export default store;
