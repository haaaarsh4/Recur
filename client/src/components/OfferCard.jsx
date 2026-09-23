import React from "react";
import { Puzzle } from "lucide-react";

export default function OfferCard({ m, onResolve }) {
  const lead =
    m.offerType === "use" ? (
      <>
        I already have a tool for this: <b>{m.toolName}</b>. Use it, or answer from scratch?
      </>
    ) : (
      <>I've identified a recurring task in {m.clusterCount} requests. Do you want me to compile a reusable neural program for it?</>
    );
  const meta =
    m.offerType === "use"
      ? `${Math.round(m.similarity * 100)}% match · ${m.toolSpec || ""}`
      : `similar to: ${(m.clusterExamples || []).slice(0, 2).join(" · ")}`;

  return (
    <div className="msg-row assistant">
      <div className="offer-card">
        <div className="lead">{lead}</div>
        <div className="meta">{meta}</div>
        {!m.resolved ? (
          <div className="offer-buttons">
            {m.offerType === "use" ? (
              <>
                <button className="go" onClick={() => onResolve(m.id, "use")}>
                  <Puzzle /> Use {m.toolName}
                </button>
                <button onClick={() => onResolve(m.id, "general")}>Answer from scratch</button>
                <button onClick={() => onResolve(m.id, "clarify")}>Not sure, ask me</button>
              </>
            ) : (
              <>
                <button className="go" onClick={() => onResolve(m.id, "create")}>
                  <Puzzle /> Compile neural program
                </button>
                <button onClick={() => onResolve(m.id, "general")}>Just answer this time</button>
                <button onClick={() => onResolve(m.id, "clarify")}>Not sure, ask me</button>
              </>
            )}
          </div>
        ) : (
          <div className="offer-resolved">
            {m.resolved === "use"
              ? "→ used the reusable neural program"
              : m.resolved === "create"
              ? "→ compiled and used the reusable neural program"
              : m.resolved === "clarify"
              ? "→ asked a follow-up question"
              : "→ answered from scratch"}
          </div>
        )}
      </div>
    </div>
  );
}
