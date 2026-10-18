// Guest conversations are carried by the browser.
//
// A guest has no account, so there is nothing on the server that can be trusted
// to outlive their session. A single long-running server keeps the chat in its
// store, but a serverless host gives every instance its own writable directory:
// the sample chat is created on one instance, and the next click can land on
// another, which answered "Chat not found" for a conversation the visitor could
// plainly see on screen. Clicking "Run palindrome-checker" was the worst case:
// the one path in the whole project that needs no model at all, failing.
//
// The browser already holds the whole conversation after every reply, so it
// sends that copy along with the next decision. This module turns that copy into
// this store's record of the chat: created when the instance has never heard of
// it, refreshed when a different instance answered more recently. Only guests
// can do this: an account's history belongs to the server, and a request must
// never be able to write it.
//
// Two rules keep the browser from rewriting history it does not own. A copy is
// only applied when it still contains every message the store has, so a stale
// tab cannot truncate or replace a conversation; and the owner is always the
// identity the request was authenticated as, never anything the body claims.

import { db } from "./db.js";
import { nanoid } from "nanoid";

// Mirrors the chat routes: a conversation is capped at 80 messages there, so a
// copy that is longer than that is not something this build wrote.
const MAX_MESSAGES = 80;
const MAX_MESSAGE_CHARS = 20000;
const MAX_SNAPSHOT_BYTES = 400 * 1024;

const STRING_FIELDS = ["viaTool", "toolName", "toolSpec", "taskText", "tierApplied", "clusterNote", "offerType", "resolved", "toolId"];
const NUMBER_FIELDS = ["latency", "similarity", "activation", "clusterCount"];

function clipped(value, max) {
  return typeof value === "string" ? value.slice(0, max) : null;
}

// A message is rebuilt from the fields this app actually renders, not copied
// wholesale. The body comes from the browser, so it is data, never structure:
// anything unknown is dropped rather than stored and served back later.
function cleanMessage(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.role !== "user" && raw.role !== "assistant" && raw.role !== "system") return null;
  if (raw.text != null && typeof raw.text !== "string") return null;
  const message = {
    id: clipped(raw.id, 64) || nanoid(),
    ts: Number.isFinite(raw.ts) ? raw.ts : Date.now(),
    role: raw.role,
    kind: clipped(raw.kind, 32) || "text",
  };
  if (typeof raw.text === "string") message.text = raw.text.slice(0, MAX_MESSAGE_CHARS);
  for (const field of STRING_FIELDS) {
    const value = clipped(raw[field], field === "taskText" || field === "clusterNote" ? 2000 : 400);
    if (value != null) message[field] = value;
  }
  for (const field of NUMBER_FIELDS) {
    if (Number.isFinite(raw[field])) message[field] = raw[field];
  }
  if (raw.programRun === true) message.programRun = true;
  if (Array.isArray(raw.clusterExamples)) {
    message.clusterExamples = raw.clusterExamples.filter((item) => typeof item === "string").slice(0, 6).map((item) => item.slice(0, 200));
  }
  if (Array.isArray(raw.clusterMemberIds)) {
    message.clusterMemberIds = raw.clusterMemberIds.filter((item) => typeof item === "string").slice(0, 20);
  }
  if (Array.isArray(raw.toolTrace)) {
    message.toolTrace = raw.toolTrace.filter((item) => typeof item === "string").slice(0, 40).map((item) => item.slice(0, 300));
  }
  return message;
}

function cleanAwaiting(raw) {
  if (!raw || typeof raw !== "object") return null;
  const originalText = clipped(raw.originalText, MAX_MESSAGE_CHARS);
  return originalText ? { originalText } : null;
}

// The chat the caller sent, rebuilt as this store's own record, or null when the
// request carries nothing usable. It is keyed by the id in the URL, so a body
// can never speak for a different conversation than the one being addressed.
function snapshotOf(req) {
  if (!req.isGuest) return null;
  const raw = req.body?.chat;
  if (!raw || typeof raw !== "object" || raw.id !== req.params.id) return null;
  if (!Array.isArray(raw.messages)) return null;
  if (JSON.stringify(raw).length > MAX_SNAPSHOT_BYTES) return null;

  const messages = raw.messages.map(cleanMessage).filter(Boolean).slice(-MAX_MESSAGES);
  return {
    raw,
    messages,
    title: clipped(raw.title, 60) || (messages.find((message) => message.role === "user")?.text || "New chat").slice(0, 60),
    awaiting: cleanAwaiting(raw.awaiting),
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
  };
}

// The chat this request is about, from the browser's copy. Returns null when the
// request carries no copy, so the caller can fall back to what the store has.
export function guestChatFrom(req) {
  const snapshot = snapshotOf(req);
  if (!snapshot) return null;
  const existing = db.data.chats.find((chat) => chat.id === req.params.id && chat.userId === req.ownerId);

  if (existing) {
    // Apply the copy only when it still contains everything the store has. A
    // tab that was left open while another answered cannot delete messages this
    // store recorded, but a copy made after those answers can carry them.
    const storedIds = new Set((existing.messages || []).map((message) => message.id));
    const incomingIds = new Set(snapshot.messages.map((message) => message.id));
    const coversStored = [...storedIds].every((id) => incomingIds.has(id));
    if (!coversStored || snapshot.messages.length < storedIds.size) return existing;

    existing.messages = snapshot.messages;
    existing.title = snapshot.title;
    existing.awaiting = snapshot.awaiting;
    existing.updatedAt = Math.max(existing.updatedAt || 0, snapshot.updatedAt);
    return existing;
  }

  const chat = {
    id: req.params.id,
    userId: req.ownerId,
    guest: true,
    title: snapshot.title,
    messages: snapshot.messages,
    awaiting: snapshot.awaiting,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
  };
  if (snapshot.raw.sample === true) {
    // The sample is one fixture per visitor, and the copy the visitor is looking
    // at is the live one. Keep it, and let it replace a stock copy another
    // instance seeded, so the list cannot show two samples side by side.
    chat.sample = true;
    chat.pinned = true;
    if (Number.isFinite(snapshot.raw.sampleVersion)) chat.sampleVersion = snapshot.raw.sampleVersion;
    db.data.chats = db.data.chats.filter((other) => !(other.userId === req.ownerId && other.sample));
  } else if (snapshot.raw.pinned === true) {
    chat.pinned = true;
  }

  db.data.chats.unshift(chat);
  return chat;
}

