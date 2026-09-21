const BASE = "/api";

async function request(path, opts = {}) {
  const res = await fetch(BASE + path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
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
  sendMessage: (id, text, tier) => request(`/chats/${id}/messages`, { method: "POST", body: { text, tier } }),
  resolveOffer: (chatId, messageId, action, tier) =>
    request(`/chats/${chatId}/offers/${messageId}/resolve`, { method: "POST", body: { action, tier } }),

  listTools: () => request("/tools"),
  resetTools: () => request("/tools", { method: "DELETE" }),
  getStats: () => request("/stats"),

  getIntegration: () => request("/integrations"),
  saveIntegration: (body) => request("/integrations", { method: "PUT", body }),
  deleteIntegration: () => request("/integrations", { method: "DELETE" }),
  testIntegration: (body) => request("/integrations/test", { method: "POST", body }),
};
