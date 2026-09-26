/**
 * Planner / worker protocol for the mesh.
 *
 * The coordinator's own model is the brain: it turns a goal into ordered steps
 * (a dependency graph), each step is dispatched to a worker with a SYSTEM PROMPT
 * that tells the worker it is one node in a mesh and what its narrow slice is,
 * and finally the coordinator merges the partial results into one answer.
 *
 * Workers are deliberately dumb: they see a goal, their step, the results they
 * depend on, and the required answer shape - nothing else.
 */

const STEP_SHAPE =
  '{"steps":[{"title":"short name","instruction":"what the worker must do","depends_on":[0]}]}';

export const PLANNER_SYSTEM_PROMPT =
  "You are the planning module of a mesh of small AI models running on phones. " +
  "Split the goal into the fewest independent steps that can be done in parallel or in sequence. " +
  "Reply with JSON only, no prose, in exactly this shape: " +
  STEP_SHAPE;

/** Pull the first JSON object out of a model reply, tolerating chatter. */
export function parsePlan(raw, goal) {
  const text = String(raw || "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    const candidate = text.slice(start, end + 1);
    try {
      const parsed = JSON.parse(candidate);
      const steps = Array.isArray(parsed.steps) ? parsed.steps : [];
      const clean = steps
        .map((step) => ({
          title: String(step.title || "").slice(0, 80) || "step",
          instruction: String(step.instruction || step.title || "").slice(0, 600),
          depends_on: Array.isArray(step.depends_on)
            ? step.depends_on.map((value) => parseInt(value, 10)).filter((value) => !Number.isNaN(value))
            : [],
        }))
        .filter((step) => step.instruction);
      if (clean.length) return clean;
    } catch (error) {
      // fall through to the single-step plan
    }
  }
  // A model that cannot plan must not block the job: run it as one step.
  return [{ title: "whole job", instruction: goal, depends_on: [] }];
}

/** The system prompt a worker sees: it knows the mesh, its step, and its job. */
export function workerSystemPrompt({ goal, step, index, total, coordinator, previous, format }) {
  const lines = [
    "You are one worker node in a mesh of small AI models running on phones, coordinated by a router phone.",
    `Mesh goal: ${goal}`,
  ];
  if (total > 1) lines.push(`You are responsible for step ${index + 1} of ${total}: ${step.title}`);
  else lines.push(`You are responsible for the whole job: ${step.title}`);
  if (step.instruction) lines.push(`Your instruction: ${step.instruction}`);
  if (coordinator) lines.push(`The coordinator is ${coordinator}; it will merge your answer with the other nodes.`);
  if (previous && previous.length) {
    lines.push("Results you must build on:");
    previous.forEach((row) => lines.push(`- [step ${row.index + 1} ${row.title}] ${String(row.text).trim()}`));
  }
  lines.push(
    format ? `Answer format: ${format}` : "Answer with only your partial result, in plain text.",
    "Rules: do exactly this step and nothing else; never restate the goal; ask no questions; be concise; if the step cannot be done with what you have, say what is missing in one line."
  );
  return lines.join("\n");
}

/**
 * Ask the coordinator's model for a plan.
 * `localComplete(messages, params)` is llamaService.complete on this phone.
 */
export async function planTask({ goal, nodeCount = 1, localComplete, maxSteps = 4, format }) {
  const budget = Math.max(1, Math.min(maxSteps, Math.max(nodeCount, 1) + 1));
  if (!localComplete) {
    return [{ title: "whole job", instruction: goal, depends_on: [] }];
  }
  const prompt = [
    { role: "system", content: PLANNER_SYSTEM_PROMPT },
    {
      role: "user",
      content:
        `Goal: ${goal}\n` +
        `You have ${nodeCount} worker phone(s) and may use at most ${budget} step(s).\n` +
        (format ? `Every step must answer in this shape: ${format}\n` : "") +
        "Use depends_on only when a step truly needs an earlier result. Keep steps small and self-contained.",
    },
  ];
  try {
    const raw = await localComplete(prompt, { temperature: 0, maxTokens: 420, systemPrompt: "" });
    const steps = parsePlan(raw, goal);
    return steps.slice(0, budget);
  } catch (error) {
    return [{ title: "whole job", instruction: goal, depends_on: [] }];
  }
}

/**
 * Run a plan: each step goes to a worker (or stays on the coordinator if the
 * step is assigned to itself), respecting depends_on, collecting partial results.
 */
export async function executePlan({
  plan,
  goal,
  nodes,
  coordinator,
  format,
  localComplete,
  remoteStep,
  pickForStep,
  onStep,
}) {
  const results = [];

  for (let index = 0; index < plan.length; index += 1) {
    const step = plan[index];
    const dependencies = (step.depends_on || [])
      .map((dep) => results[dep])
      .filter((row) => row && row.text);
    const context = dependencies.length ? dependencies : results.slice(-1);

    const node = pickForStep ? pickForStep({ index, step, nodes }) : (nodes || [])[0] || null;

    const messages = [
      {
        role: "system",
        content: workerSystemPrompt({
          goal,
          step,
          index,
          total: plan.length,
          coordinator,
          previous: context,
          format,
        }),
      },
      { role: "user", content: step.instruction || step.title },
    ];

    const started = Date.now();
    let text = "";
    let error = null;
    try {
      if ((!node || node.self) && localComplete) {
        text = await localComplete(messages, { temperature: 0.3, maxTokens: 400 });
      } else if (remoteStep && node) {
        const answer = await remoteStep({ node, messages });
        text = (answer && answer.text) || "";
      } else {
        throw new Error("No worker available for this step");
      }
    } catch (failure) {
      error = String((failure && failure.message) || failure);
    }

    const record = {
      index,
      title: step.title,
      instruction: step.instruction,
      depends_on: step.depends_on || [],
      node: node ? (node.self ? "this phone" : `${node.ip}:${node.port}`) : null,
      text: (text || "").trim(),
      error,
      ms: Date.now() - started,
    };
    results.push(record);
    if (onStep) onStep(record);
  }

  return results;
}

/** Coordinator merges the partial results into one answer. */
export async function synthesize({ goal, results, localComplete, format }) {
  const usable = (results || []).filter((row) => row.text && !row.error);
  if (!usable.length) {
    const failures = (results || [])
      .map((row) => `${row.title}: ${row.error || "empty"}`)
      .join("; ");
    return `No step produced an answer. ${failures}`;
  }
  if (usable.length === 1) return usable[0].text;

  if (!localComplete) {
    return usable.map((row) => `## ${row.title}\n${row.text}`).join("\n\n");
  }

  const prompt = [
    {
      role: "system",
      content:
        "You are the coordinator of a mesh of small AI models. Merge the partial results into one coherent final answer for the user. " +
        "Drop duplication, keep concrete facts, never mention the mesh, steps or other models.",
    },
    {
      role: "user",
      content:
        `Goal: ${goal}\n\nPartial results from the worker nodes:\n` +
        usable.map((row) => `[step ${row.index + 1} - ${row.title}]\n${row.text}`).join("\n\n") +
        (format ? `\n\nAnswer shape: ${format}` : ""),
    },
  ];
  try {
    const merged = await localComplete(prompt, { temperature: 0.4, maxTokens: 500 });
    if (merged && merged.trim()) return merged.trim();
  } catch (error) {
    // fall back to concatenation
  }
  return usable.map((row) => `## ${row.title}\n${row.text}`).join("\n\n");
}

export const plannerUtils = { parsePlan, workerSystemPrompt };

export default { planTask, executePlan, synthesize, parsePlan, workerSystemPrompt, PLANNER_SYSTEM_PROMPT };
