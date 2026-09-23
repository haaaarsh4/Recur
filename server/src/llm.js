import "dotenv/config";

// Ollama is the only implicit backend. Hosted providers are selected through
// an authenticated integration and passed explicitly in `creds`.
const ENV_PROVIDER = "ollama";
const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/$/, "");

const DEFAULT_MODELS = {
  ollama: {
    quick: "smollm2:135m-instruct-q8_0",
    default: "qwen2.5:0.5b",
    complex: "llama3.1:8b-instruct-q4_K_M",
  },
};

const RECUR_SYSTEM_PROMPT =
  "You are Recur, the local intelligence inside the Recur workspace. Recur helps people turn repeated work into reusable tools. When someone asks what you are, explain that you are Recur, a chat assistant that answers requests, notices repeated patterns, and asks permission before creating or using reusable tools. Be direct, friendly, and concise. Do not claim to be ChatGPT, OpenAI, Anthropic, or a human.";

function modelsFor(provider, creds = null) {
  const base = DEFAULT_MODELS[provider] || DEFAULT_MODELS.ollama;
  if (creds?.model) {
    // A saved integration selects one concrete model for all Recur tiers.
    return { quick: creds.model, default: creds.model, complex: creds.model };
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

async function callAnthropic(apiKey, prompt, model, baseUrl = "https://api.anthropic.com") {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/messages`, {
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

async function callOpenAI(apiKey, prompt, model, baseUrl = "https://api.openai.com/v1") {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
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

async function callGemini(apiKey, prompt, model, baseUrl = "https://generativelanguage.googleapis.com/v1beta") {
  const endpoint = `${baseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: `${RECUR_SYSTEM_PROMPT}\\n\\n${prompt}` }] }] }),
  });
  if (!res.ok) throw await apiError(res);
  const data = await res.json();
  return (data.candidates || []).flatMap((candidate) => candidate.content?.parts || []).map((part) => part.text || "").join("\\n");
}

async function callOllama(prompt, model, maxTokens = 320, timeoutMs = 45000) {
  const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        { role: "system", content: RECUR_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      options: { temperature: 0.2, num_predict: maxTokens },
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
  const protocol = (creds?.protocol || (provider === "anthropic" ? "anthropic" : provider === "google" ? "gemini" : provider === "ollama" ? "ollama" : "openai")).toLowerCase();
  const apiKey = creds?.apiKey || "";
  return { provider, protocol, apiKey, model: creds?.model || null, baseUrl: creds?.baseUrl || null };
}

async function callLLM(prompt, tier = "default", creds = null) {
  const { provider, protocol, apiKey, model: selectedModel, baseUrl } = resolveCreds(creds);
  if (protocol !== "ollama" && !apiKey) throw apiKeyMissingError();
  const models = modelsFor(provider, { model: selectedModel });
  const model = models[tier] || models.default;
  const maxTokens = tier === "quick" ? 160 : tier === "complex" ? 640 : 320;
  const timeoutMs = tier === "quick" ? 20000 : tier === "complex" ? 90000 : 45000;
  const t0 = Date.now();
  let text;
  if (protocol === "ollama") text = await callOllama(prompt, model, maxTokens, timeoutMs);
  else if (protocol === "anthropic") text = await callAnthropic(apiKey, prompt, model, baseUrl || undefined);
  else if (protocol === "gemini") text = await callGemini(apiKey, prompt, model, baseUrl || undefined);
  else text = await callOpenAI(apiKey, prompt, model, baseUrl || undefined);
  return { text: text.trim(), latencyMs: Date.now() - t0, model };
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

async function testKey(protocol, apiKey, model = null, baseUrl = null) {
  try {
    if (protocol === "ollama") {
      const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
      if (!res.ok) return { ok: false, error: "Could not reach Ollama. Start it with ollama serve." };
      const data = await res.json();
      const installed = (data.models || []).map((item) => item.name);
      if (model && !installed.includes(model)) {
        return { ok: false, error: `Ollama is running, but ${model} is not installed. Run ollama pull ${model}.` };
      }
      return { ok: true, models: installed };
    }
    if (protocol === "gemini") {
      const res = await fetch(`${(baseUrl || "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "")}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Reply with OK." }] }] }),
      });
      if (res.status === 401 || res.status === 403) return { ok: false, error: "Google rejected this API key." };
      if (!res.ok) return { ok: false, error: `Google responded with ${res.status}. Check the model and key.` };
      return { ok: true };
    }
    if (protocol === "anthropic") {
      const res = await fetch(`${(baseUrl || "https://api.anthropic.com").replace(/\/$/, "")}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
      });
      if (res.status === 401) return { ok: false, error: "The provider rejected this key." };
      if (!res.ok) return { ok: false, error: `Provider responded with ${res.status}. The key may be valid but the account could be out of credits.` };
      return { ok: true };
    }
    const res = await fetch(`${(baseUrl || "https://api.openai.com/v1").replace(/\/$/, "")}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    if (res.status === 401) return { ok: false, error: "The provider rejected this key." };
    if (!res.ok) return { ok: false, error: `Provider responded with ${res.status}. The key may be valid but the account could be out of credits.` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: "Could not reach the provider. Check that it is running and try again." };
  }
}

export { callLLM, callLLMJson, testKey };
