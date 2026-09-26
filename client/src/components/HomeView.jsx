import React from "react";

export default function HomeView({ user, toolsCount, stats, onGoChat, onGoTools, onGoIntegrations }) {
  const reuse = stats?.reuseRate;

  return (
    <section className="home-view">
      <div className="home-shell">
        <header className="home-hero">
          <span className="home-kicker">RECUR WORKSPACE</span>
          <h1>
            Welcome{user?.name ? `, ${user.name}` : ""}<span className="dot">.</span>
          </h1>
          <p className="home-lede">
            Builds reusable tools from tasks you repeat, and always asks before using one.
          </p>
          <div className="home-actions">
            <button className="home-btn solid" type="button" onClick={onGoChat}>Open chat</button>
            <button className="home-btn" type="button" onClick={onGoTools}>View tool registry</button>
            <button className="home-btn" type="button" onClick={onGoIntegrations}>Connect API key</button>
          </div>
        </header>

        <section className="home-workflow-block" aria-label="How Recur works">
          <div className="home-workflow">
            <div className="home-workflow-item">
              <span className="workflow-number">01</span>
              <h3>Chat normally</h3>
              <p>Ask questions, review tickets, or request the work you repeat most often.</p>
            </div>
            <div className="home-workflow-item">
              <span className="workflow-number">02</span>
              <h3>Patterns emerge</h3>
              <p>Similar requests are grouped together so repeated work becomes visible.</p>
            </div>
            <div className="home-workflow-item">
              <span className="workflow-number">03</span>
              <h3>You stay in control</h3>
              <p>Recur asks before creating or using anything. Every decision is yours.</p>
            </div>
          </div>
        </section>

        <section className="home-info" aria-label="Frequently asked questions">
          <div className="home-info-heading">
            <span className="home-info-kicker">HELP CENTER</span>
            <h2>Frequently asked questions</h2>
          </div>
          <details className="home-details">
            <summary>What is a reusable tool?</summary>
            <div className="details-content">
              <p>
                A reusable tool is a real program compiled from a pattern in your requests. Recur takes the answers you
                already confirmed, drops any input that once produced two different answers, then searches for the
                smallest computation that reproduces every remaining example exactly. What comes out is executable: a
                read step, a few operators, and an answer step, stored with the evidence behind it.
              </p>
            </div>
          </details>
          <details className="home-details">
            <summary>How does the neural logic work?</summary>
            <div className="details-content">
              <p>
                Each request becomes a compact vector from its words and word pairs, and a task profile records the
                intent, domain and operation. Matching needs both to agree, so unrelated questions never merge. A
                compiled program also carries a small acceptance head: a network trained on your own examples, in your
                own process, that decides whether a new request is inside the program's learned input distribution
                before it runs on its own. Reuse itself is a plain function call with no model involved.
              </p>
            </div>
          </details>
          <details className="home-details">
            <summary>How do I get started?</summary>
            <div className="details-content">
              <p>
                Connect a provider from Integrations, or keep using Ollama locally, then open Chat and work as usual.
                After a few requests with the same shape, Recur offers to compile a program from them. Accept it and the
                program answers that request immediately, in milliseconds, with its full execution trace shown in the
                thread. Decline it and your request is simply answered by the model as before.
              </p>
            </div>
          </details>
        </section>
      </div>
    </section>
  );
}
