import React, { useState } from "react";
import { Puzzle } from "lucide-react";

export default function ToolsPanel({ tools, stats, onReset }) {
  const [openId, setOpenId] = useState(null);
  const [confirming, setConfirming] = useState(false);

  return (
    <section className="tools-view">
      <div className="tv-inner">
        <h2>Tool registry</h2>
        <p className="sub">Every compiled reusable program, with a clear description of the task it performs and the evidence behind it.</p>
        <div className="tv-stats">
          <div><span className="n">{tools.length}</span>tools compiled</div>
          <div><span className="n">{stats?.hits ?? 0}</span>tool executions</div>
          <div><span className="n">{stats?.avgToolLatencyMs != null ? stats.avgToolLatencyMs + "ms" : "n/a"}</span>avg compiled latency</div>
          <div><span className="n">{stats?.avgGeneralLatencyMs != null ? stats.avgGeneralLatencyMs + "ms" : "n/a"}</span>avg general latency</div>
        </div>
        <div className="tool-list">
          {tools.length === 0 && <div className="empty">No tools compiled yet. Chat a bit and once Recur notices the same kind of task a few times, it will ask whether to build one.</div>}
          {[...tools].sort((a, b) => (b.executions || 0) - (a.executions || 0)).map((tool) => {
            const executions = tool.executions || 0;
            const average = executions ? Math.round((tool.totalLatencyMs || 0) / executions) : 0;
            const open = openId === tool.id;
            return (
              <article key={tool.id} className={"tool-row" + (open ? " open" : "")}>
                <button className="tool-row-toggle" type="button" onClick={() => setOpenId(open ? null : tool.id)} aria-expanded={open}>
                  <span className="tool-row-heading">
                    <span className="name">{tool.name}</span>
                    <span className="stats">{executions} run{executions === 1 ? "" : "s"}{executions ? ` · avg ${average}ms` : ""}</span>
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
            <span>Delete every compiled tool and its stats?</span>
            <button className="cancel-btn" type="button" onClick={() => setConfirming(false)}>Cancel</button>
            <button className="danger-btn" type="button" onClick={() => { setConfirming(false); onReset(); }}>Delete everything</button>
          </div>
        )}
      </div>
    </section>
  );
}

function RegistryProgramDetails({ tool }) {
  const dataset = tool.dataset || {};
  const observed = Number(dataset.seed || tool.examples?.length || 0);
  const total = Number(dataset.total || tool.examples?.length || 0);
  const sourceCount = tool.sourceTasks?.length || 0;
  const accuracy = tool.accuracy == null ? "not measured yet; this prototype has no independent test set." : `${tool.accuracy}%`;
  const rows = [
    ["Program", tool.name],
    ["Task", taskDescription(tool)],
    ["Runtime", tool.runtime || "contract-guided model program"],
    ["Training evidence", `${observed} consistent verified example${observed === 1 ? "" : "s"} from ${sourceCount} source request${sourceCount === 1 ? "" : "s"}.`],
    ["Accuracy", accuracy],
    ["Status", "saved and available for future matching requests."],
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
      <div className="registry-detail-note">Dataset record: {total} retained example{total === 1 ? "" : "s"}; {dataset.split?.train || 0} train, {dataset.split?.validation || 0} validation, and {dataset.split?.test || 0} test. Separate neural-weight training is not run in this Node prototype.</div>
    </div>
  );
}

function taskDescription(tool) {
  const specification = String(tool.specification || "").replace(/\s+/g, " ").trim();
  if (specification && !/^handles recurring|^performs the recurring/i.test(specification)) return specification.replace(/[.]$/, "") + ".";
  const profile = tool.profile || {};
  return `the recurring ${profile.operation || "task"} computation in the ${profile.domain || "general"} domain.`;
}
