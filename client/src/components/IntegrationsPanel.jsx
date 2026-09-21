import React, { useEffect, useState } from "react";
import { Check, Eye, EyeOff, Sparkles } from "lucide-react";
import { api } from "../api.js";

const PROVIDERS = [
  { id: "ollama", label: "Ollama Local", hint: "No API key required", models: ["qwen2.5:0.5b", "smollm2:135m-instruct-q8_0", "llama3.1:8b-instruct-q4_K_M"] },
  { id: "openai", label: "OpenAI", hint: "Keys start with sk-" },
  { id: "anthropic", label: "Anthropic", hint: "Keys start with sk-ant-" },
];

export default function IntegrationsPanel({ user, onRequireAuth }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [provider, setProvider] = useState("ollama");
  const [model, setModel] = useState("qwen2.5:0.5b");
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    if (!user) {
      setStatus(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    api.getIntegration().then((s) => {
      setStatus(s);
      if (s.provider) setProvider(s.provider);
      if (s.model) setModel(s.model);
    }).catch(() => {}).finally(() => setLoading(false));
  }, [user]);

  async function save() {
    if (provider !== "ollama" && !key.trim()) {
      setNotice({ kind: "error", text: "Paste your API key first." });
      return;
    }
    setBusy("save");
    setNotice(null);
    try {
      const s = await api.saveIntegration({ provider, model: provider === "ollama" ? model : undefined, apiKey: provider === "ollama" ? "" : key.trim() });
      setStatus(s);
      setKey("");
      setShowKey(false);
      const label = PROVIDERS.find((p) => p.id === s.provider)?.label || s.provider;
      setNotice({ kind: "ok", text: s.provider === "ollama" ? "Ollama is connected. Recur will use your local model without an API key." : "Key saved. Your chats now run on your own " + label + " account." });
    } catch (e) {
      setNotice({ kind: "error", text: e.message });
    } finally {
      setBusy("");
    }
  }

  async function test() {
    if (provider !== "ollama" && !key.trim()) {
      setNotice({ kind: "error", text: "Paste your API key first." });
      return;
    }
    setBusy("test");
    setNotice(null);
    try {
      const r = await api.testIntegration({ provider, model: provider === "ollama" ? model : undefined, apiKey: provider === "ollama" ? "" : key.trim() });
      setNotice(r.ok ? { kind: "ok", text: "That key works. The provider accepted it." } : { kind: "error", text: r.error || "That key did not pass the test." });
    } catch (e) {
      setNotice({ kind: "error", text: e.message });
    } finally {
      setBusy("");
    }
  }

  async function remove() {
    setBusy("remove");
    setNotice(null);
    try {
      const s = await api.deleteIntegration();
      setStatus(s);
      setNotice({ kind: "ok", text: "Key removed. Chat falls back to the server's own key when one exists." });
    } catch (e) {
      setNotice({ kind: "error", text: e.message });
    } finally {
      setBusy("");
    }
  }

  const selectedProvider = PROVIDERS.find((p) => p.id === provider) || PROVIDERS[0];

  return (
    <section className="tools-view integrations-view">
      <div className="tv-inner intg-inner">
        <div className="intg-heading">
          <div>
            <span className="intg-eyebrow"><Sparkles /> YOUR CONNECTIONS</span>
            <h2>Integrations</h2>
            <p className="sub">Connect your own model provider and keep every Recur conversation powered by your account.</p>
          </div>
        </div>

        {!user ? (
          <div className="intg-login-card">
            <div>
              <span className="intg-card-kicker">GUEST BROWSING</span>
              <h3>Chat works without an account.</h3>
              <p>You can chat right away with the server's shared provider. To connect your own API key and keep your history forever, create a free account.</p>
            </div>
            <button className="intg-btn solid" type="button" onClick={() => onRequireAuth("login")}>Log in or join</button>
          </div>
        ) : (
          <>
            <div className="intg-connection-card">
              <div className="intg-card-topline">
                <div>
                  <span className="intg-card-kicker">ACTIVE CONNECTION</span>
                  <h3>{status?.connected ? "Your provider is connected" : "Connect a model provider"}</h3>
                </div>
                <span className={"intg-connection-state" + (status?.connected ? " connected" : "")}>
                  <span className="intg-dot" /> {status?.connected ? "Connected" : "Not connected"}
                </span>
              </div>
              {loading ? <p className="intg-muted">Checking your saved connection...</p> : status?.connected ? (
                <p className="intg-connection-copy">Using <b>{PROVIDERS.find((p) => p.id === status.provider)?.label || status.provider}</b>{status.provider === "ollama" ? ` with ${status.model}. No API key is required.` : ` with a key ${status.keyPreview}.`} Saved {status.updatedAt ? new Date(status.updatedAt).toLocaleString() : "recently"}.</p>
              ) : (                  <p className="intg-connection-copy">Choose Ollama Local for free local inference, or choose a hosted provider and add its API key.</p>

              )}
            </div>

            {!loading && (
              <div className="intg-builder">
                <aside className="intg-provider-rail">
                  <span className="intg-card-kicker">PROVIDER</span>
                  <div className="intg-provider-list">
                    {PROVIDERS.map((p) => (
                      <button key={p.id} type="button" className={"intg-provider" + (provider === p.id ? " selected" : "")} onClick={() => { setProvider(p.id); setNotice(null); }}>
                        <span className="provider-logo">{p.label[0]}</span>
                        <span><b>{p.label}</b><small>{p.id === "ollama" ? "Runs on this computer" : p.id === "openai" ? "GPT models" : "Claude models"}</small></span>
                        {provider === p.id && <Check className="provider-check" />}
                      </button>
                    ))}
                  </div>
                  <p className="intg-rail-note">Your key is used for replies, pattern detection, tool creation, and tool runs.</p>
                </aside>

                <div className="intg-key-panel">
                  <div className="intg-card-kicker">{provider === "ollama" ? "LOCAL MODEL" : "API KEY"}</div>
                  <h3>{provider === "ollama" ? "Use Ollama without a key" : `Connect ${selectedProvider.label}`}</h3>
                  <p className="intg-form-copy">{provider === "ollama" ? "Recur will call Ollama on this computer. Choose a model that is already installed." : "Your key is encrypted in transit, masked after saving, and used only for your workspace."}</p>
                  {provider === "ollama" ? (
                    <label className="intg-model-select-label">Installed model
                      <select className="intg-model-select" value={model} onChange={(e) => setModel(e.target.value)}>
                        {selectedProvider.models.map((item) => <option key={item} value={item}>{item}</option>)}
                      </select>
                    </label>
                  ) : (
                    <div className="intg-keyrow">
                      <input type={showKey ? "text" : "password"} value={key} onChange={(e) => setKey(e.target.value)} placeholder={selectedProvider.hint} autoComplete="off" spellCheck={false} />
                      <button type="button" className="intg-eye" onClick={() => setShowKey((v) => !v)} aria-label={showKey ? "Hide key" : "Show key"}>{showKey ? <EyeOff /> : <Eye />}</button>
                    </div>
                  )}
                  <div className="intg-actions">
                    <button type="button" className="intg-btn" disabled={busy !== ""} onClick={test}>{busy === "test" ? "Testing..." : provider === "ollama" ? "Test Ollama" : "Test key"}</button>
                    <button type="button" className="intg-btn solid" disabled={busy !== ""} onClick={save}>{busy === "save" ? "Saving..." : provider === "ollama" ? "Use local model" : "Save connection"}</button>
                    {status?.connected && <button type="button" className="intg-btn danger" disabled={busy !== ""} onClick={remove}>{busy === "remove" ? "Removing..." : "Remove key"}</button>}
                  </div>
                  {notice && <div className={"intg-notice " + notice.kind}>{notice.text}</div>}
                </div>
              </div>
            )}
          </>
        )}

        <div className="intg-explain">
          <div className="intg-explain-heading"><span className="intg-card-kicker">GOOD TO KNOW</span><h3>How your connection works</h3></div>
          <div className="intg-explain-grid">
            <div><span className="explain-index">01</span><b>Your key stays yours</b><p>The full key is never returned to the interface. Only a masked ending is shown after saving.</p></div>
            <div><span className="explain-index">02</span><b>It powers the whole loop</b><p>Replies, pattern checks, tool creation, and reusable tool runs all use your selected provider.</p></div>
            <div><span className="explain-index">03</span><b>You can remove it anytime</b><p>Delete the saved key whenever you want. Recur then uses the server fallback, if one is configured.</p></div>
          </div>
        </div>
      </div>
    </section>
  );
}
