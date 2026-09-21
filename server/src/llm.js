import "dotenv/config";

const ENV_PROVIDER = (process.env.PROVIDER || (process.env.API_KEY ? "openai" : "ollama")).toLowerCase();
const ENV_API_KEY = process.env.API_KEY;
const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/$/, "");

const DEFAULT_MODELS = {
  openai: { quick: "gpt-4o-mini", default: "gpt-4o-mini", complex: "gpt-4o" },
  anthropic: {
    quick: "claude-haiku-4-5-20251001",
    default: "claude-sonnet-4-6",
    complex: "claude-opus-4-5",
  },
  ollama: {
    quick: "smollm2:135m-instruct-q8_0",
    default: "qwen2.5:0.5b",
    complex: "llama3.1:8b-instruct-q4_K_M",
  },
};

const RECUR_SYSTEM_PROMPT =
  "You are Recur, the local intelligence inside the Recur workspace. Recur helps people turn repeated work into reusable tools. When someone asks what you are, explain that you are Recur, a chat assistant that answers requests, notices repeated patterns, and asks permission before creating or using reusable tools. Be direct, friendly, and concise. Do not claim to be ChatGPT, OpenAI, Anthropic, or a human.";

function modelsFor(provider, creds = null) {
  const base = DEFAULT_MODELS[provider] || DEFAULT_MODELS.openai;
  if (provider === "ollama" && creds?.model) {
    return { ...base, default: creds.model };
  }
  if (provider !== ENV_PROVIDER) return { ...base };
  return {
    quick: process.env.MODEL_QUICK || base.quick,
    default: process.env.MODEL_DEFAULT || base.default,
    complex: process.env.MODEL_COMPLEX || base.complex,
  };
}

function apiKeyMissingError() {
  const err = new Error("No LLM API key is available for this request. Select Ollama Local or add a provider key.");
  err.code = "no_api_key";
  return err;
}

async function apiError(res) {
  let body = "";
  try {
    body = await res.text();
  } catch (e) {
    /* ignore */
  }
  const err = new Error(`LLM API error ${res.status}: ${body.slice(0, 300)}`);
  err.code = res.status === 401 ? "unauthorized" : res.status === 429 ? "rate_limited" : "upstream_error";
  return err;
}

async function callAnthropic(apiKey, prompt, model) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: RECUR_SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw await apiError(res);
  const data = await res.json();
  return (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

async function callOpenAI(apiKey, prompt, model) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: RECUR_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!res.ok) throw await apiError(res);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

async function callOllama(prompt, model) {
  const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        { role: "system", content: RECUR_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      options: { temperature: 0.2 },
    }),
  });
  if (!res.ok) {
    if (res.status === 404) {
      const err = new Error(`Ollama could not find model ${model}. Run ollama pull ${model}.`);
      err.code = "model_not_found";
      throw err;
    }
    throw await apiError(res);
  }
  const data = await res.json();
  return data.message?.content || data.response || "";
}

function resolveCreds(creds) {
  const provider = (creds?.provider || ENV_PROVIDER).toLowerCase();
  const apiKey = creds?.apiKey || ENV_API_KEY;
  return { provider, apiKey, model: creds?.model || null };
}

async function callLLM(prompt, tier = "default", creds = null) {
  const { provider, apiKey, model: selectedModel } = resolveCreds(creds);
  if (provider !== "ollama" && !apiKey) throw apiKeyMissingError();
  const models = modelsFor(provider, { model: selectedModel });
  const model = models[tier] || models.default;
  const t0 = Date.now();
  let text;
  try {
    if (provider === "ollama") text = await callOllama(prompt, model);
    else if (provider === "anthropic") text = await callAnthropic(apiKey, prompt, model);
    else text = await callOpenAI(apiKey, prompt, model);
  } catch (e) {
    // A hosted key can be expired, revoked, or out of credits. Rather than
    // failing the whole conversation, fall back to local Ollama when the
    // models are installed, so the app keeps working without any key.
    const canFallback = provider !== "ollama" && (await ollamaReady());
    if (!canFallback || e.code === "no_api_key") throw e;
    const fbModels = modelsFor("ollama", null);
    text = await callOllama(prompt, fbModels[tier] || fbModels.default);
  }
  return { text: text.trim(), latencyMs: Date.now() - t0, model };
}

let ollamaCache = { ok: false, at: 0 };
async function ollamaReady() {
  if (Date.now() - ollamaCache.at < 15000) return ollamaCache.ok;
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: AbortSignal.timeout(2500) });
    const data = await res.json().catch(() => ({}));
    ollamaCache = { ok: Boolean(res.ok && (data.models || []).length), at: Date.now() };
  } catch (e) {
    ollamaCache = { ok: false, at: Date.now() };
  }
  return ollamaCache.ok;
}

async function callLLMJson(prompt, tier = "default", creds = null) {
  const r = await callLLM(prompt + "\n\nRespond with ONLY valid JSON. No markdown fences, no extra text.", tier, creds);
  const cleaned = r.text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/, "")
    .replace(/```\s*$/, "")
    .trim();
  try {
    return { data: JSON.parse(cleaned), latencyMs: r.latencyMs, model: r.model };
  } catch (e) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return { data: JSON.parse(match[0]), latencyMs: r.latencyMs, model: r.model };
      } catch (e2) {
        /* fall through */
      }
    }
    const err = new Error("Model did not return valid JSON.");
    err.code = "invalid_json";
    throw err;
  }
}

async function testKey(provider, apiKey, model = null) {
  try {
    if (provider === "ollama") {
      const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
      if (!res.ok) return { ok: false, error: "Could not reach Ollama. Start it with ollama serve." };
      const data = await res.json();
      const installed = (data.models || []).map((item) => item.name);
      if (model && !installed.includes(model)) {
        return { ok: false, error: `Ollama is running, but ${model} is not installed. Run ollama pull ${model}.` };
      }
      return { ok: true, models: installed };
    }
    if (provider === "anthropic") {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({ model: DEFAULT_MODELS.anthropic.quick, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
      });
      if (res.status === 401) return { ok: false, error: "The provider rejected this key." };
      if (!res.ok) return { ok: false, error: `Provider responded with ${res.status}. The key may be valid but the account could be out of credits.` };
      return { ok: true };
    }
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    if (res.status === 401) return { ok: false, error: "The provider rejected this key." };
    if (!res.ok) return { ok: false, error: `Provider responded with ${res.status}. The key may be valid but the account could be out of credits.` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: "Could not reach the provider. Check that it is running and try again." };
  }
}

export { callLLM, callLLMJson, testKey, ENV_PROVIDER as SERVER_PROVIDER, DEFAULT_MODELS, OLLAMA_BASE_URL };
