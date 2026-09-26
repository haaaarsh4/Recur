import React, { useState } from "react";
import { Puzzle } from "lucide-react";

export default function ToolsPanel({ tools, stats, onReset }) {
  const [openId, setOpenId] = useState(null);
  const [confirming, setConfirming] = useState(false);

  return (
    <section className="tools-view">
      <div className="tv-inner">
        <h2>Tool registry</h2>
        <p className="sub">Every compiled program, what it computes, the evidence it was compiled from, and how it behaves when it cannot answer.</p>
        <div className="tv-stats">
          <div><span className="n">{tools.length}</span>programs compiled</div>
          <div><span className="n">{stats?.hits ?? 0}</span>local executions</div>
          <div><span className="n">{stats?.avgToolLatencyMs != null ? stats.avgToolLatencyMs + "ms" : "n/a"}</span>avg compiled latency</div>
          <div><span className="n">{stats?.avgGeneralLatencyMs != null ? stats.avgGeneralLatencyMs + "ms" : "n/a"}</span>avg model latency</div>
        </div>
        <div className="tool-list">
          {tools.length === 0 && <div className="empty">No programs compiled yet. Chat a bit and once Recur notices the same task a few times, it will ask whether to compile one from your confirmed answers.</div>}
          {[...tools].sort((a, b) => (b.executions || 0) - (a.executions || 0)).map((tool) => {
            const executions = tool.executions || 0;
            const average = executions ? Math.round((tool.totalLatencyMs || 0) / executions) : 0;
            const open = openId === tool.id;
            return (
              <article key={tool.id} className={"tool-row" + (open ? " open" : "")}>
                <button className="tool-row-toggle" type="button" onClick={() => setOpenId(open ? null : tool.id)} aria-expanded={open}>
                  <span className="tool-row-heading">
                    <span className="name">{tool.name}</span>
                    <span className="stats">{executions} local run{executions === 1 ? "" : "s"}{executions ? ` · avg ${average}ms` : ""}</span>
                  </span>
                  <span className="tool-row-description">{taskDescription(tool)}</span>
                </button>
                {open && <RegistryProgramDetails tool={tool} />}
              </article>
            );
          })}
        </div>
        <div className="tv-footer"><button type="button" onClick={() => setConfirming(true)}>Clear shared tool library</button></div>
        {confirming && (
          <div className="confirm-row show">
            <span>Delete every compiled program and its stats?</span>
            <button className="cancel-btn" type="button" onClick={() => setConfirming(false)}>Cancel</button>
            <button className="danger-btn" type="button" onClick={() => { setConfirming(false); onReset(); }}>Delete everything</button>
          </div>
        )}
      </div>
    </section>
  );
}

function RegistryProgramDetails({ tool }) {
  const metrics = tool.metrics || {};
  const summary = tool.summary || {};
  const neural = tool.neural?.stats || null;
  const stress = metrics.stress || {};
  const demonstrations = Number(metrics.demonstrations ?? tool.tests?.length ?? 0);
  const reproduced = Number(metrics.reproduced ?? 0);
  const discarded = Number(tool.discarded?.length || 0);
  const path = summary.path || (tool.listing || []).join(" → ");
  const isProgram = Boolean(tool.program);
  const derived = summary.derivedBranches || [];

  const exact = Number(metrics.coverage?.exact ?? reproduced);
  const variants = Number(metrics.coverage?.variants || 0);
  const rows = [
    ["Program", tool.name],
    ["Task", taskDescription(tool)],
    ["Runtime", isProgram ? `${tool.runtime}, executed locally with no model call` : "legacy contract, not executable"],
    ["Compiled path", path || "not available"],
    ["Evidence", `${demonstrations} verified demonstration${demonstrations === 1 ? "" : "s"}, ${discarded} conflicting input${discarded === 1 ? "" : "s"} discarded before compiling, ${metrics.candidatesExplored || 0} candidate programs searched`],
    ["Consistency", `${exact} of ${demonstrations} demonstrations reproduced exactly${variants ? `, ${variants} recognised as the same answer in different words` : ""}`],
    [
      "Generalization",
      summary.family === "table"
        ? "verified lookup: answers observed inputs, declines anything else"
        : `leave-one-out ${metrics.generalization?.passed ?? 0} of ${metrics.generalization?.folds ?? 0} folds, verified without the held-out demonstration`,
    ],
    [
      "Acceptance head",
      neural
        ? `${neural.positives} positive and ${neural.negatives} negative examples, ${tool.neural.hidden} hidden units, holdout accuracy ${Math.round((neural.holdoutAccuracy ?? 0) * 100)}%, trained locally`
        : "not trained",
    ],
    ["Stress test", `${stress.cases || 0} generated in-domain inputs, ${stress.executed || 0} executed, ${stress.declined || 0} declined, ${stress.crashes || 0} exceptions, deterministic`],
    ["Status", isProgram ? "compiled, verified, and available for reuse" : "legacy contract, recompile to get an executable program"],
  ];

  return (
    <div className="registry-program-details">
      <div className="registry-detail-heading"><Puzzle /> Program details</div>
      <div className="registry-detail-lines">
        {rows.map(([label, value]) => (
          <div className="registry-detail-line" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      {(tool.tests || []).length > 0 && (
        <div className="registry-samples">
          <div className="registry-samples-heading">Verified demonstrations this program reproduces</div>
          {tool.tests.slice(0, 4).map((test, i) => (
            <div className="registry-sample" key={i}>
              <span className="registry-sample-in">{test.input}</span>
              <span className="registry-sample-arrow">→</span>
              <span className="registry-sample-out">{test.output}</span>
            </div>
          ))}
        </div>
      )}
      {derived.length > 0 && (
        <div className="registry-detail-note">
          The wording for {derived.join(" and ")} was derived by a documented transform over the observed branch, because every demonstration showed one outcome only.
        </div>
      )}
      {discarded > 0 && (
        <div className="registry-detail-note">
          {discarded} input{discarded === 1 ? "" : "s"} produced two different answers in your history, so {discarded === 1 ? "it was" : "they were"} excluded: conflicting evidence compiles nothing.
        </div>
      )}
    </div>
  );
}

function taskDescription(tool) {
  const specification = String(tool.specification || "").replace(/\s+/g, " ").trim();
  if (specification) return specification.replace(/[.]$/, "") + ".";
  const profile = tool.profile || {};
  return `the recurring ${profile.operation || "task"} computation in the ${profile.domain || "general"} domain.`;
}
