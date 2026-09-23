import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import OfferCard from "./OfferCard.jsx";
import { ArrowUp, Check, Copy, Paperclip, Puzzle, RefreshCw, Search, Sparkles, X } from "lucide-react";

const EXAMPLES = [
  "Is this support ticket urgent?",
  "Does this customer message need immediate attention?",
  "Should this request be escalated right now?",
];

export default function ChatThread({ chat, chatFading = false, draft = "", onDraftChange, user, tiers, tier, onTierChange, modelOpen, onModelOpenChange, onSend, onRetry, onResolveOffer }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [modelQuery, setModelQuery] = useState("");
  const taRef = useRef(null);
  const bottomRef = useRef(null);
  const modelPickerRef = useRef(null);
  const modelMenuRef = useRef(null);
  const trackedChatIdRef = useRef(null);
  const initialMessageIdsRef = useRef(new Set());
  const currentTier = tiers.find((item) => item.id === tier) || tiers[0];
  // One ordered list, fastest to deepest, so all three complexity levels are
  // always visible. The query only narrows it when the user types.
  const visibleTiers = tiers.filter((item) => {
    const q = modelQuery.trim().toLowerCase();
    return !q || `${item.label} ${item.tagline} ${item.desc}`.toLowerCase().includes(q);
  });

  useEffect(() => {
    function onDocumentClick(e) {
      const clickedPicker = modelPickerRef.current?.contains(e.target);
      const clickedMenu = modelMenuRef.current?.contains(e.target);
      if (!clickedPicker && !clickedMenu) onModelOpenChange(false);
    }
    document.addEventListener("click", onDocumentClick);
    return () => document.removeEventListener("click", onDocumentClick);
  }, []);

  // Mark messages already present when a chat is opened. They should appear
  // calmly as a complete conversation; only messages added afterwards get an
  // entrance animation. This prevents a long history from replaying 20+ card
  // animations every time the user changes chats.
  if (chat?.id !== trackedChatIdRef.current) {
    trackedChatIdRef.current = chat?.id || null;
    initialMessageIdsRef.current = new Set((chat?.messages || []).map((message) => message.id));
  }

  useEffect(() => {
    setText(draft || "");
    requestAnimationFrame(() => {
      if (taRef.current) autosize(taRef.current);
    });
  }, [chat?.id, draft]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [chat?.messages?.length, busy]);

  async function send(t) {
    const value = (t ?? text).trim();
    if (!value || busy) return;
    setText("");
    onDraftChange?.("");
    if (taRef.current) taRef.current.style.height = "auto";
    setPendingText(value);
    setBusy(true);
    try {
      await onSend(value);
    } finally {
      setBusy(false);
      setPendingText("");
    }
  }
  async function resolve(messageId, action) {
    setBusy(true);
    try {
      await onResolveOffer(messageId, action);
    } finally {
      setBusy(false);
    }
  }

  // Re-ask the last user message through the server's retry endpoint, which
  // drops the stale reply and generates a fresh one.
  async function retry() {
    if (busy || !onRetry) return;
    setBusy(true);
    try {
      await onRetry();
    } finally {
      setBusy(false);
    }
  }

  const [pendingText, setPendingText] = useState(""); // shown instantly while the server thinks
  const hasMessages = Boolean(chat?.messages?.length);
  const showThread = hasMessages || busy || Boolean(pendingText);

  return (
    <section className={"chat-view" + (chatFading ? " chat-fading" : "")}>
      {!showThread ? (
        <div className="greet">
          <h1 className="welcome-line">Welcome to Recur<span className="dot">.</span></h1>
          <p className="greet-sub">Builds reusable tools from tasks you repeat, and always asks before using one.</p>
        </div>
      ) : (
        <div key={chat?.id || "new-chat"} className="thread">
          <div className="thread-inner">
            {(chat?.messages || []).map((m) => {
              const animate = !initialMessageIdsRef.current.has(m.id) && m.role !== "user";
              const enteringMessages = (chat?.messages || []).filter((message) => !initialMessageIdsRef.current.has(message.id) && message.role !== "user");
              const enterIndex = animate ? Math.max(0, enteringMessages.findIndex((message) => message.id === m.id)) : 0;
              return <Message key={m.id} m={m} animate={animate} enterDelay={Math.min(enterIndex * 55, 180)} onResolve={resolve} onRetry={retry} />;
            })}
            {busy && (
              <>
                {pendingText && (
                  <div className="msg-row user pending-message">
                    <div className="bubble">{pendingText}</div>
                  </div>
                )}
                <div className="msg-row assistant pending-reply">
                  <div className="bubble">
                    <Typing />
                  </div>
                </div>
              </>
            )}
            <div ref={bottomRef} />
          </div>
        </div>
      )}
      <div className="composer">
        <div className="composer-inner">
          {!showThread && (
            <div className="chip-row">
              {EXAMPLES.map((ex) => (
                <button key={ex} className="chip" type="button" onClick={() => send(ex)}>
                  {ex}
                </button>
              ))}
            </div>
          )}
          <div className="composer-box">
            <textarea
              ref={taRef}
              rows={1}
              value={text}
              placeholder="Message Recur…"
              onChange={(e) => {
                setText(e.target.value);
                onDraftChange?.(e.target.value);
                autosize(e.target);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <button className="icon-btn send" type="button" disabled={busy} onClick={() => send()} title="Send">
              <ArrowUp />
            </button>
          </div>
          <div className="composer-subrow">
            <div className="composer-model-row">
              <div className="composer-model-picker" ref={modelPickerRef}>
                <button className={"composer-model-trigger" + (modelOpen ? " open" : "")} type="button" onClick={() => onModelOpenChange(!modelOpen)} aria-expanded={modelOpen} aria-haspopup="listbox">
                  <span className="composer-model-icon"><Sparkles /></span>
                  <span className="composer-model-label">{currentTier.label}</span>
                  <span className="composer-model-status-dot" aria-hidden="true" />
                </button>
                {modelOpen && createPortal(
                  <div className="model-menu-backdrop" onClick={() => onModelOpenChange(false)}>
                    <div className="composer-model-menu" ref={modelMenuRef} role="listbox" aria-label="Choose a Recur model" onClick={(e) => e.stopPropagation()}>
                      <div className="model-menu-top">
                        <div className="model-menu-search">
                          <Search />
                          <input autoFocus value={modelQuery} onChange={(e) => setModelQuery(e.target.value)} placeholder="Search models..." aria-label="Search models" />
                        </div>
                        <button className="model-menu-close" type="button" onClick={() => onModelOpenChange(false)} aria-label="Close model chooser"><X /></button>
                      </div>
                      <div className="model-menu-scroll">
                        <span className="model-menu-heading">CHOOSE A MODEL</span>
                        {visibleTiers.map((item) => (
                          <ModelOption key={item.id} tier={item} selected={item.id === tier} onSelect={() => { onTierChange(item.id); onModelOpenChange(false); setModelQuery(""); }} />
                        ))}
                        {visibleTiers.length === 0 && <div className="model-menu-empty">No matching models.</div>}
                      </div>
                    </div>
                  </div>,
                  document.body
                )}
              </div>
            </div>
            <button type="button" className="subrow-pill" disabled title="Attachments aren't available in this build">
              <Paperclip /> Attach content
            </button>
          </div>
          <div className="composer-foot">
            {user
              ? "Recur can make mistakes. Compiled replies are marked in the thread."
              : "Browsing as a guest. This chat is temporary; log in to keep your history."}
          </div>
        </div>
      </div>
    </section>
  );
}

function ModelOption({ tier, selected, onSelect }) {
  return (
    <button className={"model-menu-option" + (selected ? " selected" : "")} type="button" role="option" aria-selected={selected} onClick={onSelect}>
      <span className="model-option-icon"><Sparkles /></span>
      <span className="model-option-copy">
        <span className="model-option-name">{tier.label}</span>
        <span className="model-option-desc">{tier.tagline}</span>
      </span>
      {selected ? <Check className="model-option-check" /> : <span className="model-option-dot" />}
    </button>
  );
}

function autosize(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 160) + "px";
}

function Message({ m, animate = false, enterDelay = 0, onResolve, onRetry }) {
  const [copied, setCopied] = useState(false);
  if (m.kind === "compiled_notice") {
    return (
      <div className="sys-row">
        <div className="sys-pill"><Puzzle /> Reusable program compiled: <b>{m.toolName}</b></div>
      </div>
    );
  }
  if (m.kind === "program_info") {
    return (
      <div className="program-info-row">
        <div className="program-info-card">
          <div className="program-info-heading"><Puzzle /> Program details</div>
          {String(m.text || "").split("\n").map((line, i) => {
            const [label, ...rest] = line.split(": ");
            return <div className="program-info-line" key={i}><span>{label}</span>{rest.join(": ")}</div>;
          })}
        </div>
      </div>
    );
  }
  if (m.kind === "offer") {
    return <OfferCard m={m} onResolve={onResolve} />;
  }

  async function copyText() {
    try {
      await navigator.clipboard.writeText(m.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch (e) {
      /* clipboard unavailable */
    }
  }

  const internalEcho = m.viaTool && /(?:apply the contract|new request:|you are executing|verified behavior examples|do not mention this prompt)/i.test(String(m.text || ""));
  return (
    <div className={"msg-row " + (m.role === "user" ? "user" : "assistant") + (animate ? " message-enter" : "")} style={animate ? { "--message-enter-delay": `${enterDelay}ms` } : undefined}>
      <div>
        {m.viaTool && <div className="via-tool-label"><Puzzle /> Used reusable program: <b>{m.viaTool}</b></div>}
        <div className="bubble">{internalEcho ? "The reusable program returned an invalid internal response. Please retry this request." : m.text}</div>
      </div>
      {m.role === "assistant" && (
        <div className="msg-actions">
          <button className="msg-action" type="button" onClick={copyText} title={copied ? "Copied" : "Copy reply"} aria-label="Copy reply">
            {copied ? <Check /> : <Copy />}
          </button>
          {onRetry && (
            <button className="msg-action" type="button" onClick={onRetry} title="Try again" aria-label="Try again">
              <RefreshCw />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Typing() {
  return (
    <div className="typing">
      <span></span>
      <span></span>
      <span></span>
    </div>
  );
}
