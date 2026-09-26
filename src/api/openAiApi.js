import axios from "axios";

const normalize = (baseUrl) => String(baseUrl || "https://api.openai.com/v1").trim().replace(/\/+$/, "");

const headersFor = (apiKey) => ({
  "Content-Type": "application/json",
  ...(apiKey && apiKey.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {}),
});

/** Chat completion against any OpenAI-compatible endpoint. */
export async function chatCompletion({
  apiKey,
  baseUrl,
  model,
  messages,
  temperature,
  maxTokens,
}) {
  const url = normalize(baseUrl);
  const payload = { model: model || "gpt-4o-mini", messages };
  if (typeof temperature === "number") payload.temperature = temperature;
  if (typeof maxTokens === "number" && maxTokens > 0) payload.max_tokens = maxTokens;

  const response = await axios.post(`${url}/chat/completions`, payload, {
    headers: headersFor(apiKey),
    timeout: 90000,
  });

  const data = response.data;
  if (!data || !Array.isArray(data.choices) || data.choices.length === 0) {
    throw new Error("Invalid API response (no choices)");
  }
  const choice = data.choices[0];
  const content = (choice.message && choice.message.content) || choice.text || "";
  if (!content) throw new Error("Empty content in the API response");
  return content;
}

/** GET /models — used by the "Fetch model list" button. */
export async function listModels({ apiKey, baseUrl }) {
  const url = normalize(baseUrl);
  const response = await axios.get(`${url}/models`, { headers: headersFor(apiKey), timeout: 20000 });
  const data = response.data;
  const rows = Array.isArray(data) ? data : data && Array.isArray(data.data) ? data.data : [];
  return rows
    .map((row) => (typeof row === "string" ? row : row && row.id))
    .filter(Boolean)
    .sort();
}

/** Cheap reachability check — used by "Test connection". */
export async function ping({ apiKey, baseUrl, model }) {
  const started = Date.now();
  const url = normalize(baseUrl);
  try {
    const response = await axios.post(
      `${url}/chat/completions`,
      { model: model || "gpt-4o-mini", messages: [{ role: "user", content: "ping" }], max_tokens: 1 },
      { headers: headersFor(apiKey), timeout: 20000 }
    );
    return { ok: true, ms: Date.now() - started, status: response.status };
  } catch (error) {
    const status = error.response && error.response.status;
    if (status) {
      return { ok: false, status, ms: Date.now() - started, error: JSON.stringify(error.response.data) };
    }
    return { ok: false, ms: Date.now() - started, error: error.message };
  }
}

export default { chatCompletion, listModels, ping };
