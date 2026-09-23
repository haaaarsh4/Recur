import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  Home,
  LogIn,
  LogOut,
  MessageCircle,
  Pin,
  Puzzle,
  Search,
  Settings2,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";

export default function Sidebar({
  view, onChangeView,
  chats, activeId, activeSource, onSelectChat, onNewChat, onDeleteChat,
  user, onLogout, onOpenAuth,
  mobileOpen, onCloseMobile,
}) {
  const [query, setQuery] = useState("");
  const [accountOpen, setAccountOpen] = useState(false);
  const [pinnedIds, setPinnedIds] = useState(() => readPinnedIds(user));
  const accountRef = useRef(null);

  useEffect(() => {
    function onDoc(e) {
      if (accountRef.current && !accountRef.current.contains(e.target)) setAccountOpen(false);
    }
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, []);

  useEffect(() => {
    setPinnedIds(readPinnedIds(user));
  }, [user?.id]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return chats;
    return chats.filter((c) => (c.title || "").toLowerCase().includes(q));
  }, [chats, query]);

  const groups = useMemo(() => groupByDate(filtered), [filtered]);
  const pinnedChats = useMemo(() => chats.filter((chat) => pinnedIds.has(chat.id)), [chats, pinnedIds]);

  function togglePinned(chatId) {
    const next = new Set(pinnedIds);
    if (next.has(chatId)) next.delete(chatId);
    else next.add(chatId);
    setPinnedIds(next);
    writePinnedIds(user, next);
  }

  function deleteChat(chatId) {
    const next = new Set(pinnedIds);
    next.delete(chatId);
    setPinnedIds(next);
    writePinnedIds(user, next);
    onDeleteChat(chatId);
  }

  return (
    <>
      {mobileOpen && <div className="sidebar-scrim" onClick={onCloseMobile} />}
      <aside className={"sidebar" + (mobileOpen ? " open" : "")}>
        <button className="sidebar-mobile-close" type="button" onClick={onCloseMobile} aria-label="Close menu"><X /></button>
        <button className="sidebar-brand" type="button" onClick={() => onChangeView("home")} aria-label="Go to Recur home">
          <span className="sidebar-brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span className="sidebar-brand-copy"><b>Recur<span>.</span></b><small>Workspace</small></span>
        </button>

        <div className="search-box">
          <Search />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" />
          <kbd>/</kbd>
        </div>

        <nav className="primary-nav" aria-label="Primary navigation">
          <button className={"nav-row" + (view === "home" ? " active" : "")} type="button" onClick={() => onChangeView("home")}><Home /> <span>Home</span></button>
          <button className={"nav-row new-chat-row" + (view === "chat" && !activeId ? " active" : "")} type="button" onClick={onNewChat} title="Start a new chat"><SquarePen /> <span>New chat</span></button>
          <button className={"nav-row" + (view === "tools" ? " active" : "")} type="button" onClick={() => onChangeView("tools")} title="Reusable tools compiled from your chats"><Puzzle /> <span>Tool Registry</span></button>
          <button className={"nav-row" + (view === "integrations" ? " active" : "")} type="button" onClick={() => onChangeView("integrations")}><Settings2 /> <span>Integrations</span></button>
        </nav>

        <div className="sidebar-section-divider" aria-hidden="true" />

        <div className="chat-groups">
          <section className="sidebar-list-section pinned-section" aria-label="Pinned chats">
            <div className="list-heading"><span>Pinned</span></div>
            {pinnedChats.length === 0 && <div className="chatlist-empty pinned-empty">No pinned chats yet.</div>}
            {pinnedChats.map((chat) => (
              <ChatRow key={chat.id} chat={chat} active={chat.id === activeId && view === "chat" && activeSource === "pinned"} source="pinned" pinned onSelectChat={onSelectChat} onTogglePinned={togglePinned} onDeleteChat={deleteChat} />
            ))}
          </section>

          <section className="sidebar-list-section history-section" aria-label="Chat history">
            <div className="list-heading history-heading"><span>History</span></div>
            {chats.length === 0 && <div className="chatlist-empty">No chats yet. Send a message to start one.</div>}
            {groups.map(([label, items]) => (
              <div key={label} className="chat-group">
                <div className="chat-group-label">{label}</div>
                {items.map((chat) => (
                  <ChatRow key={chat.id} chat={chat} active={chat.id === activeId && view === "chat" && activeSource === "history"} source="history" pinned={pinnedIds.has(chat.id)} onSelectChat={onSelectChat} onTogglePinned={togglePinned} onDeleteChat={deleteChat} />
                ))}
              </div>
            ))}
          </section>
        </div>

        <div className="account-row" ref={accountRef}>
          {user ? (
            <>
              <button className="account-btn" type="button" onClick={() => setAccountOpen((value) => !value)}>
                <span className="avatar">{(user.name || "?")[0].toUpperCase()}</span>
                <span className="account-name">{user.name}</span>
                <ChevronDown className="chev" />
              </button>
              {accountOpen && <div className="account-menu"><button type="button" onClick={onLogout}><LogOut /> Log out</button></div>}
            </>
          ) : (
            <button className="login-pill" type="button" onClick={() => onOpenAuth("login")}><LogIn /> Log In</button>
          )}
        </div>
      </aside>
    </>
  );
}

function ChatRow({ chat, active, source, pinned, onSelectChat, onTogglePinned, onDeleteChat }) {
  return (
    <div className={"chat-item" + (active ? " active" : "")} onClick={() => onSelectChat(chat.id, source)}>
      <MessageCircle className="chat-item-icon" />
      <span className="title">{chat.title || "New chat"}</span>
      <button className="pin" type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); onTogglePinned(chat.id); }} aria-label={pinned ? "Remove from pinned chats" : "Pin chat"}>
        {pinned ? <X /> : <Pin />}
      </button>
      <button className="del" type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); onDeleteChat(chat.id); }} aria-label="Delete chat"><Trash2 /></button>
    </div>
  );
}

function pinnedStorageKey(user) {
  return `recur:pinned:${user?.id || "guest"}`;
}

function readPinnedIds(user) {
  try {
    const raw = localStorage.getItem(pinnedStorageKey(user));
    const ids = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(ids) ? ids : []);
  } catch (e) {
    return new Set();
  }
}

function writePinnedIds(user, ids) {
  try {
    localStorage.setItem(pinnedStorageKey(user), JSON.stringify([...ids]));
  } catch (e) {
    // Current-session pinning still works if storage is unavailable.
  }
}

function groupByDate(chats) {
  const sorted = [...chats].sort((a, b) => b.updatedAt - a.updatedAt);
  const now = new Date();
  const startOf = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const today = startOf(now);
  const yesterday = today - 86400000;
  const weekAgo = today - 7 * 86400000;
  const buckets = { Today: [], Yesterday: [], "7 days": [], Older: [] };
  for (const chat of sorted) {
    const day = startOf(new Date(chat.updatedAt));
    if (day === today) buckets.Today.push(chat);
    else if (day === yesterday) buckets.Yesterday.push(chat);
    else if (day >= weekAgo) buckets["7 days"].push(chat);
    else buckets.Older.push(chat);
  }
  return Object.entries(buckets).filter(([, items]) => items.length > 0);
}
