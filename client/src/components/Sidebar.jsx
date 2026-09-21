import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  Home,
  LogIn,
  MessageCircle,
  MoreHorizontal,
  Plus,
  Puzzle,
  Search,
  Settings2,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";

export default function Sidebar({
  view, onChangeView,
  tiers, tier, onTierChange,
  chats, activeId, onSelectChat, onNewChat, onDeleteChat,
  user, onLogout, onOpenAuth,
  mobileOpen, onCloseMobile,
}) {
  const [query, setQuery] = useState("");
  const [accountOpen, setAccountOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef(null);

  useEffect(() => {
    function onDoc(e) { if (moreRef.current && !moreRef.current.contains(e.target)) setMoreOpen(false); }
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return chats;
    return chats.filter((c) => (c.title || "").toLowerCase().includes(q));
  }, [chats, query]);

  const groups = useMemo(() => groupByDate(filtered), [filtered]);

  return (
    <>
      {mobileOpen && <div className="sidebar-scrim" onClick={onCloseMobile} />}
      <aside className={"sidebar" + (mobileOpen ? " open" : "")}>
        <button className="sidebar-mobile-close" type="button" onClick={onCloseMobile} aria-label="Close menu">
          <X />
        </button>
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
        <button className={"nav-row" + (view === "home" ? " active" : "")} type="button" onClick={() => onChangeView("home")}>
          <Home /> <span>Home</span>
        </button>
        <button
          className={"nav-row new-chat-row" + (view === "chat" && !activeId ? " active" : "")}
          type="button"
          onClick={onNewChat}
          title="Start a new chat"
        >
          <SquarePen /> <span>New chat</span>
        </button>
        <button
          className={"nav-row" + (view === "tools" ? " active" : "")}
          type="button"
          onClick={() => onChangeView("tools")}
          title="Reusable tools compiled from your chats"
        >
          <Puzzle /> <span>Tool Registry</span>
        </button>
        <button className={"nav-row" + (view === "integrations" ? " active" : "")} type="button" onClick={() => onChangeView("integrations")}>
          <Settings2 /> <span>Integrations</span>
        </button>
      </nav>

      <div className="sidebar-section-divider" aria-hidden="true" />

      <div className="chat-groups">
        <section className="sidebar-list-section pinned-section" aria-label="Pinned chats">
          <div className="list-heading">
            <span>Pinned</span>
            <span className="list-actions">
              <button type="button" onClick={onNewChat} aria-label="New chat"><Plus /></button>
              <span className="more-wrap" ref={moreRef}>
                <button type="button" onClick={() => setMoreOpen((v) => !v)} aria-label="More chat options" aria-expanded={moreOpen}><MoreHorizontal /></button>
                {moreOpen && (
                  <div className="list-menu">
                    <button type="button" onClick={() => { setMoreOpen(false); onNewChat(); }}>
                      <Plus /> New chat
                    </button>
                    <button type="button" disabled={!query} onClick={() => { setMoreOpen(false); setQuery(""); }}>
                      <X /> Clear search
                    </button>
                  </div>
                )}
              </span>
            </span>
          </div>
        </section>

        <section className="sidebar-list-section history-section" aria-label="Chat history">
          <div className="list-heading history-heading"><span>History</span></div>
          {chats.length === 0 && <div className="chatlist-empty">No chats yet. Send a message to start one.</div>}
          {!user && chats.length > 0 && <div className="chatlist-empty guest-note">Guest session. Log in to keep this history.</div>}
          {groups.map(([label, items]) => (
            <div key={label} className="chat-group">
              <div className="chat-group-label">{label}</div>
              {items.map((c) => (
                <div key={c.id} className={"chat-item" + (c.id === activeId && view === "chat" ? " active" : "")} onClick={() => onSelectChat(c.id)}>
                  <MessageCircle className="chat-item-icon" />
                  <span className="title">{c.title || "New chat"}</span>
                  <button className="del" type="button" onClick={(e) => { e.stopPropagation(); onDeleteChat(c.id); }} aria-label="Delete chat"><Trash2 /></button>
                </div>
              ))}
            </div>
          ))}
        </section>
      </div>

      <div className="account-row">
        {user ? (
          <>
            <button className="account-btn" type="button" onClick={() => setAccountOpen((v) => !v)}>
              <span className="avatar">{(user.name || "?")[0].toUpperCase()}</span>
              <span className="account-name">{user.name}</span>
              <ChevronDown className="chev" />
            </button>
            {accountOpen && <div className="account-menu"><button type="button" onClick={onLogout}>Log out</button></div>}
          </>
        ) : (
          <button className="login-pill" type="button" onClick={() => onOpenAuth("login")}>
            <LogIn /> Log In
          </button>
        )}
      </div>
    </aside>
    </>
  );
}

function groupByDate(chats) {
  const sorted = [...chats].sort((a, b) => b.updatedAt - a.updatedAt);
  const now = new Date();
  const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = startOf(now);
  const yesterday = today - 86400000;
  const weekAgo = today - 7 * 86400000;
  const buckets = { Today: [], Yesterday: [], "7 days": [], Older: [] };
  for (const c of sorted) {
    const day = startOf(new Date(c.updatedAt));
    if (day === today) buckets.Today.push(c);
    else if (day === yesterday) buckets.Yesterday.push(c);
    else if (day >= weekAgo) buckets["7 days"].push(c);
    else buckets.Older.push(c);
  }
  return Object.entries(buckets).filter(([, items]) => items.length > 0);
}
