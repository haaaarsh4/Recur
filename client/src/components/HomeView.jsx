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
                A reusable tool is a small, focused instruction created from a pattern in your requests. It contains a
                clear description of the task, a few examples, and a matching fingerprint. When a future request looks
                similar, Recur can offer that tool instead of starting from scratch.
              </p>
            </div>
          </details>
          <details className="home-details">
            <summary>How does the neural logic work?</summary>
            <div className="details-content">
              <p>
                Each request becomes a compact text vector made from its words and word pairs. Recur compares those
                vectors with cosine similarity. A close match can trigger a reuse offer, while several related unmatched
                requests can form a new pattern. The language model then writes the tool description and examples.
              </p>
            </div>
          </details>
          <details className="home-details">
            <summary>How do I get started?</summary>
            <div className="details-content">
              <p>
                Connect an OpenAI or Anthropic key from Integrations, open Chat, and work as usual. After a few requests
                with the same shape, Recur will show an offer card. Accept it to create a tool, decline it to continue
                normally, or ask for clarification first.
              </p>
            </div>
          </details>
        </section>
      </div>
    </section>
  );
}
