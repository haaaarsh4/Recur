const BASE = "/api";

// One guest id per browser session, generated here rather than by the server.
// A visit fires several requests before the server has set its guest cookie, and
// without this each one would be answered as a different guest, so the browser
// could hold an identity that never owned the sample chat it was already shown.
// The server still owns the cookie and prefers it; this only covers the first
// moments of a visit, and it lives in sessionStorage, which ends with the
// session exactly like the cookie does.
function sessionGuestId() {
  try {
    let id = sessionStorage.getItem("recur:guest");
    if (!id) {
      id = (crypto.randomUUID?.() || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`).replace(/-/g, "");
      sessionStorage.setItem("recur:guest", id);
    }
    return id;
  } catch (e) {
    return "";
  }
}

async function request(path, opts = {}) {
  const guest = sessionGuestId();
  const res = await fetch(BASE + path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(guest ? { "x-recur-guest": guest } : {}), ...(opts.headers || {}) },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  register: (body) => request("/auth/register", { method: "POST", body }),
  login: (body) => request("/auth/login", { method: "POST", body }),
  logout: () => request("/auth/logout", { method: "POST" }),
  me: () => request("/auth/me"),

  listChats: () => request("/chats"),
  createChat: (title) => request("/chats", { method: "POST", body: { title } }),
  getChat: (id) => request(`/chats/${id}`),
  deleteChat: (id) => request(`/chats/${id}`, { method: "DELETE" }),
  // A guest's conversation lives in the browser (see guestChats.js), so the copy
  // travels with the request. The server uses it only when the instance that got
  // the request has never seen the chat; a signed-in account's history is never
  // taken from a request body.
  sendMessage: (id, text, tier, chat) => request(`/chats/${id}/messages`, { method: "POST", body: { text, tier, chat } }),
  retryMessage: (id, tier, chat) => request(`/chats/${id}/retry`, { method: "POST", body: { tier, chat } }),
  resolveOffer: (chatId, messageId, action, tier, chat) =>
    request(`/chats/${chatId}/offers/${messageId}/resolve`, { method: "POST", body: { action, tier, chat } }),

  // Clearing the shared registry is a personal view change: these hide programs
  // for this browser and leave everybody else's registry untouched.
  listTools: () => request("/tools"),
  hideAllTools: () => request("/tools", { method: "DELETE" }),
  hideTool: (id) => request(`/tools/${encodeURIComponent(id)}`, { method: "DELETE" }),
  restoreTools: () => request("/tools/hidden", { method: "DELETE" }),
  getStats: () => request("/stats"),

  getIntegration: () => request("/integrations"),
  saveIntegration: (body) => request("/integrations", { method: "PUT", body }),
  setActiveIntegration: (id) => request("/integrations/active", { method: "POST", body: { id } }),
  deleteIntegration: (id) => request(id ? `/integrations/${id}` : "/integrations", { method: "DELETE" }),
  testIntegration: (body) => request("/integrations/test", { method: "POST", body }),
};
