import { createSlice, createAsyncThunk } from "@reduxjs/toolkit";
import * as registry from "../../router/nodeRegistry";
import * as mesh from "../../router/jobRouter";
import * as planner from "../../router/planner";
import * as agent from "../../router/agent";
import { createMeshApi } from "../../router/meshApi";
import { DEFAULT_API_KEY } from "../../config";
import * as llama from "../../local/llamaService";
import * as whisperStore from "../../local/whisperStore";
import * as whisper from "../../local/whisperService";
import * as server from "../../server/inferenceServer";
import {
  startInferenceServer,
  stopInferenceServer,
  changeServerPort,
  setServerPort,
  loadLocalModel,
  unloadLocalModel,
  updateLocalParams,
  applyServerApiKey,
  downloadLocalModel,
  refreshLocalModels,
  addConversations,
} from "../chat/chatSlice";
import {
  startDictation,
  stopDictation,
  loadWhisperModel,
  downloadWhisperPreset,
  refreshWhisperModels,
} from "../dictation/dictationSlice";
import {
  speakText,
  stopSpeech,
  selectVoice,
  downloadVoice,
  downloadFromHuggingFace,
  refreshVoices,
} from "../speech/speechSlice";

const makeId = (ip, port) => `${ip}:${port}`;

const mergeNode = (existing, fresh) => ({
  id: makeId(fresh.ip, fresh.port),
  ip: fresh.ip,
  port: fresh.port,
  apiKey: fresh.apiKey !== undefined ? fresh.apiKey : existing ? existing.apiKey : "",
  self: Boolean(existing && existing.self) || Boolean(fresh.self),
  kind:
    fresh.kind !== undefined && fresh.kind !== null
      ? fresh.kind
      : existing
      ? existing.kind
      : "greenmesh-app",
  baseUrl: fresh.baseUrl !== undefined ? fresh.baseUrl : existing ? existing.baseUrl : null,
  verified: fresh.verified !== undefined ? fresh.verified : existing ? existing.verified : false,
  model: fresh.model !== undefined && fresh.model !== null ? fresh.model : existing ? existing.model : null,
  models: fresh.models !== undefined && fresh.models !== null ? fresh.models : existing ? existing.models : [],
  vision: fresh.vision !== undefined ? fresh.vision : existing ? existing.vision : false,
  ctx: fresh.ctx !== undefined && fresh.ctx !== null ? fresh.ctx : existing ? existing.ctx : null,
  ok: fresh.ok !== undefined ? fresh.ok : existing ? existing.ok : false,
  latencyMs: fresh.latencyMs !== undefined ? fresh.latencyMs : existing ? existing.latencyMs : null,
  inflight: fresh.load !== undefined && fresh.load !== null ? fresh.load : existing ? existing.inflight : 0,
  jobs: existing ? existing.jobs || 0 : 0,
  failures: existing ? existing.failures || 0 : 0,
  lastSeen: fresh.ok ? Date.now() : existing ? existing.lastSeen : null,
  lastError: fresh.ok ? null : fresh.error || (existing ? existing.lastError : null),
  modelLoaded: fresh.modelLoaded !== undefined ? fresh.modelLoaded : existing ? existing.modelLoaded : true,
});

const pushLogEntry = (state, entry) => {
  state.log = [{ ts: Date.now(), ...entry }, ...state.log].slice(0, 40);
};

/* ---------------------------------- thunks -------------------------------- */

export const scanNodes = createAsyncThunk(
  "router/scanNodes",
  async ({ deep } = {}, { dispatch, getState, rejectWithValue }) => {
    try {
      const { router: routerState } = getState();
      const ip = await registry.localIp();
      if (!ip) return rejectWithValue("No Wi-Fi address - connect the phone to the network first");

      // A deep scan also probes the ports other local AI servers use (Ollama,
      // LM Studio, llama.cpp, vLLM...), so any OpenAI API in the LAN joins.
      const ports = deep ? registry.COMMON_PORTS : [routerState.port];

      const found = await registry.scanSubnet({
        ip,
        port: routerState.port,
        ports,
        onProgress: (done, total) => dispatch(setScanProgress({ done, total })),
      });

      // the phone always knows where it is, even if its own server is off
      const self = await registry.findSelf({ ip, port: routerState.port });
      return { ip, found, self, deep: Boolean(deep) };
    } catch (error) {
      return rejectWithValue(String((error && error.message) || error));
    }
  }
);

export const refreshNodeHealth = createAsyncThunk(
  "router/refreshNodeHealth",
  async (_, { getState, dispatch }) => {
    const { router: routerState } = getState();
    const ip = await registry.localIp();
    const targets = routerState.nodes.length
      ? routerState.nodes
      : ip
      ? [{ ip, port: routerState.port, apiKey: "" }]
      : [];

    const results = [];
    for (const node of targets) {
      const probe = await registry.probeNode({ ip: node.ip, port: node.port, apiKey: node.apiKey });
      results.push({ node, probe });
      dispatch(applyProbe({ ip: node.ip, port: node.port, probe, self: node.ip === ip }));
    }
    return { results, ip };
  }
);

export const addNode = createAsyncThunk("router/addNode", async ({ ip, port, apiKey }, { dispatch }) => {
  const probe = await registry.probeNode({ ip, port: port || registry.DEFAULT_PORT, apiKey: apiKey || "" });
  dispatch(applyProbe({ ip, port: port || registry.DEFAULT_PORT, probe, apiKey: apiKey || "" }));
  return { ip, port, probe };
});

/** One job through the router: the coordinator decides the worker and dispatches. */
export const runRoutedJob = createAsyncThunk(
  "router/runRoutedJob",
  async ({ prompt, messages }, { dispatch, getState, rejectWithValue }) => {
    const state = getState();
    const { local } = state.chat;
    const routerState = state.router;
    const history = messages || [{ role: "user", content: prompt }];

    try {
      let target = null;
      if (routerState.policy === "smart") {
        target = await mesh.smartPick({
          nodes: routerState.nodes,
          messages: history,
          localComplete: local.ready ? llama.complete : null,
          localModelName: local.name,
          localAvailable: local.ready,
          fallback: "least-busy",
          rotation: routerState.rotation,
        });
      } else {
        target = mesh.pickNode({
          nodes: routerState.nodes,
          policy: routerState.policy,
          localAvailable: local.ready,
          rotation: routerState.rotation,
        });
      }

      if (!target) return rejectWithValue("No node is reachable - scan the network first");
      if (target.self && !local.ready) {
        return rejectWithValue(
          "The router picked this phone, but no model is loaded here - load one on the Model tab or pick another policy"
        );
      }

      const started = Date.now();
      let text = null;

      if (target.self && local.ready) {
        text = await llama.complete(history, {
          temperature: local.params.temperature,
          topP: local.params.topP,
          maxTokens: local.params.maxTokens,
          systemPrompt: local.params.systemPrompt,
        });
      } else {
        const answer = await mesh.forwardChat({
          node: target,
          payload: {
            messages: history,
            temperature: local.params.temperature,
            max_tokens: local.params.maxTokens,
          },
        });
        text = answer.text;
      }

      const ms = Date.now() - started;
      dispatch(noteJob({ node: target, ok: true, ms, decidedBy: target.decidedBy || routerState.policy }));
      return { text, node: { ip: target.ip, port: target.port, self: target.self, model: target.model }, ms, decidedBy: target.decidedBy || routerState.policy };
    } catch (error) {
      const detail = String((error && error.message) || error);
      dispatch(noteJob({ node: null, ok: false, error: detail }));
      return rejectWithValue(detail);
    }
  }
);

/** A batch of independent prompts spread over the mesh - the parallel case. */
export const runBatch = createAsyncThunk(
  "router/runBatch",
  async ({ prompts }, { dispatch, getState, rejectWithValue }) => {
    const { router: routerState } = getState();
    try {
      const started = Date.now();
      const results = await mesh.fanOut({
        nodes: routerState.nodes.filter((node) => !node.self),
        prompts,
        policy: routerState.policy,
      });
      dispatch(
        noteJob({
          ok: results.every((row) => row && row.ok),
          ms: Date.now() - started,
          decidedBy: `batch of ${prompts.length}`,
          node: null,
        })
      );
      return results;
    } catch (error) {
      return rejectWithValue(String((error && error.message) || error));
    }
  }
);

/**
 * The planner flow, shared by the UI and the coordinator's HTTP endpoint:
 * plan with the local model, hand every step to a worker with a mesh-aware
 * system prompt, then merge the partial results.
 */
async function runPlanFlow({ goal, format, getState, dispatch, onDelta }) {
  const state = getState();
  const routerState = state.router;
  const { local } = state.chat;
  const localComplete = local.ready ? llama.complete : null;
  let workers = routerState.nodes || [];

  // A node list restored from storage carries ok=false until it is probed, and
  // planning would then fall back to a worker-less coordinator. Probe once.
  const hasUsableRemote = workers.some((node) => !node.self && node.ok !== false);
  if (workers.length && !hasUsableRemote) {
    await dispatch(refreshNodeHealth()).unwrap().catch(() => {});
    workers = getState().router.nodes || [];
  }

  const steps = await planner.planTask({
    goal,
    nodeCount: workers.filter((node) => !node.self).length + 1,
    localComplete,
    format,
  });
  dispatch(setPlan({ goal, steps }));

  const results = await planner.executePlan({
    plan: steps,
    goal,
    nodes: workers,
    coordinator: "this phone",
    format,
    localComplete,
    // Spread the steps: remote workers first, round robin over them; the
    // coordinator keeps the tail so it can merge while they work.
    pickForStep: ({ index }) => {
      const remote = workers.filter((node) => !node.self && node.ok !== false);
      if (remote.length) return remote[index % remote.length];
      return workers.find((node) => node.self) || { self: true };
    },
    remoteStep: ({ node, messages }) =>
      mesh.forwardChat({
        node,
        payload: { messages, temperature: 0.3, max_tokens: 400 },
      }),
    onStep: (record) => dispatch(updatePlanStep(record)),
  });

  const final = await planner.synthesize({ goal, results, localComplete, format });
  dispatch(setPlanFinal(final));
  dispatch(
    noteJob({
      node: null,
      ok: true,
      ms: results.reduce((total, row) => total + (row.ms || 0), 0),
      decidedBy: `plan of ${steps.length} step(s)`,
    })
  );
  if (onDelta && final) onDelta(final);
  return final;
}

export const runPlannedJob = createAsyncThunk(
  "router/runPlannedJob",
  async ({ goal, format }, { dispatch, getState, rejectWithValue }) => {
    if (!goal || !goal.trim()) return rejectWithValue("Nothing to plan");
    try {
      const text = await runPlanFlow({ goal: goal.trim(), format, getState, dispatch });
      return { goal: goal.trim(), text };
    } catch (error) {
      return rejectWithValue(String((error && error.message) || error));
    }
  }
);

/**
 * Model-driven automation: the local model chooses tools (scan, add worker,
 * route, plan, change policy) and the app executes them, step by step.
 */
export const runAgentTask = createAsyncThunk(
  "router/runAgentTask",
  async ({ instruction }, { dispatch, getState, rejectWithValue }) => {
    const { local } = getState().chat;
    if (!instruction || !instruction.trim()) return rejectWithValue("Nothing for the agent to do");
    if (!local.ready) return rejectWithValue("The agent needs a local model on this phone");

    try {
      const result = await agent.runAgent({
        instruction: instruction.trim(),
        localComplete: llama.complete,
        maxSteps: 6,
        onTrace: (record) => dispatch(addAgentTrace(record)),
        ctx: {
          getState,
          dispatch,
          scanNodes,
          addNode,
          removeNode,
          refreshNodeHealth,
          runRoutedJob,
          runPlannedJob,
          setPolicy,
          setPlanMode,
          mesh,
          TOOLS: agent.TOOLS,
        },
      });
      return result;
    } catch (error) {
      return rejectWithValue(String((error && error.message) || error));
    }
  }
);

/* ---------------------------------- slice --------------------------------- */

const initialState = {
  coordinator: false,
  policy: "least-busy",
  port: registry.DEFAULT_PORT,
  nodes: [],
  scanning: false,
  scanProgress: { done: 0, total: 0 },
  rotation: 0,
  log: [],
  error: null,
  lastJob: null,
  batch: null,
  busy: false,
  // Planner mode: the local model splits a request into steps, each step is sent
  // to a worker with a mesh-aware system prompt, then the results are merged.
  planMode: false,
  planGoal: null,
  plan: null,
  planFinal: null,
  planning: false,
  // Automation: keep the mesh fresh by itself - rescan on a timer and trust any
  // OpenAI server that answered the test request.
  autoDiscover: true,
  scanEverySec: 180,
  lastScan: null,
  // Model-driven automation trace
  agentRunning: false,
  agentAnswer: null,
  agentTrace: [],
};

const routerSlice = createSlice({
  name: "router",
  initialState,
  reducers: {
    setPolicy: (state, action) => {
      state.policy = action.payload;
    },
    setRouterPort: (state, action) => {
      state.port = action.payload;
    },
    setCoordinator: (state, action) => {
      state.coordinator = Boolean(action.payload);
    },
    setScanProgress: (state, action) => {
      state.scanProgress = action.payload;
    },
    applyProbe: (state, action) => {
      const { ip, port, probe, apiKey, self } = action.payload;
      const id = makeId(ip, port);
      const existing = state.nodes.find((node) => node.id === id);
      const merged = mergeNode(existing, {
        ip,
        port,
        apiKey,
        self,
        ok: probe.ok,
        kind: probe.kind,
        baseUrl: probe.baseUrl,
        verified: probe.verified,
        model: probe.model,
        models: probe.models,
        vision: probe.vision,
        ctx: probe.ctx,
        latencyMs: probe.latencyMs,
        load: probe.load,
        error: probe.error,
        modelLoaded: probe.modelLoaded,
      });
      if (existing) {
        state.nodes = state.nodes.map((node) => (node.id === id ? merged : node));
      } else {
        state.nodes = [...state.nodes, merged];
      }
    },
    removeNode: (state, action) => {
      state.nodes = state.nodes.filter((node) => node.id !== action.payload);
    },
    clearNodes: (state) => {
      state.nodes = [];
      state.batch = null;
      state.lastJob = null;
    },
    rotate: (state) => {
      state.rotation = (state.rotation + 1) % 1000;
    },
    noteJob: (state, action) => {
      const { node, ok, ms, error, decidedBy } = action.payload;
      if (node) {
        state.nodes = state.nodes.map((item) =>
          item.id === makeId(node.ip, node.port)
            ? {
                ...item,
                jobs: (item.jobs || 0) + (ok ? 1 : 0),
                failures: (item.failures || 0) + (ok ? 0 : 1),
                ok: ok ? item.ok : false,
                lastError: ok ? item.lastError : error || item.lastError,
              }
            : item
        );
      }
      pushLogEntry(state, {
        ok,
        ms,
        error: error || null,
        decidedBy: decidedBy || null,
        node: node ? `${node.ip}:${node.port}` : "mesh",
      });
    },
    clearRouterLog: (state) => {
      state.log = [];
    },
    setRouterError: (state, action) => {
      state.error = action.payload;
    },
    setPlanMode: (state, action) => {
      state.planMode = Boolean(action.payload);
      state.error = null;
    },
    setAutoDiscover: (state, action) => {
      state.autoDiscover = Boolean(action.payload);
    },
    addAgentTrace: (state, action) => {
      state.agentTrace = [...state.agentTrace, action.payload].slice(-12);
    },
    clearAgent: (state) => {
      state.agentTrace = [];
      state.agentAnswer = null;
    },
    setPlan: (state, action) => {
      state.planGoal = action.payload.goal;
      state.plan = action.payload.steps.map((step, index) => ({
        index,
        title: step.title,
        instruction: step.instruction,
        depends_on: step.depends_on || [],
        node: null,
        text: "",
        error: null,
        ms: null,
      }));
      state.planFinal = null;
    },
    updatePlanStep: (state, action) => {
      if (!state.plan) return;
      state.plan = state.plan.map((step, index) =>
        index === action.payload.index ? { ...step, ...action.payload } : step
      );
    },
    setPlanFinal: (state, action) => {
      state.planFinal = action.payload;
    },
    clearPlan: (state) => {
      state.plan = null;
      state.planGoal = null;
      state.planFinal = null;
    },
    clearRouterError: (state) => {
      state.error = null;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(scanNodes.pending, (state) => {
        state.scanning = true;
        state.error = null;
        state.scanProgress = { done: 0, total: 0 };
      })
      .addCase(scanNodes.fulfilled, (state, action) => {
        state.scanning = false;
        const { found, self, ip, deep } = action.payload;
        state.lastScan = Date.now();
        const seen = [];
        [...(found || []), ...(self ? [self] : [])].forEach((node) => {
          const id = makeId(node.ip, node.port);
          if (seen.includes(id)) return;
          seen.push(id);
          const existing = state.nodes.find((item) => item.id === id);
          const merged = mergeNode(existing, {
            ...node,
            // only this app's own listener is "self" - another server on the same
            // phone (say a loopback-tunnelled one) is a separate worker
            self: node.self || (node.ip === ip && node.port === state.port),
          });
          if (existing) {
            state.nodes = state.nodes.map((item) => (item.id === id ? merged : item));
          } else {
            state.nodes = [...state.nodes, merged];
          }
        });
        pushLogEntry(state, {
          ok: true,
          node: "scan",
          ms: null,
          decidedBy: `${(found || []).length} node(s) found${deep ? " (deep)" : ""}, ${
            (found || []).filter((node) => node.verified).length
          } verified`,
        });
      })
      .addCase(scanNodes.rejected, (state, action) => {
        state.scanning = false;
        state.error = action.payload || "Scan failed";
      })

      .addCase(refreshNodeHealth.fulfilled, (state) => {
        state.error = null;
      })

      .addCase(runRoutedJob.pending, (state) => {
        state.busy = true;
        state.error = null;
      })
      .addCase(runRoutedJob.fulfilled, (state, action) => {
        state.busy = false;
        state.lastJob = action.payload;
        state.rotation = (state.rotation + 1) % 1000;
      })
      .addCase(runRoutedJob.rejected, (state, action) => {
        state.busy = false;
        state.error = action.payload || "Job failed";
      })

      .addCase(runBatch.pending, (state) => {
        state.busy = true;
        state.error = null;
        state.batch = null;
      })
      .addCase(runBatch.fulfilled, (state, action) => {
        state.busy = false;
        state.batch = action.payload;
      })
      .addCase(runBatch.rejected, (state, action) => {
        state.busy = false;
        state.error = action.payload || "Batch failed";
      })

      .addCase(runPlannedJob.pending, (state) => {
        state.planning = true;
        state.error = null;
      })
      .addCase(runPlannedJob.fulfilled, (state, action) => {
        state.planning = false;
        state.planFinal = action.payload.text;
        state.rotation = (state.rotation + 1) % 1000;
      })
      .addCase(runPlannedJob.rejected, (state, action) => {
        state.planning = false;
        state.error = action.payload || "Planning failed";
      })

      .addCase(runAgentTask.pending, (state) => {
        state.agentRunning = true;
        state.error = null;
        state.agentTrace = [];
        state.agentAnswer = null;
      })
      .addCase(runAgentTask.fulfilled, (state, action) => {
        state.agentRunning = false;
        state.agentAnswer = action.payload.answer;
      })
      .addCase(runAgentTask.rejected, (state, action) => {
        state.agentRunning = false;
        state.error = action.payload || "The agent failed";
      });
  },
});

export const {
  setPolicy,
  setRouterPort,
  setCoordinator,
  setScanProgress,
  applyProbe,
  removeNode,
  clearNodes,
  rotate,
  noteJob,
  clearRouterLog,
  setRouterError,
  clearRouterError,
  setPlanMode,
  setPlan,
  updatePlanStep,
  setPlanFinal,
  clearPlan,
  setAutoDiscover,
  addAgentTrace,
  clearAgent,
} = routerSlice.actions;

/**
 * Wire the app's own HTTP server to the mesh. With coordination on, an incoming
 * /v1/chat/completions is routed to whichever phone should run it instead of
 * always using the local model.
 */
export const installRouterHandler = () => (dispatch, getState) => {
  server.setRouterHandler(async ({ payload, onDelta }) => {
    const state = getState();
    const routerState = state.router;
    const { local } = state.chat;
    const messages = Array.isArray(payload.messages) ? payload.messages : [];

    // Planner mode: this phone thinks, splits the job, farms the steps out and
    // merges the answers. Single-node mode: just pick a worker.
    if (routerState.planMode) {
      const goal = mesh.lastUserText(messages) || "Answer the request.";
      return runPlanFlow({ goal, getState, dispatch, onDelta });
    }

    let target = null;
    if (routerState.policy === "smart") {
      target = await mesh.smartPick({
        nodes: routerState.nodes,
        messages,
        localComplete: local.ready ? llama.complete : null,
        localAvailable: local.ready,
        fallback: "least-busy",
        rotation: routerState.rotation,
      });
    } else {
      target = mesh.pickNode({
        nodes: routerState.nodes,
        policy: routerState.policy,
        requestedModel: payload.model,
        localAvailable: local.ready,
        rotation: routerState.rotation,
      });
    }

    if (!target) throw new Error("No worker available in the mesh");
    if (target.self && !local.ready) {
      throw new Error("This phone was chosen as the worker but has no model loaded");
    }

    const started = Date.now();
    let text = null;

    if (target.self && local.ready) {
      text = await llama.complete(messages, {
        temperature: typeof payload.temperature === "number" ? payload.temperature : undefined,
        maxTokens: payload.max_tokens || payload.n_predict || undefined,
        onToken: onDelta,
      });
    } else {
      const answer = await mesh.forwardChat({
        node: target,
        payload: {
          messages,
          temperature: typeof payload.temperature === "number" ? payload.temperature : undefined,
          max_tokens: payload.max_tokens || payload.n_predict || undefined,
        },
        onDelta,
      });
      text = answer.text;
    }

    dispatch(
      noteJob({
        node: { ip: target.ip, port: target.port },
        ok: true,
        ms: Date.now() - started,
        decidedBy: target.decidedBy || routerState.policy,
      })
    );
    return text;
  });
  return true;
};

export const uninstallRouterHandler = () => () => {
  server.setRouterHandler(null);
  return true;
};

/**
 * Install the remote control API (/v1/mesh/*). Kept separate from coordinator
 * mode: a node can be driven remotely without routing other people's jobs.
 */
export const installMeshApi = () => (dispatch, getState) => {
  server.setMeshApi(
    createMeshApi({
      getState,
      dispatch,
      api: {
        // mesh
        scanNodes,
        addNode,
        removeNode,
        setPolicy,
        setPlanMode,
        // model lifecycle
        loadLocalModel,
        unloadLocalModel,
        updateLocalParams,
        // server lifecycle
        startInferenceServer,
        stopInferenceServer,
        changeServerPort,
        setServerPort,
        applyServerApiKey,
        // jobs
        // runPlanFlow is a plain function, not a thunk: it needs the store
        // accessors bound here, otherwise the remote /v1/mesh/plan call fails.
        runPlanFlow: ({ goal, format }) => runPlanFlow({ goal, format, getState, dispatch }),
        runAgentTask,
        runBatch,
        // downloads
        downloadLocalModel,
        refreshLocalModels,
        // coordinator
        setCoordinator,
        installRouterHandler,
        uninstallRouterHandler,
        // chats
        addConversations,
        // dictation
        startDictation,
        stopDictation,
        loadWhisperModel,
        downloadWhisperPreset,
        refreshWhisperModels,
        whisperPresets: whisperStore.PRESETS,
        transcribeFile: whisper.transcribeRecording,
        whisperService: whisper,
        // speech (TTS) + hugging face downloads
        speakText,
        stopSpeech,
        selectVoice,
        downloadVoice,
        downloadFromHuggingFace,
        refreshVoices,
        // read-only helpers
        getRequestLog: server.getRequestLog,
        tools: agent.TOOLS,
      },
    })
  );
  return true;
};

export const uninstallMeshApi = () => () => {
  server.setMeshApi(null);
  return true;
};

export default routerSlice.reducer;
