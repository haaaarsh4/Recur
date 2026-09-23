import React, { useEffect, useMemo, useState } from "react";
import { Check, Eye, EyeOff, Plus, Trash2 } from "lucide-react";
import { api } from "../api.js";

// The server is the source of truth for optional hosted providers. This local
// fallback exists only while the integrations request is unavailable.
const FALLBACK_PROVIDERS = [
  { id: "ollama", label: "Ollama Local", protocol: "ollama", hint: "No API key required", baseUrl: "http://127.0.0.1:11434", models: ["qwen2.5:0.5b", "llama3.1:8b-instruct-q4_K_M", "smollm2:135m-instruct-q8_0"], defaultModel: "qwen2.5:0.5b" },
];

const emptyForm = {
  id: "",
  name: "",
  provider: "ollama",
  protocol: "ollama",
  baseUrl: "http://127.0.0.1:11434",
  model: "qwen2.5:0.5b",
  apiKey: "",
};

export default function IntegrationsPanel({ user, onRequireAuth }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(emptyForm);
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState(null);

  const providers = status?.providers?.length ? status.providers : FALLBACK_PROVIDERS;
  const selectedProvider = useMemo(() => providers.find((item) => item.id === form.provider) || providers[0], [providers, form.provider]);

  useEffect(() => {
    if (!user) {
      setStatus(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    api.getIntegration().then((data) => {
      setStatus(data);
      const active = data.connections?.find((item) => item.id === data.activeId) || data.connections?.[0];
      if (active) loadConnection(active, data.providers || FALLBACK_PROVIDERS);
      else setForm({ ...emptyForm });
    }).catch((error) => setNotice({ kind: "error", text: error.message })).finally(() => setLoading(false));
  }, [user]);

  function loadConnection(connection, providerList = providers) {
    const provider = providerList.find((item) => item.id === connection.provider) || providerList[0];
    setForm({
      id: connection.id,
      name: connection.name || provider.label,
      provider: connection.provider,
      protocol: connection.protocol || provider.protocol,
      baseUrl: connection.baseUrl || provider.baseUrl || "",
      model: connection.model || provider.defaultModel || "",
      apiKey: "",
    });
    setShowKey(false);
    setNotice(null);
  }

  function newConnection() {
    setForm({ ...emptyForm });
    setShowKey(false);
    setNotice(null);
  }

  function changeProvider(providerId) {
    const provider = providers.find((item) => item.id === providerId) || FALLBACK_PROVIDERS[0];
    setForm((current) => ({
      ...current,
      provider: provider.id,
      protocol: provider.protocol,
      baseUrl: provider.baseUrl || "",
      model: provider.defaultModel || "",
      name: current.id ? current.name : provider.label,
      apiKey: "",
    }));
    setNotice(null);
  }

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function save() {
    setBusy("save");
    setNotice(null);
    try {
      const data = await api.saveIntegration(form);
      setStatus(data);
      const active = data.connections.find((item) => item.id === data.activeId);
      if (active) loadConnection(active, data.providers);
      setNotice({ kind: "ok", text: "Connection saved. Recur can now use this provider." });
    } catch (error) {
      setNotice({ kind: "error", text: error.message });
    } finally {
      setBusy("");
    }
  }

  async function test() {
    setBusy("test");
    setNotice(null);
    try {
      const result = await api.testIntegration(form);
      setNotice(result.ok ? { kind: "ok", text: "The provider accepted this connection." } : { kind: "error", text: result.error || "The provider rejected this connection." });
    } catch (error) {
      setNotice({ kind: "error", text: error.message });
    } finally {
      setBusy("");
    }
  }

  async function activate(connection) {
    setBusy("active");
    try {
      const data = await api.setActiveIntegration(connection.id);
      setStatus(data);
      const active = data.connections.find((item) => item.id === data.activeId);
      if (active) loadConnection(active, data.providers);
    } catch (error) {
      setNotice({ kind: "error", text: error.message });
    } finally {
      setBusy("");
    }
  }

  async function remove(connection) {
    setBusy("remove");
    setNotice(null);
    try {
      const data = await api.deleteIntegration(connection.id);
      setStatus(data);
      const active = data.connections.find((item) => item.id === data.activeId);
      if (active) loadConnection(active, data.providers);
      else newConnection();
      setNotice({ kind: "ok", text: "Connection removed." });
    } catch (error) {
      setNotice({ kind: "error", text: error.message });
    } finally {
      setBusy("");
    }
  }

  if (!user) {
    return (
      <section className="tools-view integrations-view">
        <div className="tv-inner intg-inner">
          <IntegrationHeading />
          <div className="intg-guest-card">
            <div className="intg-guest-copy">
              <span className="intg-card-kicker">ACCOUNT CONNECTIONS</span>
              <div className="intg-guest-title-row">
                <h3>Sign in to connect API providers.</h3>
                <button className="intg-btn solid intg-login-action" type="button" onClick={() => onRequireAuth?.("login")} aria-label="Log in or sign up to add an API connection">Log in or join</button>
              </div>
              <p>Chat remains available as a guest. Sign in to save private API connections and keep your provider choices with your account.</p>
            </div>
          </div>
          <div className="intg-guest-explain" aria-label="Connection benefits">
            <div><span>01</span><b>Your key stays private</b><p>API keys are encrypted in server storage and never shown again after saving.</p></div>
            <div><span>02</span><b>It powers the whole loop</b><p>Your selected provider powers replies, pattern detection, tool creation, and reusable tool runs.</p></div>
            <div><span>03</span><b>You can remove it anytime</b><p>Delete a saved connection whenever you want and switch to another provider.</p></div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="tools-view integrations-view">
      <div className="tv-inner intg-inner">
        <IntegrationHeading />
        <div className="intg-private-note"><span>Private API connections</span><small>Keys are encrypted on the server and never shown again after saving.</small></div>
        <div className="intg-connections-layout">
          <aside className="intg-connections-list">
            <div className="intg-list-top"><span className="intg-card-kicker">SAVED CONNECTIONS</span><button type="button" onClick={newConnection} aria-label="Add API connection"><Plus /></button></div>
            {loading ? <div className="intg-list-empty">Loading connections...</div> : status?.connections?.length ? status.connections.map((connection) => (
              <div key={connection.id} className={"intg-connection-item" + (connection.id === status.activeId ? " active" : "") }>
                <button type="button" className="intg-connection-select" onClick={() => loadConnection(connection)}>
                  <span className="provider-logo">{connection.name.slice(0, 1).toUpperCase()}</span>
                  <span><b>{connection.name}</b><small>{connection.model}</small></span>
                  {connection.id === status.activeId && <Check />}
                </button>
                <button type="button" className="intg-connection-delete" onClick={() => remove(connection)} aria-label={`Remove ${connection.name}`}><Trash2 /></button>
              </div>
            )) : <div className="intg-list-empty">No API connections yet. Add one to get started.</div>}
            <button className="intg-add-connection" type="button" onClick={newConnection}><Plus /> Add API connection</button>
          </aside>

          <div className="intg-editor">
            <div className="intg-editor-heading"><div><span className="intg-card-kicker">{form.id ? "EDIT CONNECTION" : "NEW CONNECTION"}</span><h3>{form.id ? form.name : "Add an API provider"}</h3></div>{form.id && <span className="intg-active-label">{status?.activeId === form.id ? "Active" : "Saved"}</span>}</div>
            <div className="intg-form-grid">
              <label className="intg-field full"><span>Connection name</span><input value={form.name} onChange={(e) => update("name", e.target.value)} placeholder="My OpenAI account" /></label>
              <label className="intg-field full"><span>AI provider</span><select value={form.provider} onChange={(e) => changeProvider(e.target.value)}>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}</select></label>
              {selectedProvider.protocol === "ollama" ? (
                <div className="intg-field"><span>Authentication</span><div className="intg-local-note">Ollama runs locally. No API key is required.</div></div>
              ) : (
                <label className="intg-field"><span>API key <em>{selectedProvider.hint}</em></span><div className="intg-secret-field"><input type={showKey ? "text" : "password"} value={form.apiKey} onChange={(e) => update("apiKey", e.target.value)} placeholder={form.id ? "Saved securely. Enter a new key to replace it." : "Paste your API key"} autoComplete="off" /><button type="button" onClick={() => setShowKey((value) => !value)} aria-label={showKey ? "Hide API key" : "Show API key"}>{showKey ? <EyeOff /> : <Eye />}</button></div></label>
              )}
              <label className="intg-field"><span>Model</span>{selectedProvider.custom ? <input value={form.model} onChange={(e) => update("model", e.target.value)} placeholder="provider-model-name" /> : <select value={form.model} onChange={(e) => update("model", e.target.value)}>{(selectedProvider.models || []).map((model) => <option key={model} value={model}>{model}</option>)}</select>}</label>
              {selectedProvider.custom && <>
                <label className="intg-field"><span>API format</span><select value={form.protocol} onChange={(e) => update("protocol", e.target.value)}><option value="openai">OpenAI-compatible</option><option value="anthropic">Anthropic Messages</option><option value="gemini">Google Gemini</option></select></label>
                <label className="intg-field"><span>Base URL</span><input value={form.baseUrl} onChange={(e) => update("baseUrl", e.target.value)} placeholder="https://api.example.com/v1" /></label>
              </>}
            </div>
            <p className="intg-editor-help">The API key is used only by the server for this account. Recur never sends it back to the browser or displays the full value after saving.</p>
            {notice && <div className={"intg-notice " + notice.kind}>{notice.text}</div>}
            <div className="intg-editor-actions"><button type="button" className="intg-btn" disabled={Boolean(busy)} onClick={test}>{busy === "test" ? "Testing..." : "Test connection"}</button><button type="button" className="intg-btn solid" disabled={Boolean(busy)} onClick={save}>{busy === "save" ? "Saving..." : "Save connection"}</button>{form.id && status?.activeId !== form.id && <button type="button" className="intg-btn" disabled={Boolean(busy)} onClick={() => activate({ id: form.id })}>{busy === "active" ? "Activating..." : "Make active"}</button>}</div>
          </div>
        </div>
      </div>
    </section>
  );
}

function IntegrationHeading() {
  return <div className="intg-heading"><div><h2>Integrations</h2><p className="sub">Connect the AI providers you already use. Keep several connections saved and choose which one powers Recur.</p></div></div>;
}
