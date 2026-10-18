// The guest's conversations, kept in this browser.
//
// A guest has no account, and a serverless deployment has no shared store: each
// instance keeps its own temporary copy of the database, so a conversation
// created on one instance does not exist for the next request. The browser is
// the only party that sees every reply, so it keeps the whole conversation and
// sends it back with the next decision. The server adopts that copy when the
// instance answering has never heard of the chat (see server/src/guestchat.js).
//
// Session storage is the right lifetime: it ends with the browser session, which
// is exactly what the guest cookie does. Nothing here outlives a visit, and none
// of it is ever sent anywhere except back to the server that produced it.

const KEY = "recur:guest-chats";
const MAX_CHATS = 30;
// Session storage allows about 5mb. Keeping well under it leaves room for the
// page itself and avoids a write that silently throws away the whole store.
const MAX_BYTES = 1200000;

function usable(chat) {
  return Boolean(chat) && typeof chat === "object" && typeof chat.id === "string" && Array.isArray(chat.messages);
}

function read() {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(usable) : [];
  } catch (e) {
    return [];
  }
}

function write(chats) {
  try {
    const kept = [];
    let bytes = 0;
    const newest = [...chats].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    for (const chat of newest.slice(0, MAX_CHATS)) {
      const size = JSON.stringify(chat).length;
      if (bytes + size > MAX_BYTES) continue;
      bytes += size;
      kept.push(chat);
    }
    sessionStorage.setItem(KEY, JSON.stringify(kept));
  } catch (e) {
    // Storage can be full or unavailable (private modes). The conversation still
    // works for as long as the page is open; only a reload loses it.
  }
}

export const readGuestChats = read;

export function saveGuestChats(chats) {
  write(Array.isArray(chats) ? chats : []);
}

export function clearGuestChats() {
  try {
    sessionStorage.removeItem(KEY);
  } catch (e) {
    /* nothing to clear */
  }
}

// What the sidebar should show: the server's list, with the browser's own copies
// taking precedence because they are the ones with messages. Two copies of the
// sample can exist (this browser's, and the stock one an instance seeded), so it
// is resolved to a single row: the newer script wins, and on a tie the copy the
// visitor has been using is kept.
export function mergeGuestChats(serverChats, localChats) {
  // Server rows only carry the fields the sidebar needs, so they are checked for
  // an id alone; a local copy is only useful when it holds the conversation.
  const server = Array.isArray(serverChats) ? serverChats.filter((chat) => chat && typeof chat.id === "string") : [];
  const local = Array.isArray(localChats) ? localChats.filter(usable) : [];

  const byId = new Map();
  for (const chat of server) byId.set(chat.id, chat);
  for (const chat of local) byId.set(chat.id, chat);

  const localSample = local.find((chat) => chat.sample);
  const serverSample = server.find((chat) => chat.sample);
  let sample = localSample || serverSample || null;
  if (localSample && serverSample) {
    sample = (serverSample.sampleVersion || 0) > (localSample.sampleVersion || 0) ? serverSample : localSample;
  }

  const rows = [];
  if (sample) rows.push(sample);
  for (const chat of byId.values()) {
    if (chat.sample) continue;
    rows.push(chat);
  }
  return rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}
