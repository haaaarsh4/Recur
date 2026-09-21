import { Router } from "express";
import { nanoid } from "nanoid";
import { identity } from "../middleware/auth.js";
import { db } from "../db.js";
import { processTask, resolveOffer, msg } from "../engine.js";

const router = Router();
const MAX_CHATS = 30;
const MAX_MESSAGES = 80;
const TIERS = ["quick", "default", "complex"];
// Guests never log in, so their chats would otherwise pile up forever. Guest
// chats are wiped once they have been idle longer than this.
const GUEST_TTL_MS = 12 * 60 * 60 * 1000;

router.use(identity);

async function cleanupGuestChats() {
  const cutoff = Date.now() - GUEST_TTL_MS;
  const stale = db.data.chats.filter((c) => c.guest && c.updatedAt < cutoff);
  if (stale.length) {
    const staleIds = new Set(stale.map((c) => c.id));
    db.data.chats = db.data.chats.filter((c) => !staleIds.has(c.id));
  }
}

router.get("/", async (req, res) => {
  await db.read();
  const chats = db.data.chats
    .filter((c) => c.userId === req.ownerId)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(({ messages, awaiting, ...rest }) => rest); // list view omits message bodies
  res.json(chats);
});

router.post("/", async (req, res) => {
  await db.read();
  const title = (req.body?.title || "New chat").slice(0, 60);
  const chat = {
    id: nanoid(),
    userId: req.ownerId,
    guest: Boolean(req.isGuest),
    title,
    messages: [],
    awaiting: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  db.data.chats.unshift(chat);
  pruneChats(req.ownerId);
  await db.write();
  res.json(chat);
});

router.get("/:id", async (req, res) => {
  await db.read();
  const chat = findChat(req);
  if (!chat) return res.status(404).json({ error: "Chat not found." });
  res.json(chat);
});

router.delete("/:id", async (req, res) => {
  await db.read();
  db.data.chats = db.data.chats.filter((c) => !(c.id === req.params.id && c.userId === req.ownerId));
  await db.write();
  res.json({ ok: true });
});

router.post("/:id/messages", async (req, res) => {
  await db.read();
  await cleanupGuestChats();
  const chat = findChat(req);
  if (!chat) return res.status(404).json({ error: "Chat not found." });

  const text = (req.body?.text || "").trim();
  const tier = TIERS.includes(req.body?.tier) ? req.body.tier : "default";
  if (!text) return res.status(400).json({ error: "Message text is required." });

  const userMsg = msg({ role: "user", kind: "text", text });
  chat.messages.push(userMsg);
  if (chat.title === "New chat") chat.title = text.slice(0, 42) + (text.length > 42 ? "…" : "");

  let effective = text;
  if (chat.awaiting) {
    effective = chat.awaiting.originalText + "\n\nAdditional detail: " + text;
    chat.awaiting = null;
  }

  try {
    const newMessages = await processTask(chat, effective, tier, credsFor(req));
    chat.messages.push(...newMessages);
    trimChat(chat);
    chat.updatedAt = Date.now();
    await db.write();
    res.json({ chat, added: [userMsg, ...newMessages] });
  } catch (e) {
    chat.updatedAt = Date.now();
    await db.write(); // keep the user's message even if the model call failed
    res.status(errStatus(e)).json({ error: errMessage(e), chat });
  }
});

router.post("/:id/offers/:messageId/resolve", async (req, res) => {
  await db.read();
  await cleanupGuestChats();
  const chat = findChat(req);
  if (!chat) return res.status(404).json({ error: "Chat not found." });
  const offerMsg = chat.messages.find((m) => m.id === req.params.messageId);
  if (!offerMsg || offerMsg.kind !== "offer") return res.status(404).json({ error: "That offer no longer exists." });
  if (offerMsg.resolved) return res.status(409).json({ error: "That choice was already made." });

  const action = req.body?.action;
  const tier = TIERS.includes(req.body?.tier) ? req.body.tier : "default";
  if (!["use", "general", "create", "clarify"].includes(action)) {
    return res.status(400).json({ error: "Unknown action." });
  }

  try {
    const newMessages = await resolveOffer(chat, offerMsg, action, tier, credsFor(req));
    chat.messages.push(...newMessages);
    trimChat(chat);
    chat.updatedAt = Date.now();
    await db.write();
    res.json({ chat, added: newMessages });
  } catch (e) {
    await db.write();
    res.status(errStatus(e)).json({ error: errMessage(e), chat });
  }
});

function findChat(req) {
  return db.data.chats.find((c) => c.id === req.params.id && c.userId === req.ownerId);
}

// The caller's own saved provider settings, or null to fall back to the
// server's key from .env. Works the same for members and guests: the guest
// cookie is only an identity, saved connections still belong to accounts.
function credsFor(req) {
  if (req.isGuest) return null;
  const saved = db.data.users.find((u) => u.id === req.user.id)?.integration;
  if (!saved) return null;
  if (saved.provider === "ollama") return { provider: "ollama", model: saved.model };
  return saved.apiKey ? { provider: saved.provider, apiKey: saved.apiKey } : null;
}
function trimChat(chat) {
  if (chat.messages.length > MAX_MESSAGES) chat.messages = chat.messages.slice(chat.messages.length - MAX_MESSAGES);
}
function pruneChats(ownerId) {
  const mine = db.data.chats.filter((c) => c.userId === ownerId).sort((a, b) => a.updatedAt - b.updatedAt);
  while (mine.length > MAX_CHATS) {
    const oldest = mine.shift();
    db.data.chats = db.data.chats.filter((c) => c.id !== oldest.id);
  }
}
function errStatus(e) {
  if (e.code === "no_api_key") return 500;
  if (e.code === "unauthorized") return 502;
  if (e.code === "rate_limited") return 429;
  if (e.code === "not_found") return 404;
  return 500;
}
function errMessage(e) {
  switch (e.code) {
    case "no_api_key":
      return "No LLM API key is available. Add your own key on the Integrations page, set API_KEY in server/.env, or connect Ollama Local.";
    case "unauthorized":
      return "The API key was rejected by the provider. Check the key saved on the Integrations page, or API_KEY in server/.env.";
    case "rate_limited":
      return "The LLM provider is rate limiting this API key. Try again shortly.";
    case "invalid_json":
      return "The model's structured response could not be parsed. Try again.";
    case "not_found":
      return e.message;
    default:
      return e.message || "Something went wrong talking to the LLM provider.";
  }
}

export default router;
