import TcpSocket from "react-native-tcp-socket";
import { complete, isLoaded } from "../local/llamaService";
import * as keepAwake from "./keepAwake";
import * as thermals from "./thermals";

/**
 * Minimal OpenAI-compatible HTTP server running inside the app on top of a raw
 * TCP socket, so other devices on the same network can use the loaded GGUF
 * model as an inference endpoint:
 *
 *   GET  /v1/models
 *   POST /v1/chat/completions   (stream: false | true)
 *   GET  /health
 *
 * Only one completion runs at a time (the llama context has a single slot), so
 * requests are serialized through a promise queue.
 */

const MAX_BODY_BYTES = 16 * 1024 * 1024; // base64 photos travel in the body
const MAX_LOG_ENTRIES = 40;

let server = null;
// Runtime config so the UI can change these without restarting the listener.
let requiredApiKey = "";
let queue = Promise.resolve();
let requestLog = [];
let logListener = null;
let stats = { requests: 0, completions: 0 };
// Mesh support: a handler installed by the router slice lets this phone act as a
// coordinator - incoming requests are dispatched to whichever phone should run
// them instead of always using the local model.
let routerHandler = null;
let meshApi = null;
let healthInfo = { model: null, vision: false, n_ctx: null };
let inflight = 0;

const STATUS_TEXT = {
  200: "OK",
  400: "Bad Request",
  401: "Unauthorized",
  404: "Not Found",
  405: "Method Not Allowed",
  413: "Payload Too Large",
  500: "Internal Server Error",
  503: "Service Unavailable",
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// Writing a plain string fails on some react-native-tcp-socket builds
// ("Attempted to write to closed socket"), so try the preferred encodings and
// log anything that still goes wrong.
function writeTo(socket, text, done) {
  if (!socket || socket.destroyed) {
    if (done) done();
    return false;
  }
  try {
    socket.write(text, "utf8", () => {
      if (done) done();
    });
    return true;
  } catch (error) {
    console.log("[server] write(utf8) failed:", String(error && error.message));
  }
  try {
    const BufferRef = typeof Buffer !== "undefined" ? Buffer : null;
    if (BufferRef) {
      socket.write(BufferRef.from(text, "utf8"), undefined, () => {
        if (done) done();
      });
      return true;
    }
  } catch (error) {
    console.log("[server] write(buffer) failed:", String(error && error.message));
  }
  try {
    socket.write(text, undefined, () => {
      if (done) done();
    });
    return true;
  } catch (error) {
    console.log("[server] write(plain) failed:", String(error && error.message));
  }
  if (done) done();
  return false;
}

const enqueue = (task) => {
  const run = queue.then(
    () => {
      inflight += 1;
      // Pin the CPU for the duration of the job only: between jobs this phone
      // is allowed to sleep, which is what keeps it cool and charged.
      if (inflight === 1) keepAwake.setBusy(true);
      return task();
    },
    () => {
      inflight += 1;
      if (inflight === 1) keepAwake.setBusy(true);
      return task();
    }
  );
  // keep the chain alive even when a task rejects
  queue = run.catch(() => {}).then(() => {
    inflight = Math.max(0, inflight - 1);
    if (inflight === 0) keepAwake.setBusy(false);
  });
  return run;
};

const pushLog = (entry) => {
  requestLog = [{ ts: Date.now(), ...entry }, ...requestLog].slice(0, MAX_LOG_ENTRIES);
  if (logListener) logListener(requestLog.slice());
};

function sendJson(socket, status, payload) {
  const body = JSON.stringify(payload);
  const head =
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] || "OK"}\r\n` +
    "Content-Type: application/json\r\n" +
    `Content-Length: ${byteLength(body)}\r\n` +
    "Connection: close\r\n" +
    Object.entries(corsHeaders)
      .map(([key, value]) => `${key}: ${value}\r\n`)
      .join("") +
    "\r\n";
  writeTo(socket, head + body, () => {
    try {
      socket.end();
    } catch (error) {
      // client already gone
    }
  });
}

function byteLength(text) {
  // UTF-8 aware length without depending on Buffer in the JS runtime
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

function sendStreamHead(socket) {
  const head =
    "HTTP/1.1 200 OK\r\n" +
    "Content-Type: text/event-stream\r\n" +
    "Cache-Control: no-cache\r\n" +
    "Connection: close\r\n" +
    "Transfer-Encoding: chunked\r\n" +
    Object.entries(corsHeaders)
      .map(([key, value]) => `${key}: ${value}\r\n`)
      .join("") +
    "\r\n";
  writeTo(socket, head);
}

function writeChunk(socket, text) {
  writeTo(socket, `${byteLength(text).toString(16)}\r\n${text}\r\n`);
}

function endChunks(socket) {
  writeTo(socket, "0\r\n\r\n", () => {
    try {
      socket.end();
    } catch (error) {
      // client already gone
    }
  });
}

const toOpenAiResponse = (model, text) => ({
  id: `chatcmpl-${Date.now()}`,
  object: "chat.completion",
  created: Math.floor(Date.now() / 1000),
  model,
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: text },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
});

const sseChunk = (model, delta, finishReason = null) =>
  `data: ${JSON.stringify({
    id: "chatcmpl-stream",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;

async function handleRequest(socket, request) {
  const { method, path, headers, body, remote } = request;
  const requiredKey = headers["x-required-key"]; // injected by parseRequest

  if (method === "OPTIONS") {
    sendJson(socket, 200, { ok: true });
    return;
  }

  if (path === "/health") {
    pushLog({ method, path, status: 200, remote });
    const thermal = thermals.getSummary();
    sendJson(socket, 200, {
      status: "ok",
      model_loaded: isLoaded(),
      model: healthInfo.model || currentModelId(),
      vision: Boolean(healthInfo.vision),
      n_ctx: healthInfo.n_ctx || null,
      inflight,
      requests: stats.requests,
      completions: stats.completions,
      router: Boolean(routerHandler),
      // Health is not just "the socket answers": a planner needs to know whether
      // this phone can take work right now, and whether it is hot or nearly flat.
      paused: thermal.paused,
      pause_reason: thermal.reason,
      thermal: thermal.thermalLabel,
      battery_temp_c: thermal.batteryTempC,
      battery_level: thermal.batteryLevel,
      charging: thermal.charging,
    });
    return;
  }

  if (path === "/v1/models" && method === "GET") {
    pushLog({ method, path, status: 200, remote });
    sendJson(socket, 200, {
      object: "list",
      data: [{ id: currentModelId(), object: "model", owned_by: "greenmesh-ai" }],
    });
    return;
  }

  // ---------------------------- mesh control API ----------------------------
  // Lets a remote planner (GreenMesh, another phone, any script) drive this node:
  // inspect the mesh, scan for workers, run a planned job or hand the local
  // model a task with its tools. Same API key as the completion endpoint.
  if (path.startsWith("/v1/mesh")) {
    if (requiredKey && (headers.authorization || "") !== `Bearer ${requiredKey}`) {
      pushLog({ method, path, status: 401, remote });
      sendJson(socket, 401, { error: { message: "Invalid API key", type: "invalid_request_error" } });
      return;
    }
    if (!meshApi) {
      pushLog({ method, path, status: 503, remote });
      sendJson(socket, 503, { error: { message: "Mesh API is not ready (router slice not loaded)" } });
      return;
    }

    let payload = {};
    if (body) {
      try {
        payload = JSON.parse(body);
      } catch (error) {
        pushLog({ method, path, status: 400, remote });
        sendJson(socket, 400, { error: { message: "Invalid JSON body" } });
        return;
      }
    }

    const started = Date.now();
    try {
      const result = await meshApi({ method, path, payload, remote });
      pushLog({ method, path, status: 200, remote, ms: Date.now() - started });
      sendJson(socket, 200, result === undefined ? { ok: true } : result);
    } catch (error) {
      const message = String((error && error.message) || error);
      pushLog({ method, path, status: 400, remote, error: message });
      sendJson(socket, 400, { error: { message } });
    }
    return;
  }

  if (path === "/v1/chat/completions" && method === "POST") {
    if (requiredKey && (headers.authorization || "") !== `Bearer ${requiredKey}`) {
      pushLog({ method, path, status: 401, remote });
      sendJson(socket, 401, { error: { message: "Invalid API key", type: "invalid_request_error" } });
      return;
    }

    let payload;
    try {
      payload = JSON.parse(body || "{}");
    } catch (error) {
      pushLog({ method, path, status: 400, remote });
      sendJson(socket, 400, { error: { message: "Invalid JSON body" } });
      return;
    }

    if (!isLoaded()) {
      pushLog({ method, path, status: 503, remote });
      sendJson(socket, 503, {
        error: { message: "No GGUF model is loaded in the app", type: "service_unavailable" },
      });
      return;
    }

    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    if (messages.length === 0) {
      pushLog({ method, path, status: 400, remote });
      sendJson(socket, 400, { error: { message: "messages is required" } });
      return;
    }

    const model = payload.model || currentModelId();
    const stream = payload.stream === true;
    const started = Date.now();

    // Thermal guard: a node that keeps grinding while it is too hot throttles,
    // drains and eventually gets killed - refuse work instead, and let the
    // planner route somewhere cooler. force:true overrides it.
    if (payload.force !== true && thermals.isPaused()) {
      const reason = thermals.getPauseReason();
      pushLog({ method, path, status: 503, remote, error: `paused: ${reason}` });
      sendJson(socket, 503, {
        error: {
          message: `Node is cooling down (${reason}). Retry later or route to another worker.`,
          type: "service_unavailable",
        },
      });
      return;
    }

    // Coordinator mode: hand the request to the router instead of running it here.
    // A request that already travelled through the mesh is executed locally.
    const hops = parseInt(headers["x-greenmesh-hops"] || "0", 10);
    if (routerHandler && !hops) {
      try {
        if (stream) {
          sendStreamHead(socket);
          writeChunk(socket, sseChunk(model, { role: "assistant", content: "" }));
          let sent = 0;
          const text = await routerHandler({
            payload,
            onDelta: (partial) => {
              const delta = String(partial).slice(sent);
              sent = String(partial).length;
              if (delta) writeChunk(socket, sseChunk(model, { content: delta }));
            },
          });
          const rest = String(text || "").slice(sent);
          if (rest) writeChunk(socket, sseChunk(model, { content: rest }));
          writeChunk(socket, sseChunk(model, {}, "stop"));
          writeChunk(socket, "data: [DONE]\n\n");
          endChunks(socket);
        } else {
          const text = await routerHandler({ payload, onDelta: null });
          pushLog({
            method,
            path,
            status: 200,
            remote,
            model,
            ms: Date.now() - started,
            chars: String(text || "").length,
            routed: true,
          });
          stats.completions += 1;
          sendJson(socket, 200, toOpenAiResponse(model, String(text || "")));
        }
      } catch (error) {
        pushLog({ method, path, status: 500, remote, error: String(error && error.message) });
        if (!stream) {
          sendJson(socket, 500, { error: { message: String(error && error.message) } });
        } else {
          endChunks(socket);
        }
      }
      return;
    }

    try {
      if (stream) {
        sendStreamHead(socket);
        writeChunk(socket, sseChunk(model, { role: "assistant", content: "" }));
        // llama.rn reports cumulative text; send only the new suffix each time
        let sent = 0;
        await enqueue(() =>
          complete(messages, {
            temperature: typeof payload.temperature === "number" ? payload.temperature : undefined,
            maxTokens: payload.max_tokens || payload.n_predict || undefined,
            onToken: (partial) => {
              const delta = partial.slice(sent);
              sent = partial.length;
              if (delta) writeChunk(socket, sseChunk(model, { content: delta }));
            },
          })
        );
        writeChunk(socket, sseChunk(model, {}, "stop"));
        writeChunk(socket, "data: [DONE]\n\n");
        endChunks(socket);
      } else {
        const text = await enqueue(() =>
          complete(messages, {
            temperature: typeof payload.temperature === "number" ? payload.temperature : undefined,
            maxTokens: payload.max_tokens || payload.n_predict || undefined,
          })
        );
        pushLog({
          method,
          path,
          status: 200,
          remote,
          model,
          ms: Date.now() - started,
          chars: text.length,
        });
        stats.completions += 1;
        sendJson(socket, 200, toOpenAiResponse(model, text));
      }
    } catch (error) {
      pushLog({ method, path, status: 500, remote, error: String(error && error.message) });
      if (!stream) {
        sendJson(socket, 500, { error: { message: String(error && error.message) } });
      } else {
        endChunks(socket);
      }
    }
    return;
  }

  pushLog({ method, path, status: 404, remote });
  sendJson(socket, 404, { error: { message: `Unknown endpoint ${path}` } });
}

function parseRequest(raw, remote) {
  const separator = raw.indexOf("\r\n\r\n");
  if (separator === -1) return null;
  const head = raw.slice(0, separator);
  const lines = head.split("\r\n");
  const [method, path] = lines[0].split(" ");
  const headers = {};
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  const contentLength = parseInt(headers["content-length"] || "0", 10);
  const body = raw.slice(separator + 4);
  if (body.length < contentLength) return null; // wait for more data
  if (requiredApiKey) headers["x-required-key"] = requiredApiKey;
  return { method, path: path.split("?")[0], headers, body: body.slice(0, contentLength), remote };
}

export function currentModelId() {
  // the app's loaded model name is injected by the slice as the model id
  return global.__greenmeshModelName || "local-gguf";
}

export function setServerModelName(name) {
  global.__greenmeshModelName = name || "local-gguf";
}

export function setRequiredApiKey(key) {
  requiredApiKey = key || "";
}

/** Mesh: the router slice owns this handler; null means "run locally". */
export function setRouterHandler(handler) {
  routerHandler = typeof handler === "function" ? handler : null;
}

export const getRouterHandler = () => routerHandler;

/** Remote control API (/v1/mesh/*), installed by the router slice. */
export function setMeshApi(handler) {
  meshApi = typeof handler === "function" ? handler : null;
}

export const getMeshApi = () => meshApi;

/** Extra facts about this node, published through /health for the router. */
export function setHealthInfo(info) {
  healthInfo = { ...healthInfo, ...(info || {}) };
}

export const getHealthInfo = () => ({ ...healthInfo, inflight });

export const getRequiredApiKey = () => requiredApiKey;

export function startServer({ port = 8080, apiKey = "" } = {}) {
  requiredApiKey = apiKey || "";
  if (server) return Promise.resolve({ port });

  return new Promise((resolve, reject) => {
    let settled = false;
    const instance = TcpSocket.createServer((socket) => {
      let buffer = "";
      socket.on("data", (data) => {
        const chunk =
          typeof data === "string"
            ? data
            : data && data.toString
            ? data.toString("utf8")
            : String(data);
        console.log("[server] <-", JSON.stringify(chunk.slice(0, 120)));
        buffer += chunk;
        if (buffer.length > MAX_BODY_BYTES) {
          sendJson(socket, 413, { error: { message: "Payload too large" } });
          return;
        }
        const request = parseRequest(buffer, socket.remoteAddress);
        if (!request) return;
        buffer = "";
        stats.requests += 1;
        handleRequest(socket, request).catch((error) => {
          console.log("[server] handler failed:", String(error && error.message));
        });
      });
      socket.on("error", (error) => {
        console.log("[server] socket error:", String(error && error.message));
      });
      socket.on("close", () => {
        console.log("[server] socket closed");
      });
    });

    instance.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });

    instance.listen({ port, host: "0.0.0.0" }, () => {
      settled = true;
      server = instance;
      resolve({ port });
    });
  });
}

export function stopServer() {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    const instance = server;
    server = null;
    try {
      instance.close(() => resolve());
    } catch (error) {
      resolve();
    }
  });
}

export const isServerRunning = () => server !== null;

export function getRequestLog() {
  return requestLog.slice();
}

export function setLogListener(listener) {
  logListener = listener;
}

export function resetStats() {
  stats = { requests: 0, completions: 0 };
  requestLog = [];
  if (logListener) logListener([]);
}

export function getStats() {
  return { ...stats };
}
