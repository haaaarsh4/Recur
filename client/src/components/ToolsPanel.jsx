import React, { useState } from "react";

export default function ToolsPanel({ tools, stats, onReset, user, onRequireAuth }) {
  const [openId, setOpenId] = useState(null);
  const [confirming, setConfirming] = useState(false);

  function handleResetClick() {
    setConfirming(true);
  }

  return (
    <section className="tools-view">
      <div className="tv-inner">
        <h2>Tool registry</h2>
        <p className="sub">Every compiled tool, shared across everyone using this server.</p>
        <div className="tv-stats">
          <div>
            <span className="n">{tools.length}</span>tools compiled
          </div>
          <div>
            <span className="n">{stats?.hits ?? 0}</span>tool executions
          </div>
          <div>
            <span className="n">{stats?.avgToolLatencyMs != null ? stats.avgToolLatencyMs + "ms" : "n/a"}</span>avg compiled latency
          </div>
          <div>
            <span className="n">{stats?.avgGeneralLatencyMs != null ? stats.avgGeneralLatencyMs + "ms" : "n/a"}</span>avg general latency
          </div>
        </div>
        <div className="tool-list">
          {tools.length === 0 && (
            <div className="empty">No tools compiled yet. Chat a bit and once Recur notices the same kind of task a few times, it will ask whether to build one.</div>
          )}
          {[...tools]
            .sort((a, b) => (b.executions || 0) - (a.executions || 0))
            .map((t) => {
              const avg = t.executions ? Math.round(t.totalLatencyMs / t.executions) : 0;
              const open = openId === t.id;
              return (
                <div key={t.id} className="tool-row" onClick={() => setOpenId(open ? null : t.id)}>
                  <div className="top">
                    <span className="name">{t.name}</span>
                    <span className="stats">
                      {t.executions || 0} run{(t.executions || 0) === 1 ? "" : "s"}
                      {t.executions ? ` · avg ${avg}ms` : ""}
                    </span>
                  </div>
                  <div className="spec">{t.specification}</div>
                  {open && (
                    <div className="tool-detail show">
                      {t.examples?.length > 0 && (
                        <>
                          <span className="lbl">Example behavior</span>
                          {t.examples.map((e, i) => (
                            <div className="ex" key={i}>{`in: ${e.input}\nout: ${e.output}`}</div>
                          ))}
                        </>
                      )}
                      {t.sourceTasks?.length > 0 && (
                        <>
                          <span className="lbl">Compiled from</span>
                          {t.sourceTasks.map((s, i) => (
                            <div className="ex" key={i}>
                              {s}
                            </div>
                          ))}
                        </>
                      )}
                      <span className="lbl">Created</span>
                      <div className="ex">{new Date(t.createdAt).toLocaleString()}</div>
                    </div>
                  )}
                </div>
              );
            })}
        </div>
        <div className="tv-footer">
          <button type="button" onClick={handleResetClick}>
            Clear shared tool library
          </button>
        </div>
        {confirming && (
          <div className="confirm-row show">
            <span>Delete every compiled tool and its stats?</span>
            <button className="cancel-btn" type="button" onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button
              className="danger-btn"
              type="button"
              onClick={() => {
                setConfirming(false);
                onReset();
              }}
            >
              Delete everything
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
