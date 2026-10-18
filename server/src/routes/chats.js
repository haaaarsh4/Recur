import { Router } from "express";
import { nanoid } from "nanoid";
import { identity } from "../middleware/auth.js";
import { db } from "../db.js";
import { processTask, resolveOffer, msg } from "../engine.js";
import { ensureDemoTool, ensureSampleChat, restoreToolForOffer } from "../sample.js";
import { guestChatFrom } from "../guestchat.js";
import { decryptSecret } from "../secrets.js";

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
    // A guest id belongs to one browser session, so a guest with no chats left
    // is not coming back to look at a registry. What they cleared can go with
    // them instead of accumulating in the store forever.
    const stillHere = new Set(db.data.chats.filter((chat) => chat.guest).map((chat) => chat.userId));
    db.data.hidden = (db.data.hidden || []).filter((row) => !row.ownerId.startsWith("guest:") || stillHere.has(row.ownerId));
  }
}

router.get("/", async (req, res) => {
  await db.read();
  // Every visitor gets one prepared conversation, pinned above their own
  // history, so the project can be understood before anything has been
  // compiled and while the model backend is unreachable. It is created once per
  // owner and is a normal chat from then on.
  const seeded = await ensureSampleChat(req.ownerId, req.isGuest);
  if (seeded) {
    await db.write();
  }
  // The list omits message bodies, with one exception: the sample is a fixture,
  // and it is delivered whole. Opening it then needs no further request, so the
  // conversation on screen never depends on which instance answers the next
  // click. On a serverless host every instance has its own store, and a chat
  // that exists only in one instance's store would otherwise come back as
  // "Chat not found" the moment a different instance answered.
  const chats = db.data.chats
    .filter((c) => c.userId === req.ownerId)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(({ messages, awaiting, ...rest }) => (rest.sample ? { ...rest, messages } : rest));
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
  const chat = await chatFor(req);
  if (!chat) return res.status(404).json({ error: "Chat not found." });

  const text = (req.body?.text || "").trim();
  const tier = TIERS.includes(req.body?.tier) ? req.body.tier : "default";
  if (!text) return res.status(400).json({ error: "Message text is required." });

  const userMsg = msg({ role: "user", kind: "text", text });
  chat.messages.push(userMsg);
  if (chat.title === "New chat") chat.title = text.slice(0, 42) + (text.length > 42 ? "…" : "");

  let effective = text;
  let directOfferAction = null;
  if (chat.awaiting) {
    effective = chat.awaiting.originalText + "\n\nAdditional detail: " + text;
    chat.awaiting = null;
  } else {
    const pendingOffer = [...chat.messages].reverse().find((item) => item.kind === "offer" && !item.resolved);
    if (pendingOffer && /^(yes|yeah|yep|sure|okay|ok|use it|create it|create the tool|use the tool)\b/i.test(text)) {
      directOfferAction = pendingOffer.offerType === "use" ? "use" : "create";
    } else if (pendingOffer && /^(no|nope|not now|answer normally|from scratch)\b/i.test(text)) {
      directOfferAction = "general";
    }
  }

  try {
    // The sample's program is the evidence that reuse costs no model call. An
    // instance that has never compiled it would send a visitor's own palindrome
    // question to the model instead, which is the exact dependency the sample
    // exists to show is unnecessary. Once the instance has it, this is a lookup.
    await ensureDemoTool();
    const newMessages = directOfferAction
      ? await resolveOffer(chat, [...chat.messages].reverse().find((item) => item.kind === "offer" && !item.resolved), directOfferAction, tier, credsFor(req))
      : await processTask(chat, effective, tier, credsFor(req));
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

// Regenerate the reply to the most recent user message: drop everything after
// it and run the pipeline again, like the retry arrow in other chat apps.
router.post("/:id/retry", async (req, res) => {
  const chat = await chatFor(req);
  if (!chat) return res.status(404).json({ error: "Chat not found." });

  const tier = TIERS.includes(req.body?.tier) ? req.body.tier : "default";
  const roles = chat.messages.map((m) => m.role);
  const lastUserIndex = roles.lastIndexOf("user");
  if (lastUserIndex === -1) return res.status(400).json({ error: "There is no message to retry yet." });

  const userMsg = chat.messages[lastUserIndex];
  chat.messages = chat.messages.slice(0, lastUserIndex + 1);

  try {
    const newMessages = await processTask(chat, userMsg.text, tier, credsFor(req));
    chat.messages.push(...newMessages);
    trimChat(chat);
    chat.updatedAt = Date.now();
    await db.write();
    res.json({ chat, added: newMessages });
  } catch (e) {
    chat.updatedAt = Date.now();
    await db.write(); // keep the trimmed history even if the model call failed
    res.status(errStatus(e)).json({ error: errMessage(e), chat });
  }
});

router.post("/:id/offers/:messageId/resolve", async (req, res) => {
  const chat = await chatFor(req);
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
    // An offer names its program by id, and that id only means something in the
    // store that compiled it. When this instance has never compiled it, the
    // program the sample is about is rebuilt and the offer is pointed at the
    // rebuilt copy, so "Run palindrome-checker" is a local run on any instance.
    if (action === "use") await restoreToolForOffer(offerMsg);
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

// The chat this request is about: from this instance's store, or, for a guest,
// from the copy the browser sent with the request. A serverless host gives every
// instance its own store, so "not in my store" cannot be allowed to mean "does
// not exist" for a conversation the visitor is looking at.
async function chatFor(req) {
  await db.read();
  await cleanupGuestChats();
  const stored = findChat(req);
  // A signed-in account's history is the server's, always. A guest's copy can be
  // newer than this instance's (another instance answered the last message) or
  // unknown to it (another instance created the chat), so the copy is applied.
  if (stored && !req.isGuest) return stored;
  return guestChatFrom(req) || stored;
}

function findChat(req) {
  return db.data.chats.find((c) => c.id === req.params.id && c.userId === req.ownerId);
}

// The caller's own saved provider settings, or null to use the local Ollama
// default. Saved integrations belong to accounts; guest chats use Ollama.
function credsFor(req) {
  if (req.isGuest) return null;
  const user = db.data.users.find((u) => u.id === req.user.id);
  const saved = user?.integrations?.find((item) => item.id === user.activeIntegrationId) || user?.integrations?.[0] || user?.integration;
  if (!saved) return null;
  if (saved.provider === "ollama") return { provider: "ollama", protocol: "ollama", model: saved.model, baseUrl: saved.baseUrl };
  const apiKey = decryptSecret(saved.apiKeyEncrypted) || saved.apiKey;
  return apiKey ? { provider: saved.provider, protocol: saved.protocol, baseUrl: saved.baseUrl, apiKey, model: saved.model } : null;
}
function trimChat(chat) {
  if (chat.messages.length > MAX_MESSAGES) chat.messages = chat.messages.slice(chat.messages.length - MAX_MESSAGES);
}
function pruneChats(ownerId) {
  // The sample is a fixture, not history: it is never the row that gets pushed
  // out to make room, or a busy owner would lose it and get a fresh copy on the
  // next load.
  const mine = db.data.chats
    .filter((c) => c.userId === ownerId && !c.sample)
    .sort((a, b) => a.updatedAt - b.updatedAt);
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
  if (e.code === "ollama_offline") return 503;
  return 500;
}
function errMessage(e) {
  switch (e.code) {
    case "no_api_key":
      return "No API key is available for the selected provider. Add the provider in the Integrations page, or use Ollama Local.";
    case "unauthorized":
      return "The provider rejected the saved API key. Check the connection in the Integrations page.";
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
