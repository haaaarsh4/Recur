import React, { useCallback, useEffect, useRef, useState } from "react";
import { Bell, Menu, Puzzle } from "lucide-react";
import { api } from "../api.js";
import { readGuestChats, saveGuestChats, clearGuestChats, mergeGuestChats } from "../guestChats.js";
import { useAuth } from "../state/AuthContext.jsx";
import Sidebar from "../components/Sidebar.jsx";
import ChatThread from "../components/ChatThread.jsx";
import ToolsPanel from "../components/ToolsPanel.jsx";
import HomeView from "../components/HomeView.jsx";
import IntegrationsPanel from "../components/IntegrationsPanel.jsx";
import AuthModal from "../components/AuthModal.jsx";

const TIERS = [
  { id: "quick", label: "Recur Quick", tagline: "Fastest, light tasks", desc: "Quick everyday replies. Fastest of the three." },
  { id: "default", label: "Recur", tagline: "Balanced, default", desc: "Balanced reasoning for normal questions." },
  { id: "complex", label: "Recur Complex", tagline: "Slowest, deepest", desc: "Deepest reasoning for hard questions." },
];

export default function Workspace() {
  const { user, loading, logout } = useAuth();
  const [view, setView] = useState("chat");
  const [tier, setTier] = useState("default");
  const [modelOpen, setModelOpen] = useState(false);
  const [chats, setChats] = useState([]);
  const [activeChat, setActiveChat] = useState(null);
  const [activeSource, setActiveSource] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [tools, setTools] = useState([]);
  const [stats, setStats] = useState(null);
  const [error, setError] = useState("");
  const [authModal, setAuthModal] = useState(null); // null | "login" | "register"
  const [authError, setAuthError] = useState("");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed);
  const [notifOpen, setNotifOpen] = useState(false);
  const [chatFading, setChatFading] = useState(false);
  const fadeRef = useRef(0);
  const notifRef = useRef(null);
  const autoOpenedRef = useRef(false);
  // A guest's conversations are held here (see guestChats.js). A serverless host
  // has no store shared by its instances, so the copy that travels with the next
  // request is the only one that is always available.
  const localChatsRef = useRef(null);
  if (localChatsRef.current === null) {
    localChatsRef.current = new Map(readGuestChats().map((chat) => [chat.id, chat]));
  }

  useEffect(() => {
    function onDoc(e) { if (notifRef.current && !notifRef.current.contains(e.target)) setNotifOpen(false); }
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, []);

  // One panel, two states, one way in and out. On a wide screen the sidebar
  // collapses to a rail of icons; on a narrow one it is a drawer that is either
  // open or not, so the same shortcut does what that screen can actually show.
  const toggleSidebar = useCallback(() => {
    if (window.matchMedia(NARROW_SIDEBAR).matches) {
      setMobileNavOpen((open) => !open);
      return;
    }
    setSidebarCollapsed((collapsed) => {
      writeSidebarCollapsed(!collapsed);
      return !collapsed;
    });
  }, []);

  // Ctrl+B on Windows and Linux, Cmd+B on a Mac, like every app that has a
  // sidebar. The browser's own bindings are left alone: no Alt, no Shift.
  useEffect(() => {
    function onKeyDown(event) {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== "b") return;
      event.preventDefault();
      toggleSidebar();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleSidebar]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const message = params.get("auth_error");
    if (message) {
      setAuthError(message);
      setAuthModal("login");
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, []);

  const refreshChats = useCallback(() => {
    api
      .listChats()
      .then((list) => {
        if (user) {
          setChats(list);
          return;
        }
        const merged = mergeGuestChats(list, [...localChatsRef.current.values()]);
        setChats(merged);
        // Keep every conversation that arrived with the list (the sample does),
        // so a reload in this session does not have to ask a possibly different
        // instance for it.
        const kept = merged.filter((chat) => Array.isArray(chat.messages));
        localChatsRef.current = new Map(kept.map((chat) => [chat.id, chat]));
        saveGuestChats(kept);
      })
      .catch(() => setChats(user ? [] : [...localChatsRef.current.values()]));
  }, [user]);
  const refreshTools = useCallback(() => {
    api.listTools().then(setTools).catch(() => {});
  }, []);
  const refreshStats = useCallback(() => {
    api.getStats().then(setStats).catch(() => {});
  }, []);
  // The header counts the programs that can actually answer, which is the same
  // set the registry's own "programs compiled" number uses. Rows that are kept
  // for history (a program a later compilation replaced, an old contract that
  // holds nothing executable) stay visible in the registry but are not doing any
  // work, so counting them here would contradict the page they link to.
  const liveTools = tools.filter((tool) => !tool.hiddenForYou && tool.program && tool.status !== "superseded").length;

  useEffect(() => {
    if (loading) return;
    refreshChats();
    refreshTools();
    refreshStats();
  }, [loading, user, refreshChats, refreshTools, refreshStats]);

  // Once there is an account, its history is the server's. A guest copy left in
  // this browser is not needed, and must never shadow the account's own chats.
  useEffect(() => {
    if (!user) return;
    localChatsRef.current = new Map();
    clearGuestChats();
  }, [user?.id]);

  // A first-time visitor lands in the sample conversation, so the project can be
  // understood before they type anything and while the model backend may be
  // unreachable. It happens once per browser and never again: after that the
  // chat stays pinned, and the visitor's own chats are the default.
  useEffect(() => {
    if (loading || autoOpenedRef.current || activeChat || sampleAlreadySeen()) return;
    const sample = chats.find((chat) => chat.sample);
    if (!sample) return;
    autoOpenedRef.current = true;
    markSampleSeen();
    openChat(sample.id, "pinned");
  }, [loading, chats, activeChat]);

  // The guest's copy is what the next request carries, so every conversation the
  // browser has seen is kept up to date as replies arrive.
  function rememberChat(chat) {
    if (user || !chat || !Array.isArray(chat.messages)) return;
    localChatsRef.current.set(chat.id, chat);
    saveGuestChats([...localChatsRef.current.values()]);
  }

  function forgetChat(id) {
    if (!localChatsRef.current.delete(id)) return;
    saveGuestChats([...localChatsRef.current.values()]);
  }

  // Chat switching uses one single opacity fade: the current view fades out,
  // content swaps while fully transparent, then the new view fades in. Because
  // there is exactly one animation on one element, nothing can restart or drop
  // in mid-flight: the old flash-and-reanimate glitch came from stacking a
  // second animation on top of a running one.
  async function swapChat(load, source) {
    const fadeId = ++fadeRef.current;
    setView("chat");
    setMobileNavOpen(false);
    setChatFading(true);
    const [chat] = await Promise.all([load(), wait(FADE_OUT_MS)]);
    if (fadeId !== fadeRef.current) return; // a newer switch superseded this one
    if (chat) {
      setActiveChat(chat);
      setActiveSource(source);
      rememberChat(chat);
    } else {
      setActiveChat(null);
      setActiveSource(null);
    }
    setChatFading(false);
  }
  function openChat(id, source = "history") {
    // A chat that is already open still has to bring its view back: clicking the
    // row while the registry or the integrations page is on screen should return
    // to the conversation instead of doing nothing.
    if (activeChat?.id === id && activeSource === source && !chatFading) {
      setView("chat");
      setMobileNavOpen(false);
      return;
    }
    // Most opens need no request: a guest chat is already here, and the sample
    // arrives with the list. That is what keeps a click working when the next
    // request would be answered by an instance that has never seen the chat.
    const known = (!user && localChatsRef.current.get(id)) || chats.find((chat) => chat.id === id && Array.isArray(chat.messages));
    swapChat(() => (known ? Promise.resolve(known) : api.getChat(id)), source).catch((e) => {
      if (e) setError(e.message || "Could not open that chat.");
      setChatFading(false);
    });
  }
  function newChat() {
    setDrafts((current) => ({ ...current, __new__: "" }));
    swapChat(() => Promise.resolve(null), null).catch(() => setChatFading(false));
  }
  async function deleteChat(id) {
    forgetChat(id);
    await api.deleteChat(id);
    if (activeChat?.id === id) {
      setActiveChat(null);
      setActiveSource(null);
    }
    refreshChats();
  }

  async function sendMessage(text) {
    setError("");
    let chat = activeChat;
    if (!chat) {
      chat = await api.createChat(text);
      setActiveChat(chat);
      rememberChat(chat);
    }
    try {
      const { chat: updated } = await api.sendMessage(chat.id, text, tier, user ? null : chat);
      setActiveChat(updated);
      rememberChat(updated);
      refreshChats();
      refreshTools();
      refreshStats();
    } catch (e) {
      setError(e.message);
      if (e.data?.chat) setActiveChat(e.data.chat);
      refreshChats();
    }
  }

  async function retryLast() {
    if (!activeChat) return;
    setError("");
    try {
      const { chat: updated } = await api.retryMessage(activeChat.id, tier, user ? null : activeChat);
      setActiveChat(updated);
      rememberChat(updated);
      refreshChats();
      refreshTools();
      refreshStats();
    } catch (e) {
      setError(e.message);
      if (e.data?.chat) setActiveChat(e.data.chat);
    }
  }

  async function resolveOffer(messageId, action) {
    setError("");
    try {
      const { chat: updated } = await api.resolveOffer(activeChat.id, messageId, action, tier, user ? null : activeChat);
      setActiveChat(updated);
      rememberChat(updated);
      refreshChats();
      refreshTools();
      refreshStats();
    } catch (e) {
      setError(e.message);
      if (e.data?.chat) setActiveChat(e.data.chat);
    }
  }

  // Clearing the registry is a view change rather than a deletion: these hide
  // programs for this visitor and leave the shared library alone. All three hit
  // the tools list again, and all three let the panel see a failure: a control
  // that silently does nothing is worse than one that says why it did nothing.
  async function hideAllTools() {
    const result = await api.hideAllTools();
    refreshTools();
    return result;
  }

  async function hideTool(id) {
    const result = await api.hideTool(id);
    refreshTools();
    return result;
  }

  async function restoreTools() {
    const result = await api.restoreTools();
    refreshTools();
    return result;
  }

  async function handleLogout() {
    await logout();
    setView("chat");
    setAuthModal("login");
  }

  return (
    <div className={"app" + (sidebarCollapsed ? " sidebar-collapsed" : "")}>
      <Sidebar
        view={view}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={toggleSidebar}
        onChangeView={(v) => { setView(v); setMobileNavOpen(false); }}
        tiers={TIERS}
        tier={tier}
        onTierChange={setTier}
        chats={chats}
        activeId={activeChat?.id}
        activeSource={activeSource}
        onSelectChat={openChat}
        onNewChat={newChat}
        onDeleteChat={deleteChat}
        user={user}
        onLogout={handleLogout}
        onOpenAuth={setAuthModal}
        mobileOpen={mobileNavOpen}
        onCloseMobile={() => setMobileNavOpen(false)}
      />
      <main className="content">
        <header className="topbar">
          <button className="hamburger" type="button" onClick={() => setMobileNavOpen(true)} aria-label="Open menu">
            <Menu size={19} />
          </button>
          <div className="topbar-right">
            <button className="pill pill-outline" type="button" title="Compiled programs shared across everyone" onClick={() => setView("tools")}>
              <Puzzle /> {liveTools} tool{liveTools === 1 ? "" : "s"}
            </button>
            <button className="pill pill-solid" type="button" title="Share of tasks answered by a compiled tool instead of general reasoning">
              {stats?.reuseRate != null ? stats.reuseRate + "%" : "n/a"} reuse
            </button>
            <div className="notif-wrap" ref={notifRef}>
              <button className="icon-btn bell-btn" type="button" onClick={() => setNotifOpen((v) => !v)} aria-label="Notifications">
                <Bell />
              </button>
              {notifOpen && (
                <div className="notif-menu">
                  <div className="notif-empty">No notifications yet.</div>
                </div>
              )}
            </div>
          </div>
        </header>
        {error && <div className="banner danger show">{error}</div>}
        {view === "chat" ? (
          <ChatThread
            chat={activeChat}
            chatFading={chatFading}
            draft={drafts[activeChat?.id || "__new__"] || ""}
            onDraftChange={(value) => setDrafts((current) => ({ ...current, [activeChat?.id || "__new__"]: value }))}
            user={user}
            tiers={TIERS}
            tier={tier}
            onTierChange={setTier}
            modelOpen={modelOpen}
            onModelOpenChange={setModelOpen}
            onSend={sendMessage}
            onRetry={retryLast}
            onResolveOffer={resolveOffer}
          />
        ) : view === "tools" ? (
          <ToolsPanel tools={tools} stats={stats} onHideAll={hideAllTools} onHideTool={hideTool} onRestoreTools={restoreTools} />
        ) : view === "home" ? (
          <HomeView
            user={user}
            toolsCount={liveTools}
            stats={stats}
            onGoChat={() => setView("chat")}
            onGoTools={() => setView("tools")}
            onGoIntegrations={() => setView("integrations")}
          />
        ) : (
          <IntegrationsPanel user={user} onRequireAuth={setAuthModal} />
        )}
      </main>

      {authModal && <AuthModal initialMode={authModal} initialError={authError} onClose={() => { setAuthModal(null); setAuthError(""); }} />}
    </div>
  );
}

const FADE_OUT_MS = 180;
const SAMPLE_SEEN_KEY = "recur:sample-seen";
const SIDEBAR_KEY = "recur:sidebar-collapsed";
const NARROW_SIDEBAR = "(max-width: 650px)";

// The sidebar's state is a preference, not session data: it is remembered across
// visits, and the first paint already has it, so there is no flash of a panel
// the visitor had put away.
function readSidebarCollapsed() {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === "1";
  } catch (e) {
    return false;
  }
}

function writeSidebarCollapsed(collapsed) {
  try {
    localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0");
  } catch (e) {
    // Private modes can refuse storage; the panel still toggles for this visit.
  }
}

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function sampleAlreadySeen() {
  try {
    return localStorage.getItem(SAMPLE_SEEN_KEY) === "1";
  } catch (e) {
    return false;
  }
}

function markSampleSeen() {
  try {
    localStorage.setItem(SAMPLE_SEEN_KEY, "1");
  } catch (e) {
    // Storage can be unavailable in private modes; the sample then simply opens
    // on each visit, which is harmless.
  }
}
