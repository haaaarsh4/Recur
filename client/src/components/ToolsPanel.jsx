import React, { useState } from "react";
import { Puzzle, X } from "lucide-react";
import { formatMs } from "../format.js";

export default function ToolsPanel({ tools, stats, onReset, onDeleteTool }) {
  const [openId, setOpenId] = useState(null);
  const [confirming, setConfirming] = useState(false);
  // Which single row is waiting for confirmation, so a delete asks once and the
  // question sits next to the program it is about.
  const [confirmingId, setConfirmingId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Every delete goes through here, so a failure is always reported instead of
  // leaving the button looking like it did nothing.
  async function runDeletion(action) {
    setBusy(true);
    setError("");
    try {
      await action();
      return true;
    } catch (failure) {
      setError(failure?.message || "That delete did not go through. The registry is unchanged.");
      return false;
    } finally {
      setBusy(false);
    }
  }
  // Programs that are still usable. A program a later compilation replaced stays
  // in the list as history, but it is not one of the programs doing the work.
  const active = tools.filter((tool) => tool.program && tool.status !== "superseded");

  return (
    <section className="tools-view">
      <div className="tv-inner">
        <h2>Tool registry</h2>
        <p className="sub">Every compiled program, what it computes, the evidence it was compiled from, and how it behaves when it cannot answer.</p>
        <div className="tv-stats">
          <div><span className="n">{active.length}</span>program{active.length === 1 ? "" : "s"} compiled</div>
          <div><span className="n">{stats?.hits ?? 0}</span>local executions</div>
          <div><span className="n">{stats?.avgToolLatencyMs != null ? formatMs(stats.avgToolLatencyMs) : "n/a"}</span>avg compiled latency</div>
          <div><span className="n">{stats?.avgGeneralLatencyMs != null ? formatMs(stats.avgGeneralLatencyMs) : "n/a"}</span>avg model latency</div>
        </div>
        <div className="tool-list">
          {tools.length === 0 && <div className="empty">No programs compiled yet. Chat a bit and once Recur notices the same task a few times, it will ask whether to compile one from your confirmed answers.</div>}
          {[...tools].sort((a, b) => statusRank(a) - statusRank(b) || (b.executions || 0) - (a.executions || 0)).map((tool) => {
            const executions = tool.executions || 0;
            const average = executions ? (tool.totalLatencyMs || 0) / executions : 0;
            const open = openId === tool.id;
            const replaced = tool.status === "superseded";
            const legacy = !tool.program;
            const badge = replaced ? "replaced" : legacy ? "legacy" : null;
            const awaitingDelete = confirmingId === tool.id;
            return (
              <article key={tool.id} className={"tool-row" + (open ? " open" : "") + (replaced ? " replaced" : "") + (legacy ? " legacy" : "")}>
                <div className="tool-row-head">
                  <button className="tool-row-toggle" type="button" onClick={() => setOpenId(open ? null : tool.id)} aria-expanded={open}>
                    <span className="tool-row-heading">
                      <span className="name">{tool.name}{badge ? <span className="tool-status">{badge}</span> : null}</span>
                      <span className="stats">{replaced ? "no longer used" : legacy ? "not executable" : `${executions} local run${executions === 1 ? "" : "s"}${executions ? ` · avg ${formatMs(average)}` : ""}`}</span>
                    </span>
                    <span className="tool-row-description">{taskDescription(tool)}</span>
                  </button>
                  <button
                    className="tool-row-delete"
                    type="button"
                    disabled={busy}
                    aria-label={`Delete ${tool.name}`}
                    title={`Delete ${tool.name}`}
                    onClick={() => { setConfirmingId(awaitingDelete ? null : tool.id); setError(""); }}
                  >
                    <X />
                  </button>
                </div>
                {awaitingDelete && (
                  <div className="confirm-row row-confirm">
                    <span>Delete {tool.name} and its stats?</span>
                    <button className="cancel-btn" type="button" disabled={busy} onClick={() => setConfirmingId(null)}>Cancel</button>
                    <button
                      className="danger-btn"
                      type="button"
                      disabled={busy}
                      onClick={async () => {
                        if (await runDeletion(() => onDeleteTool(tool.id || tool.name))) setConfirmingId(null);
                      }}
                    >
                      {busy ? "Deleting..." : "Delete"}
                    </button>
                  </div>
                )}
                {open && <RegistryProgramDetails tool={tool} />}
              </article>
            );
          })}
        </div>
        {error && <div className="tv-error">{error}</div>}
        {/* The question takes the place of the button that asked it, so there is
            one control in one place instead of two stacked rows. */}
        <div className="tv-footer">
          {confirming ? (
            <div className="confirm-row">
              <span>Delete every compiled program and its stats?</span>
              <button className="cancel-btn" type="button" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
              <button
                className="danger-btn"
                type="button"
                disabled={busy}
                onClick={async () => {
                  if (await runDeletion(onReset)) setConfirming(false);
                }}
              >
                {busy ? "Deleting..." : "Delete everything"}
              </button>
            </div>
          ) : (
            <button type="button" disabled={busy} onClick={() => { setConfirming(true); setConfirmingId(null); setError(""); }}>Clear shared tool library</button>
          )}
        </div>
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
  const faults = Number(metrics.coverage?.faults || 0);
  const outliers = metrics.coverage?.outliers || [];
  const setAside = new Set(outliers.map((outlier) => String(outlier.output)));
  const generalization = metrics.generalization || {};
  const folds = generalization.folds || 0;
  const rows = [
    ["Program", tool.name],
    ["Task", taskDescription(tool)],
    ["Runtime", isProgram ? `${tool.runtime}, executed locally with no model call` : "legacy contract, not executable"],
    ["Compiled path", path || "not available"],
    ["Evidence", `${demonstrations} verified demonstration${demonstrations === 1 ? "" : "s"}, ${discarded} conflicting input${discarded === 1 ? "" : "s"} discarded before compiling, ${metrics.candidatesExplored || 0} candidate programs searched`],
    [
      "Consistency",
      `the program computes an answer for all ${demonstrations} demonstration${demonstrations === 1 ? "" : "s"}; ${exact} reproduced the recorded wording exactly` +
        `${variants ? `, ${variants} said the same thing in different words` : ""}` +
        `${faults ? `, ${faults} recorded repl${faults === 1 ? "y was" : "ies were"} set aside as a model error` : ""}`,
    ],
    [
      "Generalization",
      summary.family === "table"
        ? "verified lookup: answers observed inputs, declines anything else" +
          (metrics.coverage?.singleDemonstration ? ". Only one demonstration was recorded, which cannot identify a computation, so the recorded reply is repeated rather than generalised" : "")
        : generalization.note
        ? generalization.note
        : folds && generalization.passed !== (generalization.computed ?? generalization.passed)
        ? `leave-one-out answered ${generalization.computed ?? generalization.passed} of ${folds} held-out requests, reproducing the recorded wording in ${generalization.passed ?? 0} of them`
        : `leave-one-out ${generalization.passed ?? 0} of ${folds} folds, verified without the held-out demonstration`,
    ],
    [
      "Acceptance head",
      neural
        ? `${neural.positives} positive and ${neural.negatives} negative examples, ${tool.neural.hidden} hidden units, holdout accuracy ${Math.round((neural.holdoutAccuracy ?? 0) * 100)}%, trained locally`
        : "not trained",
    ],
    ["Stress test", `${stress.cases || 0} generated in-domain inputs, ${stress.executed || 0} executed, ${stress.declined || 0} declined, ${stress.crashes || 0} exceptions, deterministic`],
    [
      "Status",
      !isProgram
        ? "legacy contract, recompile to get an executable program"
        : tool.status === "superseded"
        ? `replaced by ${tool.supersededBy || "a later program"}; kept as history and never matched again`
        : "compiled, verified, and available for reuse",
    ],
  ];
  if (metrics.coverage?.authority) {
    rows.push([
      "Authority",
      "the requests name a computation with one correct answer, so the program computes it; recorded replies that disagreed are set aside as model errors instead of being imitated",
    ]);
  }

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
          <div className="registry-samples-heading">
            {setAside.size ? "Recorded replies this program was compiled from, and why one was set aside" : "Verified demonstrations this program reproduces"}
          </div>
          {tool.tests.slice(0, 4).map((test, i) => (
            <div className="registry-sample" key={i}>
              <span className="registry-sample-in">{test.input}</span>
              <span className="registry-sample-arrow">→</span>
              <span className="registry-sample-out">{test.output}</span>
              {setAside.has(String(test.output)) ? <span className="registry-sample-flag">set aside: a model error</span> : null}
            </div>
          ))}
        </div>
      )}
      {outliers.length > 0 && (
        <div className="registry-detail-note">
          {outliers.map((outlier) => `${outlier.reason || "this recorded reply disagrees with the computed answer"}`).join(" ")}
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

// Live programs come first because they are the ones doing the work, then the
// legacy contracts that cannot run, then the programs a later compilation
// replaced. The order never hides anything, it only ranks it.
function statusRank(tool) {
  if (tool.status === "superseded") return 2;
  return tool.program ? 0 : 1;
}

// The row line for a program. The server generates the stored description from
// the program itself, so this is only the last resort. It never prints an
// internal operation name ("the recurring lookup-sequence-element computation in
// the math domain" describes the compiler, not the task): the recorded request
// is real evidence and reads like something a person asked for.
function taskDescription(tool) {
  const specification = String(tool.specification || "").replace(/\s+/g, " ").trim();
  if (specification) return specification.replace(/[.]$/, "") + ".";
  const examples = [...(tool.sourceTasks || []), ...(tool.tests || []).map((test) => test?.input)];
  const example = examples.map((text) => String(text ?? "").trim()).find(Boolean);
  if (example) return `Compiled from requests like "${example.slice(0, 80)}".`;
  return "A compiled program with no recorded description.";
}
