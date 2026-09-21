import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import OfferCard from "./OfferCard.jsx";
import { ArrowUp, Check, ChevronDown, Paperclip, Puzzle, Search, Sparkles, X } from "lucide-react";

const EXAMPLES = [
  "Is this support ticket urgent?",
  "Does this customer message need immediate attention?",
  "Should this request be escalated right now?",
];

export default function ChatThread({ chat, user, toolsCount, stats, tiers, tier, onTierChange, modelOpen, onModelOpenChange, onSend, onResolveOffer, onOpenTools }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [modelQuery, setModelQuery] = useState("");
  const taRef = useRef(null);
  const bottomRef = useRef(null);
  const modelPickerRef = useRef(null);
  const modelMenuRef = useRef(null);
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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [chat?.messages?.length, busy]);

  async function send(t) {
    const value = (t ?? text).trim();
    if (!value || busy) return;
    setText("");
    if (taRef.current) taRef.current.style.height = "auto";
    setBusy(true);
    try {
      await onSend(value);
    } finally {
      setBusy(false);
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

  const hasMessages = chat && chat.messages && chat.messages.length > 0;

  return (
    <section className={"chat-view" + (modelOpen ? " model-open" : "")}>
      {!hasMessages ? (
        <div className="greet">
          <h1 className="welcome-line">Welcome to Recur<span className="dot">.</span></h1>
          <p className="greet-sub">Builds reusable tools from tasks you repeat, and always asks before using one.</p>
        </div>
      ) : (
        <div className="thread">
          <div className="thread-inner">
            {chat.messages.map((m) => (
              <Message key={m.id} m={m} onResolve={resolve} />
            ))}
            {busy && (
              <div className="msg-row assistant">
                <div className="bubble">
                  <Typing />
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        </div>
      )}
      <div className="composer">
        <div className="composer-inner">
          {!hasMessages && (
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

function Message({ m, onResolve }) {
  if (m.kind === "compiled_notice") {
    return (
      <div className="sys-row">
        <div className="sys-pill"><Puzzle /> New tool compiled: {m.toolName}</div>
      </div>
    );
  }
  if (m.kind === "offer") {
    return <OfferCard m={m} onResolve={onResolve} />;
  }
  return (
    <div className={"msg-row " + (m.role === "user" ? "user" : "assistant")}>
      <div className="bubble">{m.text}</div>
      {m.role === "assistant" && (m.tierApplied || m.viaTool) && (
        <div className="msg-tag">
          {m.viaTool ? (
            <>
              <span className="hit"><Puzzle /> {m.viaTool}</span>
              <span>{Math.round(m.latency)}ms</span>
            </>
          ) : (
            <>
              <span>{m.tierApplied} tier</span>
              <span>{Math.round(m.latency)}ms</span>
            </>
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
