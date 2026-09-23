import { Router } from "express";
import { nanoid } from "nanoid";
import { requireAuth } from "../middleware/auth.js";
import { db } from "../db.js";
import { testKey } from "../llm.js";
import { encryptSecret, decryptSecret } from "../secrets.js";
import { providerById, publicProviders } from "../providers.js";

const router = Router();

function savedKey(connection) {
  return decryptSecret(connection?.apiKeyEncrypted) || connection?.apiKey || "";
}

function keyPreview(key) {
  return key ? "..." + key.slice(-4) : null;
}

function migrateUser(user) {
  let changed = false;
  if (!Array.isArray(user.integrations)) {
    user.integrations = [];
    const legacy = user.integration;
    if (legacy && legacy.provider !== "ollama" && legacy.apiKey) {
      const provider = providerById(legacy.provider);
      user.integrations.push({
        id: nanoid(),
        name: provider?.label || legacy.provider,
        provider: legacy.provider,
        protocol: provider?.protocol || "openai",
        baseUrl: provider?.baseUrl || "",
        model: legacy.model || provider?.defaultModel || "",
        apiKeyEncrypted: encryptSecret(legacy.apiKey),
        createdAt: legacy.updatedAt || Date.now(),
        updatedAt: legacy.updatedAt || Date.now(),
      });
    }
    delete user.integration;
    changed = true;
  }
  if (user.activeIntegrationId && !user.integrations.some((item) => item.id === user.activeIntegrationId)) {
    user.activeIntegrationId = null;
    changed = true;
  }
  return changed;
}

function statusFor(user) {
  const activeId = user.activeIntegrationId || user.integrations[0]?.id || null;
  const connections = user.integrations.map((connection) => ({
    id: connection.id,
    name: connection.name,
    provider: connection.provider,
    protocol: connection.protocol,
    baseUrl: connection.baseUrl,
    model: connection.model,
    keyPreview: keyPreview(savedKey(connection)),
    updatedAt: connection.updatedAt,
    active: connection.id === activeId,
  }));
  return { connections, activeId, providers: publicProviders() };
}

function findUser(id) {
  return db.data.users.find((user) => user.id === id);
}

function validateConnection(body, existing = null) {
  const providerId = String(body.provider || existing?.provider || "").toLowerCase();
  const provider = providerById(providerId);
  if (!provider) throw Object.assign(new Error("Choose a supported API provider."), { code: "bad_request" });
  const protocol = provider.custom ? String(body.protocol || existing?.protocol || "openai").toLowerCase() : provider.protocol;
  if (!["ollama", "openai", "anthropic", "gemini"].includes(protocol)) {
    throw Object.assign(new Error("Choose a supported API protocol."), { code: "bad_request" });
  }
  const baseUrl = String(body.baseUrl || existing?.baseUrl || provider.baseUrl || "").trim().replace(/\/$/, "");
  if (provider.custom && !/^https?:\/\//i.test(baseUrl)) {
    throw Object.assign(new Error("A custom provider needs a valid HTTPS or HTTP base URL."), { code: "bad_request" });
  }
  const model = String(body.model || existing?.model || provider.defaultModel || "").trim();
  if (!model) throw Object.assign(new Error("Choose or enter a model name."), { code: "bad_request" });
  const apiKey = String(body.apiKey || "").trim() || savedKey(existing);
  if (protocol !== "ollama" && apiKey.length < 10) throw Object.assign(new Error("Add an API key before saving this connection."), { code: "bad_request" });
  return {
    provider: providerId,
    protocol,
    baseUrl,
    model,
    name: String(body.name || existing?.name || provider.label).trim().slice(0, 60) || provider.label,
    apiKey,
  };
}

router.get("/", requireAuth, async (req, res) => {
  await db.read();
  const user = findUser(req.user.id);
  if (!user) return res.status(401).json({ error: "Not signed in." });
  if (migrateUser(user)) await db.write();
  res.json(statusFor(user));
});

router.put("/", requireAuth, async (req, res) => {
  await db.read();
  const user = findUser(req.user.id);
  if (!user) return res.status(401).json({ error: "Not signed in." });
  migrateUser(user);
  const existing = req.body?.id ? user.integrations.find((item) => item.id === req.body.id) : null;
  try {
    const data = validateConnection(req.body || {}, existing);
    if (existing) {
      Object.assign(existing, {
        name: data.name,
        provider: data.provider,
        protocol: data.protocol,
        baseUrl: data.baseUrl,
        model: data.model,
        apiKeyEncrypted: data.apiKey ? encryptSecret(data.apiKey) : null,
        updatedAt: Date.now(),
      });
      user.activeIntegrationId = existing.id;
    } else {
      const connection = {
        id: nanoid(),
        name: data.name,
        provider: data.provider,
        protocol: data.protocol,
        baseUrl: data.baseUrl,
        model: data.model,
        apiKeyEncrypted: data.apiKey ? encryptSecret(data.apiKey) : null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      user.integrations.unshift(connection);
      user.activeIntegrationId = connection.id;
    }
    await db.write();
    res.json(statusFor(user));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post("/active", requireAuth, async (req, res) => {
  await db.read();
  const user = findUser(req.user.id);
  if (!user) return res.status(401).json({ error: "Not signed in." });
  migrateUser(user);
  const connection = user.integrations.find((item) => item.id === req.body?.id);
  if (!connection) return res.status(404).json({ error: "Connection not found." });
  user.activeIntegrationId = connection.id;
  await db.write();
  res.json(statusFor(user));
});

router.delete("/:id", requireAuth, async (req, res) => {
  await db.read();
  const user = findUser(req.user.id);
  if (!user) return res.status(401).json({ error: "Not signed in." });
  migrateUser(user);
  user.integrations = user.integrations.filter((item) => item.id !== req.params.id);
  if (user.activeIntegrationId === req.params.id) user.activeIntegrationId = user.integrations[0]?.id || null;
  await db.write();
  res.json(statusFor(user));
});

router.delete("/", requireAuth, async (req, res) => {
  await db.read();
  const user = findUser(req.user.id);
  if (!user) return res.status(401).json({ error: "Not signed in." });
  migrateUser(user);
  user.integrations = [];
  user.activeIntegrationId = null;
  await db.write();
  res.json(statusFor(user));
});

router.post("/test", requireAuth, async (req, res) => {
  await db.read();
  const user = findUser(req.user.id);
  if (!user) return res.status(401).json({ error: "Not signed in." });
  migrateUser(user);
  const existing = req.body?.id ? user.integrations.find((item) => item.id === req.body.id) : null;
  try {
    const data = validateConnection(req.body || {}, existing);
    const result = data.protocol === "ollama"
      ? await testKey(data.protocol, "", data.model, data.baseUrl)
      : await testKey(data.protocol, data.apiKey, data.model, data.baseUrl);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

export { statusFor };
export default router;
