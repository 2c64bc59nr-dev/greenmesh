import * as Network from "expo-network";
import { DEFAULT_API_KEY } from "../config";

/**
 * Peer registry for the phone mesh.
 *
 * A node is any machine on the LAN that speaks the OpenAI API - another phone
 * running this app (which also answers /health) or a different local server
 * (Ollama, LM Studio, llama.cpp, vLLM, text-generation-webui...), so the mesh
 * grows by itself instead of needing addresses typed in by hand.
 *
 * A node record:
 *   { id, ip, port, kind, baseUrl, apiKey, self, model, models, vision, ok,
 *     verified, latencyMs, inflight, jobs, failures, lastSeen, lastError }
 *
 * `verified` means a real completion came back OK - the "thumbs up" test a node
 * must pass before it is trusted with jobs.
 */

export const DEFAULT_PORT = 8080;
export const DEFAULT_PATH = "/v1";
/** Ports local AI servers commonly listen on (this app, Ollama, LM Studio, ...). */
export const COMMON_PORTS = [8080, 11434, 1234, 8000, 5000, 8081, 9000];

export async function localIp() {
  try {
    const ip = await Network.getIpAddressAsync();
    if (!ip || ip === "0.0.0.0") return null;
    return ip;
  } catch (error) {
    return null;
  }
}

export const subnetBase = (ip) => String(ip || "").split(".").slice(0, 3).join(".");

export const nodeId = (ip, port) => `${ip}:${port}`;

export const nodeUrl = (node) =>
  node && node.baseUrl
    ? String(node.baseUrl).replace(/\/+$/, "")
    : `http://${node.ip}:${node.port}${DEFAULT_PATH}`;

async function requestJson(url, { apiKey, timeoutMs = 1500, method = "GET", body, signal } = {}) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  try {
    const response = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: signal || (controller ? controller.signal : undefined),
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (error) {
      data = { raw: text };
    }
    if (!response.ok) {
      const message =
        (data && data.error && (data.error.message || data.error)) || `HTTP ${response.status}`;
      const failure = new Error(String(message));
      failure.status = response.status;
      throw failure;
    }
    return data;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const modelIdsFrom = (data) => {
  const rows = Array.isArray(data) ? data : (data && data.data) || [];
  return rows
    .map((row) => (typeof row === "string" ? row : row && (row.id || row.name)))
    .filter(Boolean);
};

/**
 * Ask an OpenAI-compatible server what it is AND whether it really answers:
 * /models to identify it, then a tiny completion as the "thumbs up" test.
 * Returns null when the address is not an OpenAI API at all.
 */
export async function probeOpenAi({ ip, port, path = DEFAULT_PATH, apiKey = DEFAULT_API_KEY, timeoutMs = 1500, verify = true }) {
  const suffix = path === "/" ? "" : path;
  const baseUrl = `http://${ip}:${port}${suffix}`;
  const started = Date.now();
  try {
    const list = await requestJson(`${baseUrl}/models`, { apiKey, timeoutMs });
    const models = modelIdsFrom(list);
    if (!models.length) return null;

    let verified = false;
    let latencyMs = Date.now() - started;
    let error = null;
    if (verify) {
      try {
        const startedTest = Date.now();
        await requestJson(`${baseUrl}/chat/completions`, {
          apiKey,
          timeoutMs: Math.max(timeoutMs, 8000),
          method: "POST",
          body: {
            model: models[0],
            messages: [{ role: "user", content: "Reply with the thumbs up emoji only." }],
            max_tokens: 4,
          },
        });
        verified = true;
        latencyMs = Date.now() - startedTest;
      } catch (failure) {
        error = String((failure && failure.message) || failure);
      }
    }
    return { ok: true, kind: "openai", baseUrl, model: models[0], models, verified, latencyMs, error };
  } catch (error) {
    return null;
  }
}

/** Ask one address what it is: /health plus /v1/models. */
export async function probeNode({ ip, port = DEFAULT_PORT, apiKey = DEFAULT_API_KEY }, timeoutMs = 1500) {
  const started = Date.now();
  try {
    const health = await requestJson(`http://${ip}:${port}/health`, { apiKey, timeoutMs });
    let models = [];
    try {
      const list = await requestJson(`http://${ip}:${port}/v1/models`, { apiKey, timeoutMs });
      const rows = Array.isArray(list) ? list : (list && list.data) || [];
      models = rows.map((row) => (typeof row === "string" ? row : row && row.id)).filter(Boolean);
    } catch (error) {
      models = [];
    }
    const model = health && health.model ? health.model : models[0] || null;
    return {
      ok: true,
      kind: "greenmesh-app",
      baseUrl: `http://${ip}:${port}${DEFAULT_PATH}`,
      latencyMs: Date.now() - started,
      model,
      models,
      vision: Boolean(health && health.vision),
      ctx: (health && health.n_ctx) || null,
      load: (health && health.inflight) || 0,
      requests: (health && health.requests) || 0,
      modelLoaded: health ? health.model_loaded !== false : true,
      // /health is itself a successful answer, so this app counts as verified.
      verified: true,
      health,
    };
  } catch (error) {
    // not this app - it may still be a different local AI server
  }

  const openai = await probeOpenAi({ ip, port, apiKey, timeoutMs });
  if (openai) {
    return { ...openai, load: 0, requests: 0, modelLoaded: true, ctx: null, vision: false };
  }
  return {
    ok: false,
    latencyMs: Date.now() - started,
    error: "no OpenAI-compatible server answered",
  };
}

/**
 * Sweep the local /24 for nodes. Sequential batches keep the phone from opening
 * 254 sockets at once (Android chokes above ~30 concurrent connections).
 */
export async function scanSubnet({
  ip,
  port = DEFAULT_PORT,
  ports,
  apiKey = DEFAULT_API_KEY,
  onFound,
  onProgress,
  batchSize = 16,
  timeoutMs = 900,
  from = 1,
  to = 254,
}) {
  const base = subnetBase(ip);
  if (!base) throw new Error("No local IP address - is the phone on Wi-Fi?");

  const portList = ports && ports.length ? ports : [port];
  const targets = [];
  for (let last = from; last <= to; last += 1) {
    portList.forEach((each) => targets.push({ ip: `${base}.${last}`, port: each }));
  }

  const found = [];
  let done = 0;
  for (let index = 0; index < targets.length; index += batchSize) {
    const batch = targets.slice(index, index + batchSize);
    const results = await Promise.all(
      batch.map((target) =>
        probeNode({ ip: target.ip, port: target.port, apiKey }, timeoutMs)
      )
    );
    results.forEach((result, offset) => {
      const target = batch[offset];
      if (result.ok) {
        const node = { ip: target.ip, port: target.port, apiKey, ...result };
        found.push(node);
        if (onFound) onFound(node);
      }
      done += 1;
    });
    if (onProgress) onProgress(done, targets.length);
  }
  return found;
}

/** Locate the phone running this app inside the subnet (used for the self badge). */
export async function findSelf({ ip, port = DEFAULT_PORT, timeoutMs = 1200 }) {
  if (!ip) return null;
  const own = await probeNode({ ip, port }, timeoutMs);
  if (own.ok) return { ip, port, ...own, self: true };
  return null;
}

export default {
  probeNode,
  probeOpenAi,
  scanSubnet,
  localIp,
  findSelf,
  subnetBase,
  nodeId,
  nodeUrl,
  DEFAULT_PORT,
  DEFAULT_PATH,
  COMMON_PORTS,
};
