import "dotenv/config";

// Ollama is the only implicit backend. Hosted providers are selected through
// an authenticated integration and passed explicitly in `creds`.
const ENV_PROVIDER = "ollama";
// A scheme-less tunnel URL would make fetch throw a raw "Failed to parse URL"
// error before any request is sent, so normalize the base URL here. Local
// addresses keep http, everything else gets https.
const RAW_OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
const LOOKS_LOCAL = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/i;
const OLLAMA_BASE_URL = /^https?:\/\//i.test(RAW_OLLAMA_BASE_URL)
  ? RAW_OLLAMA_BASE_URL
  : `${LOOKS_LOCAL.test(RAW_OLLAMA_BASE_URL) ? "http" : "https"}://${RAW_OLLAMA_BASE_URL}`;

function ollamaIsLocal() {
  try {
    return LOOKS_LOCAL.test(new URL(OLLAMA_BASE_URL).hostname);
  } catch (e) {
    return false;
  }
}

// The default backend is Ollama on Harsh's laptop, reached from production
// through a Cloudflare tunnel (OLLAMA_BASE_URL). The common failure is not a
// missing model, it is the tunnel not running, so every unreachable-backend
// path says what actually has to happen next.
const OLLAMA_OFFLINE_MESSAGE =
  "Recur's model backend is offline. Ask Harsh to start the Cloudflare tunnel that serves the model, then send this again.";

function ollamaOffline() {
  const err = new Error(OLLAMA_OFFLINE_MESSAGE);
  err.code = "ollama_offline";
  return err;
}

async function readBody(res) {
  try {
    return await res.text();
  } catch (e) {
    return "";
  }
}

// Ollama answers a missing model with a small JSON body. The tunnel edge in
// front of it answers a dead hostname with an HTML page, and reading that as
// "model not found" used to send people to `ollama pull` while the real fault
// was the tunnel.
function ollamaReportedMissingModel(body) {
  try {
    const parsed = JSON.parse(body);
    return typeof parsed?.error === "string" && /model/i.test(parsed.error);
  } catch (e) {
    return false;
  }
}

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

function apiError(status, body) {
  const err = new Error(`LLM API error ${status}: ${String(body).slice(0, 300)}`);
  err.code = status === 401 ? "unauthorized" : status === 429 ? "rate_limited" : "upstream_error";
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
  if (!res.ok) throw apiError(res.status, await readBody(res));
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
  if (!res.ok) throw apiError(res.status, await readBody(res));
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
  if (!res.ok) throw apiError(res.status, await readBody(res));
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
    // The tunnel edge answers 502, 503, 504 or 530 when the agent behind it
    // (the laptop) is offline, and an HTML 404 when the hostname has no tunnel
    // behind it at all. Only Ollama's own JSON 404 means a model is missing.
    if (res.status === 502 || res.status === 503 || res.status === 504 || res.status === 530) {
      throw ollamaOffline();
    }
    const body = await readBody(res);
    if (res.status === 404 && ollamaReportedMissingModel(body)) {
      const err = new Error(`Ollama could not find model ${model}. Run ollama pull ${model}.`);
      err.code = "model_not_found";
      throw err;
    }
    if (res.status === 404) throw ollamaOffline();
    throw apiError(res.status, body);
  }
  let data;
  try {
    data = JSON.parse(await readBody(res));
  } catch (e) {
    // A 200 that is not JSON is the tunnel edge serving an error page.
    throw ollamaOffline();
  }
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
  try {
    if (protocol === "ollama") text = await callOllama(prompt, model, maxTokens, timeoutMs);
    else if (protocol === "anthropic") text = await callAnthropic(apiKey, prompt, model, baseUrl || undefined);
    else if (protocol === "gemini") text = await callGemini(apiKey, prompt, model, baseUrl || undefined);
    else text = await callOpenAI(apiKey, prompt, model, baseUrl || undefined);
  } catch (e) {
    // "fetch failed" is Node's raw network error. Replace it with something a
    // user can act on, most commonly Ollama being unreachable in a deployment
    // where no local daemon exists.
    if (e && (e.code === "ENOTFOUND" || e.code === "ECONNREFUSED" || e.code === "EAI_AGAIN" || e.code === "ERR_INVALID_URL" || /fetch failed/i.test(String(e.message)))) {
      if (protocol === "ollama") throw ollamaOffline();
      const err = new Error(`Could not reach the ${provider} API. Check the base URL and network access.`);
      err.code = "model_unreachable";
      throw err;
    }
    throw e;
  }
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
      if (!res.ok) return { ok: false, error: ollamaIsLocal() ? "Could not reach Ollama. Start it with ollama serve." : "Could not reach the model backend. Start the Cloudflare tunnel that serves it." };
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
    if (protocol === "ollama") {
      return {
        ok: false,
        error: ollamaIsLocal()
          ? "Could not reach Ollama. Start it with ollama serve."
          : "Could not reach the model backend. Start the Cloudflare tunnel that serves it.",
      };
    }
    return { ok: false, error: "Could not reach the provider. Check that it is running and try again." };
  }
}

export { callLLM, callLLMJson, testKey };
