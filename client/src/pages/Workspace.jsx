import React, { useCallback, useEffect, useRef, useState } from "react";
import { Bell, Menu, Puzzle } from "lucide-react";
import { api } from "../api.js";
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
  const [tools, setTools] = useState([]);
  const [stats, setStats] = useState(null);
  const [error, setError] = useState("");
  const [authModal, setAuthModal] = useState(null); // null | "login" | "register"
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const notifRef = useRef(null);

  useEffect(() => {
    function onDoc(e) { if (notifRef.current && !notifRef.current.contains(e.target)) setNotifOpen(false); }
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, []);

  const refreshChats = useCallback(() => {
    api.listChats().then(setChats).catch(() => setChats([]));
  }, []);
  const refreshTools = useCallback(() => {
    api.listTools().then(setTools).catch(() => {});
  }, []);
  const refreshStats = useCallback(() => {
    api.getStats().then(setStats).catch(() => {});
  }, []);

  useEffect(() => {
    if (loading) return;
    refreshChats();
    refreshTools();
    refreshStats();
  }, [loading, user, refreshChats, refreshTools, refreshStats]);

  async function openChat(id) {
    const chat = await api.getChat(id);
    setActiveChat(chat);
    setView("chat");
    setMobileNavOpen(false);
  }
  function newChat() {
    setActiveChat(null);
    setView("chat");
    setMobileNavOpen(false);
  }
  async function deleteChat(id) {
    await api.deleteChat(id);
    if (activeChat?.id === id) setActiveChat(null);
    refreshChats();
  }

  async function sendMessage(text) {
    setError("");
    let chat = activeChat;
    if (!chat) {
      chat = await api.createChat(text);
      setActiveChat(chat);
    }
    try {
      const { chat: updated } = await api.sendMessage(chat.id, text, tier);
      setActiveChat(updated);
      refreshChats();
      refreshTools();
      refreshStats();
    } catch (e) {
      setError(e.message);
      if (e.data?.chat) setActiveChat(e.data.chat);
      refreshChats();
    }
  }

  async function resolveOffer(messageId, action) {
    setError("");
    try {
      const { chat: updated } = await api.resolveOffer(activeChat.id, messageId, action, tier);
      setActiveChat(updated);
      refreshChats();
      refreshTools();
      refreshStats();
    } catch (e) {
      setError(e.message);
      if (e.data?.chat) setActiveChat(e.data.chat);
    }
  }

  async function resetLibrary() {
    await api.resetTools();
    refreshTools();
    refreshStats();
  }

  return (
    <div className="app">
      <Sidebar
        view={view}
        onChangeView={(v) => { setView(v); setMobileNavOpen(false); }}
        tiers={TIERS}
        tier={tier}
        onTierChange={setTier}
        chats={chats}
        activeId={activeChat?.id}
        onSelectChat={openChat}
        onNewChat={newChat}
        onDeleteChat={deleteChat}
        user={user}
        onLogout={logout}
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
            <button className="pill pill-outline" type="button" title="Compiled tools shared across everyone" onClick={() => setView("tools")}>
              <Puzzle /> {tools.length} tool{tools.length === 1 ? "" : "s"}
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
            user={user}
            toolsCount={tools.length}
            stats={stats}
            tiers={TIERS}
            tier={tier}
            onTierChange={setTier}
            modelOpen={modelOpen}
            onModelOpenChange={setModelOpen}
            onSend={sendMessage}
            onResolveOffer={resolveOffer}
            onOpenTools={() => setView("tools")}
          />
        ) : view === "tools" ? (
          <ToolsPanel tools={tools} stats={stats} onReset={resetLibrary} user={user} onRequireAuth={setAuthModal} />
        ) : view === "home" ? (
          <HomeView
            user={user}
            toolsCount={tools.length}
            stats={stats}
            onGoChat={() => setView("chat")}
            onGoTools={() => setView("tools")}
            onGoIntegrations={() => setView("integrations")}
          />
        ) : (
          <IntegrationsPanel user={user} onRequireAuth={setAuthModal} />
        )}
      </main>

      {authModal && <AuthModal initialMode={authModal} onClose={() => setAuthModal(null)} />}
    </div>
  );
}
