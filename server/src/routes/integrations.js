import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { db } from "../db.js";
import { testKey, SERVER_PROVIDER, OLLAMA_BASE_URL, DEFAULT_MODELS } from "../llm.js";

const router = Router();
const PROVIDERS = ["ollama", "openai", "anthropic"];
const LOCAL_MODELS = [
  "qwen2.5:0.5b",
  "smollm2:135m-instruct-q8_0",
  "llama3.1:8b-instruct-q4_K_M",
];

function keyPreview(key) {
  if (!key) return null;
  return "..." + key.slice(-4);
}

function statusFor(user) {
  const saved = user.integration || null;
  const connected = saved?.provider === "ollama" ? Boolean(saved.model) : Boolean(saved?.apiKey);
  return {
    connected,
    provider: saved?.provider || null,
    model: saved?.model || null,
    keyPreview: saved?.apiKey ? keyPreview(saved.apiKey) : null,
    updatedAt: saved?.updatedAt || null,
    serverProvider: SERVER_PROVIDER,
    serverHasKey: Boolean(process.env.API_KEY),
    ollamaBaseUrl: OLLAMA_BASE_URL,
    localModels: LOCAL_MODELS,
    defaultLocalModels: DEFAULT_MODELS.ollama,
  };
}

function findUser(id) {
  return db.data.users.find((u) => u.id === id);
}

router.get("/", requireAuth, async (req, res) => {
  await db.read();
  const user = findUser(req.user.id);
  if (!user) return res.status(401).json({ error: "Not signed in." });
  res.json(statusFor(user));
});

router.put("/", requireAuth, async (req, res) => {
  const provider = String(req.body?.provider || "").toLowerCase();
  const apiKey = String(req.body?.apiKey || "").trim();
  const model = String(req.body?.model || "").trim();
  if (!PROVIDERS.includes(provider)) {
    return res.status(400).json({ error: "Choose Ollama Local, OpenAI, or Anthropic." });
  }
  if (provider === "ollama") {
    if (!LOCAL_MODELS.includes(model)) return res.status(400).json({ error: "Choose one of the installed Ollama models." });
  } else if (apiKey.length < 20) {
    return res.status(400).json({ error: "That API key looks too short to be valid." });
  }
  await db.read();
  const user = findUser(req.user.id);
  if (!user) return res.status(401).json({ error: "Not signed in." });
  user.integration = provider === "ollama"
    ? { provider, model, updatedAt: Date.now() }
    : { provider, apiKey, updatedAt: Date.now() };
  await db.write();
  res.json(statusFor(user));
});

router.delete("/", requireAuth, async (req, res) => {
  await db.read();
  const user = findUser(req.user.id);
  if (!user) return res.status(401).json({ error: "Not signed in." });
  delete user.integration;
  await db.write();
  res.json(statusFor(user));
});

router.post("/test", requireAuth, async (req, res) => {
  await db.read();
  const user = findUser(req.user.id);
  if (!user) return res.status(401).json({ error: "Not signed in." });

  const provider = String(req.body?.provider || user.integration?.provider || "").toLowerCase();
  const apiKey = String(req.body?.apiKey || user.integration?.apiKey || "").trim();
  const model = String(req.body?.model || user.integration?.model || "").trim();
  if (provider === "ollama") {
    if (!model) return res.status(400).json({ error: "Choose an Ollama model first." });
  } else if (!PROVIDERS.includes(provider) || !apiKey) {
    return res.status(400).json({ error: "A provider and an API key are needed to run a test." });
  }
  const result = await testKey(provider, apiKey, model);
  res.json(result);
});

export default router;
