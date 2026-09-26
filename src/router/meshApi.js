/**
 * Remote control API for one node of the mesh.
 *
 * Everything the Router tab can do by hand is exposed over HTTP under /v1/mesh,
 * so a planner can live somewhere else entirely - GreenMesh on a laptop, another
 * phone, a cron job, any third-party script - and still drive this node:
 *
 *   GET    /v1/mesh/status          node + model + server state, current params
 *   GET    /v1/mesh/nodes           workers in the mesh (peer keys redacted)
 *   POST   /v1/mesh/scan            {deep?} sweep the Wi-Fi for OpenAI servers
 *   POST   /v1/mesh/nodes           {ip, port?, key?} test + add one worker
 *   DELETE /v1/mesh/nodes           {id | ip} drop a worker
 *   GET    /v1/mesh/params          current on-device + server parameters
 *   POST   /v1/mesh/params          change them (reloads/restarts as needed)
 *   POST   /v1/mesh/model/load      {name?} load a downloaded model
 *   POST   /v1/mesh/model/unload    free the model
 *   POST   /v1/mesh/model/reload    reload the current model with current params
 *   POST   /v1/mesh/server/start    start the listener
 *   POST   /v1/mesh/server/stop     stop the listener
 *   POST   /v1/mesh/server/restart  {port?} restart, optionally on a new port
 *   GET    /v1/mesh/device          thermals, battery, paused state
 *   POST   /v1/mesh/node/restart    kill and relaunch the app (self-healing)
 *   POST   /v1/mesh/node/awake      re-assert the foreground service + locks
 *   POST   /v1/mesh/thermal         {enabled} turn the thermal guard on/off
 *   POST   /v1/mesh/keepalive       {ask:"battery"|"autostart"} open the OS screens
 *   GET    /v1/mesh/chats           chat list (id, title, message count)
 *   POST   /v1/mesh/chats/export    {format} -> {name, content} for backup
 *   POST   /v1/mesh/chats/import    {content} merge chats in from a laptop
 *   GET    /v1/mesh/dictation       Whisper model state, presets, installed
 *   POST   /v1/mesh/dictation/model {preset|name} install and load a Whisper model
 *   POST   /v1/mesh/dictation/transcribe {path} transcribe a 16k mono WAV
 *   GET    /v1/mesh/log             recent request log
 *   GET    /v1/mesh/tools           the tools the coordinator model may call
 *   POST   /v1/mesh/policy         {policy} routing policy
 *   POST   /v1/mesh/planner        {on} planner mode on/off
 *   POST   /v1/mesh/plan           {goal, format?} plan, dispatch steps, merge
 *   POST   /v1/mesh/agent          {instruction} let the model pick tools
 *   POST   /v1/mesh/jobs           {prompts[]} fan a batch over the workers
 *
 * Auth is the same bearer key as /v1/chat/completions (a shared default key on
 * fresh installs, changeable on the Server tab or remotely). Nothing here can
 * execute arbitrary code or reach outside the local network.
 */

import { getStats as liveNodeStats } from "../server/inferenceServer";
import { DEFAULT_API_KEY } from "../config";
import * as keepAwake from "../server/keepAwake";
import * as thermals from "../server/thermals";
import { mergeConversations, parseAny, renderExport } from "../features/chat/transfer";
import * as whisperStore from "../local/whisperStore";
import * as hf from "../local/hfStore";
import * as log from "../server/eventLog";

const NUMERIC = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const publicNode = (node) => ({
  id: node.id,
  ip: node.ip,
  port: node.port,
  kind: node.kind || "greenmesh-app",
  baseUrl: node.baseUrl || null,
  self: Boolean(node.self),
  model: node.model || null,
  verified: Boolean(node.verified),
  ok: node.ok !== false,
  vision: Boolean(node.vision),
  latencyMs: node.latencyMs || null,
  inflight: node.inflight || 0,
  jobs: node.jobs || 0,
  failures: node.failures || 0,
  lastError: node.lastError || null,
});

export function createMeshApi({ getState, dispatch, api }) {
  const nodesOf = () => (getState().router.nodes || []).map(publicNode);

  return async function handleMeshApi({ method, path, payload = {} }) {
    const state = getState();
    const { local, server: serverState } = state.chat;
    const routerState = state.router;
    const route = path.replace(/\/+$/, "");
    const key = `${method} ${route}`;

    switch (key) {
      /* -------------------------------- status ------------------------------ */
      case "GET /v1/mesh/status":
        return {
          node: {
            ip: serverState.ip,
            port: serverState.port,
            serverRunning: serverState.running,
            // Live counters. serverState.stats is only refreshed when a screen
            // polls it, so an unattended node reported zeros while it was in fact
            // serving completions - an operator could not tell idle from busy.
            requests: liveNodeStats().requests,
            completions: liveNodeStats().completions,
          },
          model: {
            name: local.name,
            path: local.path,
            loaded: local.ready,
            loading: local.loading,
            vision: Boolean(local.vision),
            projector: local.mmprojPath || null,
            // What this node would load on its next start - the thing that makes
            // unattended recovery possible, so operators can see it.
            remembered: local.lastModelName || local.lastModelPath || null,
          },
          params: local.params,
          router: {
            coordinator: routerState.coordinator,
            policy: routerState.policy,
            plannerMode: routerState.planMode,
            autoDiscover: routerState.autoDiscover,
            nodes: (routerState.nodes || []).length,
          },
          // A remote planner can see whether this phone can take work and why not.
          device: thermals.getSummary(),
          now: Date.now(),
        };

      case "GET /v1/mesh/device": {
        await thermals.refresh();
        return {
          device: thermals.getSummary(),
          pending: await keepAwake.isBatteryExempt(),
          serving: keepAwake.isAvailable(),
        };
      }

      /**
       * Restart this node. Soft by default, on purpose.
       *
       * A soft restart tears the node down and brings it back inside one JS
       * runtime: stop the listener, drop and reload the model, start the
       * listener again, re-assert the foreground service. That recovers the
       * things that actually go wrong (a wedged server, an empty model) and
       * cannot fail because of an OS rule.
       *
       * hard:true kills the whole process instead. That is the true "reboot" but
       * it depends on the alarm/boot receiver relaunching the app, which Android
       * may refuse while the phone is idle (background activity launch limits),
       * so it comes back when the alarm fires rather than instantly.
       */
      case "POST /v1/mesh/node/restart": {
        const hard = payload.hard === true;
        if (hard) {
          const delay = Math.max(0, Math.min(60, NUMERIC(payload.delay) || 1));
          if (delay > 0) setTimeout(() => keepAwake.restartApp(), delay * 1000);
          else keepAwake.restartApp();
          return { restarting: true, mode: "hard", inSeconds: delay };
        }

        // Note: deliberately NOT touching the coordinator role - restarting a
        // node must never silently demote it to a plain worker.
        await dispatch(api.stopInferenceServer()).unwrap().catch(() => {});
        const before = getState().chat.local || {};
        const path = before.lastModelPath || before.path;
        if (path) {
          await dispatch(api.loadLocalModel({ path, name: before.lastModelName || before.name }))
            .unwrap()
            .catch(() => {});
        }
        keepAwake.startServingNotification();
        await dispatch(api.startInferenceServer()).unwrap().catch(() => {});
        return {
          restarting: true,
          mode: "soft",
          model: (getState().chat.local || {}).name || null,
          serverRunning: (getState().chat.server || {}).running,
        };
      }

      /** The hard variant, kept explicit: it kills the process and relies on the OS. */
      case "POST /v1/mesh/node/kill": {
        const delay = Math.max(0, Math.min(60, NUMERIC(payload.delay) || 2));
        setTimeout(() => keepAwake.restartApp(), delay * 1000);
        return { killing: true, inSeconds: delay };
      }

      /** Re-assert the foreground service and locks without restarting the app. */
      case "POST /v1/mesh/node/awake":
        return { woken: keepAwake.startServingNotification(), serving: keepAwake.isAvailable() };

      case "POST /v1/mesh/thermal": {
        if (typeof payload.enabled === "boolean") thermals.setEnabled(payload.enabled);
        await thermals.refresh();
        return { device: thermals.getSummary() };
      }

      /** Open the OS screens a human has to touch once per phone. */
      case "POST /v1/mesh/keepalive": {
        const ask = String(payload.ask || "battery");
        if (ask === "autostart") keepAwake.openAutoStartSettings();
        else if (ask === "overlay") keepAwake.openOverlaySettings();
        else keepAwake.requestBatteryExemption();
        return { opened: ask };
      }

      case "GET /v1/mesh/nodes":
        return { count: (routerState.nodes || []).length, nodes: nodesOf() };

      case "POST /v1/mesh/scan": {
        const result = await dispatch(api.scanNodes({ deep: Boolean(payload.deep) })).unwrap();
        return {
          found: (result.found || []).map(publicNode),
          self: result.self ? publicNode({ ...result.self, self: true }) : null,
          nodes: nodesOf(),
        };
      }

      case "POST /v1/mesh/nodes": {
        if (!payload.ip) throw new Error("ip is required");
        const result = await dispatch(
          api.addNode({
            ip: String(payload.ip),
            port: payload.port ? Number(payload.port) : routerState.port,
            apiKey: payload.key || payload.apiKey || DEFAULT_API_KEY,
          })
        ).unwrap();
        return { probe: result.probe ? publicNode({ ...result.probe, ip: payload.ip, port: result.port }) : null, nodes: nodesOf() };
      }

      case "DELETE /v1/mesh/nodes": {
        const wanted = String(payload.id || payload.ip || "");
        if (!wanted) throw new Error("id or ip is required");
        const target = (routerState.nodes || []).find(
          (node) => node.id === wanted || node.ip === payload.ip
        );
        if (!target) throw new Error(`no worker ${wanted}`);
        dispatch(api.removeNode(target.id));
        return { removed: target.id, nodes: nodesOf() };
      }

      /* -------------------------------- params ------------------------------ */
      case "GET /v1/mesh/params":
        return {
          local: local.params,
          server: { port: serverState.port, apiKeyRequired: Boolean(serverState.apiKey) },
          editable: ["nCtx", "nThreads", "temperature", "maxTokens", "topP", "systemPrompt", "port", "apiKey"],
        };

      case "POST /v1/mesh/params": {
        const patch = {};
        ["nCtx", "nThreads", "temperature", "maxTokens", "topP"].forEach((field) => {
          if (payload[field] !== undefined) {
            const value = NUMERIC(payload[field]);
            if (value !== undefined) patch[field] = value;
          }
        });
        if (typeof payload.systemPrompt === "string") patch.systemPrompt = payload.systemPrompt;

        const needsReload =
          patch.nCtx !== undefined && patch.nCtx !== local.params.nCtx
            ? true
            : patch.nThreads !== undefined && patch.nThreads !== local.params.nThreads;

        if (Object.keys(patch).length) dispatch(api.updateLocalParams(patch));

        let portChanged = false;
        if (payload.port !== undefined) {
          const port = NUMERIC(payload.port);
          if (port && port !== serverState.port) {
            portChanged = true;
            await dispatch(api.changeServerPort(port)).unwrap();
          }
        }
        if (typeof payload.apiKey === "string") {
          await dispatch(api.applyServerApiKey(payload.apiKey)).unwrap();
        }

        let reloaded = false;
        if (needsReload && local.ready && local.path) {
          await dispatch(api.loadLocalModel({ path: local.path, name: local.name })).unwrap();
          reloaded = true;
        }

        return {
          applied: patch,
          portChanged,
          reloaded,
          params: getState().chat.local.params,
          server: { port: getState().chat.server.port, running: getState().chat.server.running },
        };
      }

      /* ---------------------------- model lifecycle ------------------------- */
      case "POST /v1/mesh/model/load": {
        const wanted = payload.name || payload.path;
        // The downloaded-model list is transient: after a restart it is empty
        // until something refreshes it, so never trust it blindly - refresh when
        // it looks empty OR the wanted model is not in it.
        const known = getState().chat.local.models || [];
        const hasWanted = wanted
          ? known.some((item) => item.name === wanted || item.path === wanted || String(item.name).includes(wanted))
          : known.length > 0;
        if (!hasWanted) {
          await dispatch(api.refreshLocalModels()).unwrap().catch(() => {});
        }
        const models = getState().chat.local.models || [];
        let model = null;
        if (wanted) {
          model = models.find(
            (item) => item.name === wanted || item.path === wanted || String(item.name).includes(wanted)
          );
          if (!model) throw new Error(`model ${wanted} is not downloaded on this phone`);
        } else if (local.path) {
          model = { path: local.path, name: local.name };
        } else if (models.length) {
          model = models[0];
        }
        if (!model) throw new Error("no model available to load");
        await dispatch(api.loadLocalModel({ path: model.path, name: model.name })).unwrap();
        return { loaded: { name: getState().chat.local.name, vision: getState().chat.local.vision } };
      }

      case "POST /v1/mesh/model/unload": {
        await dispatch(api.unloadLocalModel()).unwrap();
        return { unloaded: true, loaded: getState().chat.local.ready };
      }

      case "POST /v1/mesh/model/reload": {
        if (!local.path) throw new Error("no model was loaded");
        await dispatch(api.loadLocalModel({ path: local.path, name: local.name })).unwrap();
        return { reloaded: { name: getState().chat.local.name, params: getState().chat.local.params } };
      }

      /* ---------------------------- server lifecycle ------------------------ */
      case "POST /v1/mesh/server/start":
        await dispatch(api.startInferenceServer()).unwrap();
        return { running: getState().chat.server.running, port: getState().chat.server.port };

      case "POST /v1/mesh/server/stop":
        await dispatch(api.stopInferenceServer()).unwrap();
        return { running: getState().chat.server.running };

      case "POST /v1/mesh/server/restart": {
        const port = payload.port ? NUMERIC(payload.port) : undefined;
        const current = getState().chat.server.port;
        await dispatch(api.stopInferenceServer()).unwrap();
        if (port && port !== current) dispatch(api.setServerPort(port));
        await dispatch(api.startInferenceServer()).unwrap();
        return { running: getState().chat.server.running, port: getState().chat.server.port };
      }

      /* ------------------------------- insight ------------------------------ */
      /* ------------------------------- chats -------------------------------- */
      /**
       * Chat transfer over HTTP, so a node's history can be backed up - or seeded
       * - from a laptop without touching the phone.
       */
      case "GET /v1/mesh/chats": {
        const chatState = getState().chat;
        const chats = (chatState.order || []).map((id) => chatState.conversations[id]).filter(Boolean);
        return {
          count: chats.length,
          chats: chats.map((conversation) => ({
            id: conversation.id,
            title: conversation.title,
            messages: (conversation.messages || []).length,
            createdAt: conversation.createdAt,
          })),
        };
      }

      case "POST /v1/mesh/chats/export": {
        const chatState = getState().chat;
        const chats = (chatState.order || []).map((id) => chatState.conversations[id]).filter(Boolean);
        if (chats.length === 0) throw new Error("this node has no chats to export");
        const format = String(payload.format || "jsonl");
        const { text, extension } = renderExport(chats, format);
        return {
          name: `greenmesh-chats-${new Date().toISOString().slice(0, 10)}.${extension}`,
          format,
          chats: chats.length,
          bytes: text.length,
          content: text,
        };
      }

      case "POST /v1/mesh/chats/import": {
        const text =
          typeof payload.content === "string"
            ? payload.content
            : typeof payload.text === "string"
            ? payload.text
            : "";
        const parsed = parseAny(text);
        if (parsed.error) throw new Error(parsed.error);
        const chatState = getState().chat;
        const existing = (chatState.order || []).map((id) => chatState.conversations[id]).filter(Boolean);
        const added = mergeConversations(existing, parsed.conversations);
        if (added.length) dispatch(api.addConversations(added));
        return {
          imported: added.length,
          skipped: parsed.conversations.length - added.length,
          format: parsed.format,
          total: existing.length + added.length,
        };
      }

      /* ------------------------------ dictation ----------------------------- */
      /**
       * Local dictation over HTTP. Useful on its own (a node that turns voice
       * notes into text for the mesh) and it is how the transcription path can be
       * exercised with a known WAV instead of shouting at a phone.
       */
      case "GET /v1/mesh/dictation": {
        const dictationState = getState().dictation;
        return {
          loaded: api.whisperService.isLoaded(),
          model: api.whisperService.currentPath(),
          recording: api.whisperService.isRecording(),
          // Exposed so a remote operator (and the tests) can see what the phone
          // thinks is happening, including a failure that only shows in the UI.
          status: dictationState.status,
          frames: dictationState.frames,
          seconds: dictationState.seconds,
          error: dictationState.error,
          downloading: dictationState.downloading,
          progress: dictationState.progress,
          settings: dictationState.settings,
          installed: (dictationState.models || []).map((model) => ({
            name: model.name,
            size: model.sizeLabel,
            path: model.path,
          })),
          presets: (api.whisperPresets || []).map((preset) => ({
            id: preset.id,
            name: preset.name,
            label: preset.label,
            size: preset.sizeLabel,
            note: preset.note,
          })),
        };
      }

      /** Install a preset (download) or load one already on the phone. */
      case "POST /v1/mesh/dictation/model": {
        const preset = payload.preset ? whisperStore.presetById(String(payload.preset)) : null;
        if (preset) {
          await dispatch(api.downloadWhisperPreset(preset.id)).unwrap();
          const installed = (getState().dictation.models || []).find((model) => model.name === preset.name);
          if (!installed) throw new Error(`download of ${preset.name} finished but the file is not on disk`);
          await dispatch(api.loadWhisperModel({ path: installed.path, name: installed.name })).unwrap();
          return { installed: installed.name, loaded: true, path: installed.path };
        }
        const wanted = String(payload.name || "");
        if (!wanted) throw new Error("give a preset id (see GET /v1/mesh/dictation) or a model name");
        await dispatch(api.refreshWhisperModels()).unwrap();
        const models = getState().dictation.models || [];
        const match = models.find((model) => model.name === wanted || String(model.name).includes(wanted));
        if (!match) throw new Error(`${wanted} is not installed on this phone`);
        await dispatch(api.loadWhisperModel({ path: match.path, name: match.name })).unwrap();
        return { installed: match.name, loaded: true, path: match.path };
      }

      /** Transcribe a 16 kHz mono 16-bit WAV that is already on the phone. */
      case "POST /v1/mesh/dictation/transcribe": {
        const path = String(payload.path || "");
        if (!path) throw new Error("give {path} to a 16 kHz mono WAV on this phone");
        if (!api.whisperService.isLoaded()) {
          throw new Error("no Whisper model is loaded: POST /v1/mesh/dictation/model first");
        }
        const language = payload.language || getState().dictation.settings.language;
        return api.whisperService.transcribe(path, { language });
      }

      /**
       * Transcribe raw PCM sent over the wire: this is how a caller with a known
       * clip (a test, or another machine in the mesh) exercises the local
       * transcriber without touching the phone's microphone.
       */
      case "POST /v1/mesh/dictation/pcm": {
        const base64 = typeof payload.pcm === "string" ? payload.pcm : "";
        if (!base64) throw new Error("give {pcm} as base64 16-bit PCM (mono, 16 kHz)");
        if (!api.whisperService.isLoaded()) {
          throw new Error("no Whisper model is loaded: POST /v1/mesh/dictation/model first");
        }
        const chunks = [base64.replace(/^data:audio\/[a-z0-9.+-]+;base64,/i, "")];
        const language = payload.language || getState().dictation.settings.language;
        return api.whisperService.transcribeRecording(chunks, { language });
      }

      /* -------------------------- events & speech --------------------------- */
      case "GET /v1/mesh/events": {
        const limit = Number(payload.limit) || 60;
        return { ...log.summary(), events: log.getEvents(limit) };
      }

      case "POST /v1/mesh/events/clear":
        log.clearEvents();
        return { cleared: true };

      case "POST /v1/mesh/events/verbose":
        return { verbose: log.setVerbose(payload.enabled !== false) };

      case "GET /v1/mesh/speech": {
        const speechState = getState().speech;
        return {
          engine: speechState.settings.engine,
          speaking: speechState.speaking,
          settings: speechState.settings,
          installed: (speechState.voices || []).map((voice) => ({
            id: voice.id,
            size: voice.sizeLabel,
            dir: voice.dir,
          })),
          presets: hf.PIPER_VOICES.map((voice) => ({
            id: voice.id,
            label: voice.label,
            language: voice.language,
            size: voice.sizeLabel,
            file: voice.file,
          })),
        };
      }

      /** Say something out loud on this phone. */
      case "POST /v1/mesh/speech/say": {
        const text = String(payload.text || "");
        if (!text.trim()) throw new Error("give {text} to speak");
        if (payload.voice !== undefined) {
          await dispatch(api.selectVoice(payload.voice ? String(payload.voice) : null)).unwrap();
        }
        return dispatch(api.speakText(text)).unwrap();
      }

      /** Choose which engine talks: a downloaded Piper voice, or null for the phone's. */
      case "POST /v1/mesh/speech/engine": {
        const voice = payload.voice === null ? null : String(payload.voice || "");
        return dispatch(api.selectVoice(voice || null)).unwrap();
      }

      case "POST /v1/mesh/speech/stop":
        await dispatch(api.stopSpeech()).unwrap();
        return { stopped: true };

      /** Download a Piper voice (model + config) onto this phone. */
      case "POST /v1/mesh/speech/voices": {
        const id = String(payload.voice || payload.id || "");
        if (!id) throw new Error("give {voice} from GET /v1/mesh/speech");
        return dispatch(api.downloadVoice(id)).unwrap();
      }

      /**
       * Download any file from any Hugging Face repo. Whisper STT models and
       * Piper TTS voices come from here too, not just chat GGUFs.
       */
      case "POST /v1/mesh/hf/download": {
        const repo = String(payload.repo || "");
        const file = String(payload.file || "");
        if (!repo || !file) throw new Error("give {repo} and {file}");
        return dispatch(api.downloadFromHuggingFace({ repo, file })).unwrap();
      }

      case "GET /v1/mesh/log":
        return { log: api.getRequestLog().slice(0, Number(payload.limit) || 40) };

      case "GET /v1/mesh/tools":
        return { tools: api.tools.map(({ name, args, description }) => ({ name, args, description })) };

      case "GET /v1/mesh/models": {
        // the list is transient state: refresh when it looks empty so a remote
        // client always sees what is actually on the phone
        if (!(local.models || []).length) {
          await dispatch(api.refreshLocalModels()).unwrap().catch(() => {});
        }
        const fresh = getState().chat.local;
        return {
          loaded: fresh.ready ? { name: fresh.name, path: fresh.path } : null,
          downloaded: (fresh.models || []).map((model) => ({
            name: model.name,
            path: model.path,
            size: model.size,
            sizeLabel: model.sizeLabel,
          })),
          projectors: (fresh.projectors || []).map((file) => ({
            name: file.name,
            path: file.path,
            sizeLabel: file.sizeLabel,
          })),
        };
      }

      /* ---------------------------- model download -------------------------- */
      case "POST /v1/mesh/model/download": {
        if (!payload.url) throw new Error("url is required (a direct .gguf link)");
        const name = payload.name || undefined;
        const result = await dispatch(api.downloadLocalModel({ url: String(payload.url), name })).unwrap();
        await dispatch(api.refreshLocalModels()).unwrap().catch(() => {});
        return { downloaded: { name: result.name, path: result.path }, models: (getState().chat.local.models || []).map((m) => m.name) };
      }

      /* ------------------------------- coach ------------------------------- */
      case "POST /v1/mesh/coordinator": {
        const on = Boolean(payload.on);
        dispatch(api.setCoordinator(on));
        if (on) dispatch(api.installRouterHandler());
        else dispatch(api.uninstallRouterHandler());
        return { coordinator: getState().router.coordinator };
      }

      /* ------------------------------- routing ------------------------------ */
      case "POST /v1/mesh/policy": {
        const policy = String(payload.policy || "");
        const allowed = ["local-first", "least-busy", "round-robin", "model-match", "smart"];
        if (!allowed.includes(policy)) throw new Error(`policy must be one of ${allowed.join(", ")}`);
        dispatch(api.setPolicy(policy));
        return { policy };
      }

      case "POST /v1/mesh/planner": {
        dispatch(api.setPlanMode(Boolean(payload.on)));
        return { plannerMode: getState().router.planMode };
      }

      /* --------------------------- jobs and planning ------------------------ */
      case "POST /v1/mesh/plan": {
        if (!payload.goal) throw new Error("goal is required");
        const answer = await api.runPlanFlow({
          goal: String(payload.goal),
          format: payload.format ? String(payload.format) : undefined,
        });
        const router = getState().router;
        return {
          goal: payload.goal,
          steps: (router.plan || []).map((step) => ({
            index: step.index,
            title: step.title,
            instruction: step.instruction,
            node: step.node,
            ms: step.ms,
            error: step.error,
            output: (step.text || "").slice(0, 2000),
          })),
          answer,
        };
      }

      case "POST /v1/mesh/agent": {
        if (!payload.instruction) throw new Error("instruction is required");
        const result = await dispatch(api.runAgentTask({ instruction: String(payload.instruction) })).unwrap();
        return { answer: result.answer, trace: result.trace };
      }

      case "POST /v1/mesh/jobs": {
        const prompts = Array.isArray(payload.prompts) ? payload.prompts.filter(Boolean) : [];
        if (!prompts.length) throw new Error("prompts[] is required");
        const results = await dispatch(api.runBatch({ prompts })).unwrap();
        return { results };
      }

      default:
        throw new Error(
          `unknown mesh endpoint ${method} ${route}. See GET /v1/mesh/status or the Remote API section in Settings`
        );
    }
  };
}

export default { createMeshApi };
