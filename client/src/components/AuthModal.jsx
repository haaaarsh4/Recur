import React, { useState } from "react";
import { ArrowLeft, Eye, EyeOff, Mail, UserRound } from "lucide-react";
import { useAuth } from "../state/AuthContext.jsx";

export default function AuthModal({ initialMode = "login", onClose }) {
  const { login, register } = useAuth();
  const [mode, setMode] = useState(initialMode);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const isRegister = mode === "register";

  function switchMode(nextMode) {
    setMode(nextMode);
    setError("");
  }

  async function onSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (isRegister) {
        const name = [firstName, lastName].filter(Boolean).join(" ") || firstName;
        await register(email, password, name);
      } else {
        await login(email, password);
      }
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-background" aria-hidden="true">
        <span className="auth-glow auth-glow-a" />
        <span className="auth-glow auth-glow-b" />
        <span className="auth-grid" />
        <span className="auth-line auth-line-a" />
        <span className="auth-line auth-line-b" />
      </div>

      <div className="auth-frame">
        <header className="auth-nav">
          <button className="auth-brand" type="button" onClick={onClose} aria-label="Return to workspace">
            <span className="auth-brand-mark"><span /><span /><span /></span>
            <span>Recur<span className="auth-dot">.</span></span>
          </button>
          <nav className="auth-nav-links" aria-label="Authentication navigation">
            <button type="button" className={!isRegister ? "active" : ""} onClick={() => switchMode("login")}>Log in</button>
            <button type="button" className={isRegister ? "active" : ""} onClick={() => switchMode("register")}>Join</button>
          </nav>
          <button className="auth-back" type="button" onClick={onClose}>
            <ArrowLeft /> Back to workspace
          </button>
        </header>

        <main className="auth-layout">
          <section className="auth-form-panel">
            <div className="auth-form-wrap">
              <span className="auth-eyebrow">{isRegister ? "START FOR FREE" : "WELCOME BACK"}</span>
              <h1 className={"auth-title" + (isRegister ? " register-title" : "")}>
                <span className="auth-title-copy">{isRegister ? "Create new account" : "Log in to Recur"}</span>
                <span className="auth-dot">.</span>
              </h1>
              <p className="auth-switchline">
                {isRegister ? "Already a member?" : "New to Recur?"}{" "}
                <button type="button" className="auth-link" onClick={() => switchMode(isRegister ? "login" : "register")}>
                  {isRegister ? "Log in" : "Create one"}
                </button>
              </p>

              {error && <div className="auth-error">{error}</div>}

              <form className="auth-form" onSubmit={onSubmit}>
                {isRegister && (
                  <div className="field-row">
                    <div className="field">
                      <label htmlFor="first-name">First name</label>
                      <div className="field-input">
                        <input id="first-name" required autoFocus value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="Ada" />
                        <UserRound className="field-icon" />
                      </div>
                    </div>
                    <div className="field">
                      <label htmlFor="last-name">Last name</label>
                      <div className="field-input">
                        <input id="last-name" value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Lovelace" />
                        <UserRound className="field-icon" />
                      </div>
                    </div>
                  </div>
                )}

                <div className="field">
                  <label htmlFor="auth-email">Email</label>
                  <div className="field-input">
                    <input id="auth-email" type="email" required autoFocus={!isRegister} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
                    <Mail className="field-icon" />
                  </div>
                </div>

                <div className="field">
                  <label htmlFor="auth-password">Password</label>
                  <div className="field-input">
                    <input
                      id="auth-password"
                      type={showPw ? "text" : "password"}
                      required
                      minLength={6}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder={isRegister ? "At least 6 characters" : "Password"}
                    />
                    <button type="button" className="field-icon-btn" onClick={() => setShowPw((v) => !v)} aria-label={showPw ? "Hide password" : "Show password"}>
                      {showPw ? <EyeOff /> : <Eye />}
                    </button>
                  </div>
                </div>

                <div className="auth-actions">
                  <button type="button" className="ghost-pill" onClick={onClose}>Keep browsing</button>
                  <button type="submit" className="solid-pill" disabled={busy}>
                    {busy ? (isRegister ? "Creating..." : "Logging in...") : isRegister ? "Create account" : "Log in"}
                  </button>
                </div>
              </form>

            </div>
          </section>

          <aside className="auth-visual" aria-label="About Recur">
            <div className="auth-visual-art" aria-hidden="true">
              <span className="auth-orbit orbit-one" />
              <span className="auth-orbit orbit-two" />
              <span className="auth-orbit orbit-three" />
              <span className="auth-core"><span /></span>
              <span className="auth-node node-one" />
              <span className="auth-node node-two" />
              <span className="auth-node node-three" />
            </div>

          </aside>
        </main>
      </div>
    </div>
  );
}
