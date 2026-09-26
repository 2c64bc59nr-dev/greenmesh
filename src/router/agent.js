/**
 * Tool layer: the coordinator's model gets a small palette of commands it can
 * call by name, so the mesh maintains itself ("find servers, add them, send the
 * job") without a human tapping anything.
 *
 * Small phone models have no native function-calling, so the protocol is a
 * single JSON object per turn:
 *
 *   {"tool": "scan_mesh", "args": {"deep": true}}
 *   {"done": true, "answer": "..."}
 *
 * The loop runs a bounded number of turns and records every action it took, so
 * the UI can show exactly what the model decided to do.
 */

const TOOL_TIMEOUT_MS = 10 * 60 * 1000;

export const TOOLS = [
  {
    name: "scan_mesh",
    args: "{deep?:boolean}",
    description:
      "Sweep the local Wi-Fi for OpenAI-compatible servers and add every one that answers. deep=true also probes the ports Ollama/LM Studio/llama.cpp use.",
  },
  {
    name: "list_workers",
    args: "{}",
    description: "List the workers currently in the mesh with model, latency and job counts.",
  },
  {
    name: "add_worker",
    args: "{ip:string,port?:number,key?:string}",
    description: "Test one address and add it as a worker if it answers.",
  },
  {
    name: "remove_worker",
    args: "{ip:string}",
    description: "Drop a worker from the mesh.",
  },
  {
    name: "test_worker",
    args: "{ip:string}",
    description: "Send a tiny completion to one worker and report whether it answered.",
  },
  {
    name: "route_job",
    args: "{goal:string}",
    description: "Send one job to the best worker under the current policy and return its answer.",
  },
  {
    name: "plan_job",
    args: "{goal:string}",
    description:
      "Split a job into steps, send each step to a worker with a mesh-aware system prompt, then merge the answers.",
  },
  {
    name: "set_policy",
    args: "{policy:string}",
    description: "Change the routing policy: local-first | least-busy | round-robin | model-match | smart.",
  },
  {
    name: "set_planner",
    args: "{on:boolean}",
    description: "Turn planner mode on or off for incoming requests.",
  },
];

const TOOL_TEXT = TOOLS.map((tool) => `- ${tool.name}${tool.args} : ${tool.description}`).join("\n");

const summarizeMesh = (nodes) =>
  (nodes || [])
    .map((node, index) => {
      const where = node.self ? "this phone" : `${node.ip}:${node.port}`;
      const verified = node.kind === "openai" ? (node.verified ? "verified" : "UNVERIFIED") : "app";
      return `${index + 1}. ${where} [${verified}] model=${node.model || "none"} ok=${node.ok !== false} latency=${
        node.latencyMs || 0
      }ms jobs=${node.jobs || 0}`;
    })
    .join("\n") || "(no workers yet)";

export function agentSystemPrompt({ nodes, policy, planMode }) {
  return [
    "You are the coordinator agent of a mesh of small AI models running on phones and local servers.",
    "You act by calling one tool at a time. Reply with ONE JSON object and nothing else.",
    'To call a tool: {"tool": "<name>", "args": {...}}',
    'When the job is finished: {"done": true, "answer": "<final answer for the user>"}',
    "",
    "Available tools:",
    TOOL_TEXT,
    "",
    `Current routing policy: ${policy}`,
    `Planner mode: ${planMode ? "on" : "off"}`,
    "Workers in the mesh:",
    summarizeMesh(nodes),
    "",
    "Rules: use as few tools as possible; never invent tool names; if no worker exists yet, call scan_mesh first; when the user asks for every server or the whole network, call scan_mesh with deep=true.",
  ].join("\n");
}

/** Pull the first JSON object out of a model reply. */
export function parseCommand(raw) {
  const text = String(raw || "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (parsed && parsed.done) return { done: true, answer: String(parsed.answer || "") };
    if (parsed && parsed.tool) {
      return { tool: String(parsed.tool), args: parsed.args && typeof parsed.args === "object" ? parsed.args : {} };
    }
    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Run the agent loop.
 *
 * ctx: { getState, dispatch, scanNodes, addNode, removeNode, refreshNodeHealth,
 *        runRoutedJob, runPlannedJob, setPolicy, setPlanMode, mesh }
 */
export async function runAgent({ instruction, localComplete, ctx, maxSteps = 6, onTrace }) {
  if (!localComplete) throw new Error("The agent needs a local model on this phone");
  const trace = [];
  const conversation = [{ role: "user", content: `Task from the user: ${instruction}` }];

  for (let step = 0; step < maxSteps; step += 1) {
    const state = ctx.getState();
    const routerState = state.router;
    const system = agentSystemPrompt({
      nodes: routerState.nodes,
      policy: routerState.policy,
      planMode: routerState.planMode,
    });

    const raw = await localComplete([{ role: "system", content: system }, ...conversation], {
      temperature: 0,
      maxTokens: 220,
      systemPrompt: "",
    });

    const command = parseCommand(raw);
    if (!command) {
      conversation.push({ role: "assistant", content: String(raw || "").slice(0, 200) });
      conversation.push({
        role: "user",
        content: 'That was not valid JSON. Reply with {"tool": "...", "args": {...}} or {"done": true, "answer": "..."}',
      });
      continue;
    }

    if (command.done) {
      const record = { tool: "done", args: {}, result: command.answer };
      trace.push(record);
      if (onTrace) onTrace(record);
      return { answer: command.answer, trace };
    }

    let result;
    try {
      result = await runTool({ name: command.tool, args: command.args, ctx });
    } catch (failure) {
      result = `tool failed: ${String((failure && failure.message) || failure)}`;
    }
    const record = { tool: command.tool, args: command.args, result: String(result).slice(0, 600) };
    trace.push(record);
    if (onTrace) onTrace(record);

    conversation.push({ role: "assistant", content: JSON.stringify({ tool: command.tool, args: command.args }) });
    conversation.push({ role: "user", content: `Tool result:\n${record.result}\n\nNext step (one JSON object).` });
  }

  const fallback = `Stopped after ${maxSteps} steps without a final answer.`;
  trace.push({ tool: "timeout", args: {}, result: fallback });
  if (onTrace) onTrace(trace[trace.length - 1]);
  return { answer: fallback, trace };
}

/** Execute one tool by name. */
export async function runTool({ name, args, ctx }) {
  const state = ctx.getState();
  const routerState = state.router;
  const nodes = routerState.nodes || [];

  switch (name) {
    case "scan_mesh": {
      const payload = await ctx.dispatch(ctx.scanNodes({ deep: Boolean(args.deep) })).unwrap();
      const found = payload.found || [];
      return `${found.length} server(s) found: ${found
        .map((node) => `${node.ip}:${node.port} (${node.model || "model?"}, ${node.verified ? "verified" : "unverified"})`)
        .join(", ") || "none"}`;
    }

    case "list_workers":
      return summarizeMesh(nodes);

    case "add_worker": {
      const ip = String(args.ip || "").trim();
      if (!ip) return "add_worker needs an ip";
      const payload = await ctx.dispatch(
        ctx.addNode({ ip, port: args.port ? Number(args.port) : routerState.port, apiKey: args.key || "" })
      ).unwrap();
      const probe = payload.probe || {};
      return `${ip}:${payload.port} ${probe.ok ? "answered" : "no answer"} model=${probe.model || "?"} verified=${
        probe.verified ? "yes" : "no"
      }`;
    }

    case "remove_worker": {
      const ip = String(args.ip || "").trim();
      const target = nodes.find((node) => node.ip === ip);
      if (!target) return `no worker with ip ${ip}`;
      ctx.dispatch(ctx.removeNode(target.id));
      return `removed ${ip}`;
    }

    case "test_worker": {
      const ip = String(args.ip || "").trim();
      const target = nodes.find((node) => node.ip === ip);
      if (!target) return `no worker with ip ${ip}`;
      const answer = await ctx.mesh.forwardChat({
        node: target,
        payload: { messages: [{ role: "user", content: "Say OK." }], max_tokens: 8 },
        timeoutMs: 30000,
      });
      return `${ip} answered in ${answer.ms} ms: ${String(answer.text).slice(0, 80)}`;
    }

    case "route_job": {
      const goal = String(args.goal || "").trim();
      if (!goal) return "route_job needs a goal";
      const payload = await ctx.dispatch(ctx.runRoutedJob({ prompt: goal })).unwrap();
      return `ran on ${payload.node.self ? "this phone" : payload.node.ip} in ${payload.ms} ms: ${String(
        payload.text
      ).slice(0, 500)}`;
    }

    case "plan_job": {
      const goal = String(args.goal || "").trim();
      if (!goal) return "plan_job needs a goal";
      const payload = await ctx.dispatch(ctx.runPlannedJob({ goal })).unwrap();
      return `merged answer: ${String(payload.text).slice(0, 600)}`;
    }

    case "set_policy": {
      const allowed = ["local-first", "least-busy", "round-robin", "model-match", "smart"];
      const policy = String(args.policy || "");
      if (!allowed.includes(policy)) return `unknown policy ${policy}; use one of ${allowed.join(", ")}`;
      ctx.dispatch(ctx.setPolicy(policy));
      return `policy is now ${policy}`;
    }

    case "set_planner": {
      const on = Boolean(args.on);
      ctx.dispatch(ctx.setPlanMode(on));
      return `planner mode ${on ? "on" : "off"}`;
    }

    default:
      return `unknown tool ${name}; available: ${TOOLS.map((tool) => tool.name).join(", ")}`;
  }
}

export { TOOL_TIMEOUT_MS, summarizeMesh };

export default { TOOLS, runAgent, runTool, parseCommand, agentSystemPrompt, summarizeMesh };
