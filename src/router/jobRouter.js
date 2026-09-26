import { nodeUrl } from "./nodeRegistry";

/**
 * The router. One phone acts as the coordinator: it keeps the node list, decides
 * which worker gets each job, and can forward work to peers.
 *
 * Parallelism note: every node is single-slot, so a node handles one generation
 * at a time. Throughput comes from spreading jobs across nodes, not from
 * splitting one generation.
 *
 * React Native's fetch has no streaming response body, so a peer job is fetched
 * with stream:false and the finished text is re-emitted to the caller in chunks.
 * Callers of the app's own HTTP server still see a normal SSE stream.
 */

export const POLICIES = [
  {
    key: "local-first",
    label: "This phone first",
    detail: "Answer on this phone when a model is loaded, only overflow to peers",
  },
  {
    key: "least-busy",
    label: "Least busy",
    detail: "Send to the worker with the fewest jobs in flight, latency as tie-break",
  },
  {
    key: "round-robin",
    label: "Round robin",
    detail: "Spread jobs evenly over every healthy node",
  },
  {
    key: "model-match",
    label: "Best model",
    detail: "Prefer a worker running the requested model, then the least busy",
  },
  {
    key: "smart",
    label: "Let the model decide",
    detail: "The small model on this phone reads the job and picks the worker",
  },
];

const CHUNK = 48;

const textOf = (message) =>
  Array.isArray(message && message.content)
    ? message.content.map((part) => part.text || "").join(" ")
    : String((message && message.content) || "");

export const lastUserText = (messages) => {
  const rows = Array.isArray(messages) ? messages : [];
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index].role === "user") return textOf(rows[index]).trim();
  }
  return "";
};

const isHealthy = (node) =>
  Boolean(node) && node.ok !== false && (node.kind !== "openai" || node.verified !== false);

/** Deterministic policies. `rotation` is a monotonic counter kept by the caller. */
export function pickNode({ nodes, policy = "local-first", requestedModel, localAvailable, rotation = 0 }) {
  const healthy = (nodes || []).filter(isHealthy);
  // A stored node list is not probed until the first health refresh, so fall
  // back to every known address rather than refusing to route at all.
  const peers = healthy.length ? healthy : (nodes || []).filter((node) => node && node.ip);
  if (!peers.length) return null;

  const self = peers.find((node) => node.self);
  const remote = peers.filter((node) => !node.self);

  if (policy === "local-first") {
    if (self && localAvailable && self.modelLoaded !== false) return self;
    return remote.length ? byLoad(remote) : self || peers[0];
  }

  if (policy === "round-robin") {
    return peers[rotation % peers.length];
  }

  if (policy === "model-match") {
    if (requestedModel) {
      const exact = peers.filter((node) => node.model === requestedModel);
      if (exact.length) return byLoad(exact);
    }
    return byLoad(peers);
  }

  // least-busy is also the fallback for "smart"
  return byLoad(peers);
}

export const byLoad = (nodes) =>
  [...nodes].sort((a, b) => {
    const loadDiff = (a.inflight || 0) - (b.inflight || 0);
    if (loadDiff !== 0) return loadDiff;
    const failDiff = (a.failures || 0) - (b.failures || 0);
    if (failDiff !== 0) return failDiff;
    return (a.latencyMs || 0) - (b.latencyMs || 0);
  })[0];

/**
 * Ask the small model on this phone which worker should take the job.
 * `localComplete(messages, params)` is injected (llamaService.complete) so the
 * router works without importing the inference engine.
 */
export async function smartPick({
  nodes,
  messages,
  localComplete,
  localModelName,
  localAvailable,
  fallback = "least-busy",
  requestedModel,
  rotation = 0,
}) {
  const peers = (nodes || []).filter(isHealthy);
  if (!localComplete || !localAvailable || peers.length < 2) {
    return pickNode({ nodes: peers, policy: fallback, requestedModel, localAvailable, rotation });
  }

  const job = lastUserText(messages).slice(0, 400);
  const roster = peers
    .map(
      (node, index) =>
        `${index}) ${node.self ? "THIS PHONE" : node.ip} - model: ${node.model || "unknown"}, ${
          node.inflight || 0
        } job(s) in flight, ${node.latencyMs || 0} ms`
    )
    .join("\n");

  const prompt = [
    {
      role: "system",
      content:
        "You are a job router for a network of phones that run small language models. " +
        "Choose the single best worker for the job. Answer with the worker number only.",
    },
    {
      role: "user",
      content: `Job:\n${job || "(empty)"}\n\nWorkers:\n${roster}\n\nBest worker number:`,
    },
  ];

  try {
    const raw = await localComplete(prompt, { temperature: 0, maxTokens: 6, systemPrompt: "" });
    const match = /\d+/.exec(String(raw || ""));
    const index = match ? parseInt(match[0], 10) : NaN;
    if (!Number.isNaN(index) && index >= 0 && index < peers.length) {
      return { ...peers[index], reason: `model picked #${index}`, decidedBy: "model" };
    }
  } catch (error) {
    // fall through to the deterministic policy
  }
  return {
    ...pickNode({ nodes: peers, policy: fallback, requestedModel, localAvailable, rotation }),
    reason: "model output unusable - fell back",
    decidedBy: "fallback",
  };
}

/** Forward one chat request to a peer and return its text. */
export async function forwardChat({ node, payload, timeoutMs = 180000, onDelta }) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const started = Date.now();
  try {
    const response = await fetch(`${nodeUrl(node)}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // A forwarded request is never routed again - the receiving node runs it
        // locally. Without this a coordinator pointing at another coordinator
        // could bounce the same job around the mesh.
        "x-greenmesh-hops": String((payload && payload.hops) || 1),
        ...(node.apiKey ? { Authorization: `Bearer ${node.apiKey}` } : {}),
      },
      body: JSON.stringify({ ...payload, hops: undefined, stream: false }),
      signal: controller ? controller.signal : undefined,
    });
    const raw = await response.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch (error) {
      throw new Error(`Peer ${node.ip} sent a non-JSON reply`);
    }
    if (!response.ok) {
      const message =
        (data && data.error && (data.error.message || data.error)) || `HTTP ${response.status}`;
      const failure = new Error(String(message));
      failure.status = response.status;
      throw failure;
    }
    const choice = data && data.choices && data.choices[0];
    const content =
      (choice && ((choice.message && choice.message.content) || choice.text)) || "";

    if (onDelta && content) {
      for (let index = 0; index < content.length; index += CHUNK) {
        onDelta(content.slice(0, Math.min(content.length, index + CHUNK)));
      }
    }
    return { text: content, ms: Date.now() - started, model: data && data.model };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Fan a batch of independent prompts over the mesh (true parallelism: N nodes
 * work at the same time) and return the answers in input order.
 */
export async function fanOut({ nodes, prompts, policy = "round-robin", maxPerNode = 1 }) {
  const healthy = (nodes || []).filter(isHealthy);
  if (!healthy.length) throw new Error("No healthy nodes to run the batch");

  const results = new Array(prompts.length).fill(null);
  let cursor = 0;

  const worker = async (node) => {
    for (let taken = 0; taken < maxPerNode; taken += 1) {
      const index = cursor;
      cursor += 1;
      if (index >= prompts.length) return;
      try {
        const answer = await forwardChat({
          node,
          payload: { messages: [{ role: "user", content: prompts[index] }], max_tokens: 256 },
        });
        results[index] = { prompt: prompts[index], node: node.ip, text: answer.text, ok: true };
      } catch (error) {
        results[index] = {
          prompt: prompts[index],
          node: node.ip,
          ok: false,
          error: String((error && error.message) || error),
        };
      }
    }
  };

  const sorted =
    policy === "least-busy" || policy === "smart" ? [...healthy].sort((a, b) => (a.inflight || 0) - (b.inflight || 0)) : healthy;
  await Promise.all(sorted.map((node) => worker(node)));
  return results;
}

/**
 * Map-reduce over one long text: every node summarises a slice, then the
 * coordinator model merges the summaries. This is the one case where splitting
 * a single job across phones genuinely pays off.
 */
export function splitText(text, parts) {
  const clean = String(text || "").trim();
  const size = Math.max(1, Math.ceil(clean.length / Math.max(1, parts)));
  const chunks = [];
  for (let index = 0; index < clean.length; index += size) {
    chunks.push(clean.slice(index, index + size));
  }
  return chunks;
}

export async function mapReduce({ nodes, text, parts = 3, reduceLocalComplete }) {
  const chunks = splitText(text, Math.min(parts, Math.max(1, (nodes || []).length)));
  const prompts = chunks.map(
    (chunk) =>
      `Summarise the following text in at most 3 sentences. Reply with the summary only.\n\n${chunk}`
  );
  const mapped = await fanOut({ nodes, prompts, policy: "round-robin" });
  const summaries = mapped
    .filter((row) => row && row.ok && row.text)
    .map((row, index) => `Part ${index + 1} (${row.node}): ${row.text.trim()}`);

  if (!summaries.length) throw new Error("Every node failed on the batch");
  if (!reduceLocalComplete) return summaries.join("\n\n");

  const merged = await reduceLocalComplete(
    [
      {
        role: "user",
        content: `Merge these partial summaries into one coherent summary:\n\n${summaries.join("\n\n")}`,
      },
    ],
    { temperature: 0.3, maxTokens: 320 }
  );
  return merged || summaries.join("\n\n");
}

export const routerUtils = { pickNode, smartPick, byLoad, lastUserText, splitText };

export default {
  POLICIES,
  pickNode,
  smartPick,
  forwardChat,
  fanOut,
  mapReduce,
  splitText,
  lastUserText,
};
