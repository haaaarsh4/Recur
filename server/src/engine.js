import { nanoid } from "nanoid";
import { db } from "./db.js";
import { embed, cosine, centroid } from "./embeddings.js";
import { callLLM, callLLMJson } from "./llm.js";

const MATCH_THRESHOLD = 0.6; // how close a task must be to an existing tool to offer it
const CLUSTER_THRESHOLD = 0.55; // how close unmatched tasks must be to count as "the same pattern"
const CLUSTER_SIZE = 3; // how many similar tasks before Recur offers to compile a tool

function msg(fields) {
  return { id: nanoid(), ts: Date.now(), ...fields };
}

function bestMatch(vec) {
  let best = null,
    bestSim = 0;
  for (const t of db.data.tools) {
    if (!t.embedding) continue;
    const sim = cosine(vec, t.embedding);
    if (sim > bestSim) {
      bestSim = sim;
      best = t;
    }
  }
  return { best, bestSim };
}

function clusterFor(vec) {
  return db.data.pending.filter((p) => cosine(vec, p.vector) >= CLUSTER_THRESHOLD);
}

function buildGeneralPrompt(text) {
  return `Answer the following request directly and concisely. Respond with only the answer itself. No preamble and no meta commentary.\n\nRequest: ${text}`;
}

function buildToolPrompt(tool, text) {
  let ex = "";
  if (tool.examples?.length) {
    ex =
      "\n\nExamples of this tool's behavior:\n" +
      tool.examples.map((e) => `- input: ${e.input}\n  output: ${e.output}`).join("\n");
  }
  return `You are a narrow, specialized tool named "${tool.name}".\nWhat you do: ${tool.specification}${ex}\n\nApply this exactly to the input below. Respond with only the result, matching the style of the examples. No preamble and no explanation.\n\nInput: ${text}`;
}

function buildCompilePrompt(texts) {
  return `These ${texts.length} user requests all seem to follow the same underlying pattern:\n${texts
    .map((t, i) => `${i + 1}. ${t}`)
    .join(
      "\n"
    )}\n\nGeneralize this into a reusable tool. Reply with a JSON object of this exact shape:\n{"name": "kebab-case-name-2-to-4-words", "specification": "one precise sentence describing exactly what task this tool performs, generalized beyond these specific examples", "examples": [{"input": "...", "output": "..."}]}\nInclude 2 to 3 short illustrative examples consistent with the pattern above.`;
}

function buildClarifyPrompt(taskText, context) {
  return `A user sent this request: "${taskText}"\n\nContext: ${context}\n\nAsk ONE short, natural clarifying question that would help decide how to handle it. Reply with only the question, nothing else.`;
}

function sanitizeName(name) {
  if (!name || typeof name !== "string") return null;
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || null
  );
}

async function recordLog(entry) {
  db.data.log.push({ id: nanoid(), ts: Date.now(), ...entry });
}

function bumpTool(tool, latency) {
  tool.executions = (tool.executions || 0) + 1;
  tool.totalLatencyMs = (tool.totalLatencyMs || 0) + latency;
}

async function compileToolFrom(members, currentText, currentVec, creds = null) {
  const texts = [...members.map((m) => m.text), currentText];
  const { data } = await callLLMJson(buildCompilePrompt(texts), "default", creds);
  const vecs = [...members.map((m) => m.vector), currentVec];
  const embedding = centroid(vecs);
  const tool = {
    id: nanoid(),
    name: sanitizeName(data.name) || "tool-" + Date.now(),
    specification: String(data.specification || "").slice(0, 400),
    examples: Array.isArray(data.examples)
      ? data.examples.slice(0, 3).map((e) => ({ input: String(e.input || "").slice(0, 300), output: String(e.output || "").slice(0, 300) }))
      : [],
    sourceTasks: texts.slice(0, 6),
    embedding,
    createdAt: Date.now(),
    executions: 0,
    totalLatencyMs: 0,
  };
  db.data.tools.unshift(tool);
  const memberIds = new Set(members.map((m) => m.id));
  db.data.pending = db.data.pending.filter((p) => !memberIds.has(p.id));
  return tool;
}

/** Runs a brand-new task through the pipeline: match an existing tool, notice a
 *  forming pattern, or just answer it. `creds` carries the caller's LLM key when
 *  they saved one on the Integrations page. Returns the message(s) to append. */
async function processTask(chat, text, tier, creds = null) {
  if (/\b(what|who)\s+(are|is)\s+(you|recur|this chatbot|this assistant)\b/i.test(text) || /\bwhat does recur do\b/i.test(text)) {
    return [msg({
      role: "assistant",
      kind: "text",
      text: "I am Recur, a chat assistant that answers your requests, notices repeated patterns, and helps turn repeated work into reusable tools. Recur always asks before creating or using a tool.",
      tierApplied: tier,
      latency: 0,
    })];
  }
  const vec = embed(text);
  const { best, bestSim } = bestMatch(vec);

  if (best && bestSim >= MATCH_THRESHOLD) {
    return [
      msg({
        role: "assistant",
        kind: "offer",
        offerType: "use",
        toolId: best.id,
        toolName: best.name,
        toolSpec: best.specification,
        similarity: bestSim,
        taskText: text,
        resolved: null,
      }),
    ];
  }

  const cluster = clusterFor(vec);
  if (cluster.length >= CLUSTER_SIZE - 1) {
    return [
      msg({
        role: "assistant",
        kind: "offer",
        offerType: "create",
        clusterCount: cluster.length + 1,
        clusterExamples: cluster.map((c) => c.text),
        clusterMemberIds: cluster.map((c) => c.id),
        taskText: text,
        resolved: null,
      }),
    ];
  }

  const r = await callLLM(buildGeneralPrompt(text), tier, creds);
  await recordLog({ type: "general", latencyMs: r.latencyMs });
  db.data.pending.push({ id: nanoid(), text, vector: vec, createdAt: Date.now() });
  return [msg({ role: "assistant", kind: "text", text: r.text, tierApplied: tier, latency: r.latencyMs })];
}

/** Handles the user's choice on an offer card: use the tool, answer from scratch,
 *  create the tool, or ask a clarifying question. Mutates offerMsg.resolved in place. */
async function resolveOffer(chat, offerMsg, action, tier, creds = null) {
  const out = [];

  if (action === "clarify") {
    offerMsg.resolved = "clarify";
    const ctx =
      offerMsg.offerType === "use"
        ? `I have an existing tool for: "${offerMsg.toolSpec}". Check whether this task really fits.`
        : `I'm deciding whether to compile a reusable tool from a few similar requests.`;
    const r = await callLLM(buildClarifyPrompt(offerMsg.taskText, ctx), "quick", creds);
    out.push(msg({ role: "assistant", kind: "text", text: r.text }));
    chat.awaiting = { originalText: offerMsg.taskText };
    return out;
  }

  if (action === "general") {
    offerMsg.resolved = "general";
    const r = await callLLM(buildGeneralPrompt(offerMsg.taskText), tier, creds);
    await recordLog({ type: "general", latencyMs: r.latencyMs });
    out.push(msg({ role: "assistant", kind: "text", text: r.text, tierApplied: tier, latency: r.latencyMs }));
    if (offerMsg.offerType === "create" && offerMsg.clusterMemberIds) {
      const ids = new Set(offerMsg.clusterMemberIds);
      db.data.pending = db.data.pending.filter((p) => !ids.has(p.id));
    }
    return out;
  }

  if (action === "use") {
    offerMsg.resolved = "use";
    const tool = db.data.tools.find((t) => t.id === offerMsg.toolId);
    if (!tool) throw Object.assign(new Error("That tool no longer exists."), { code: "not_found" });
    const r = await callLLM(buildToolPrompt(tool, offerMsg.taskText), "quick", creds);
    out.push(msg({ role: "assistant", kind: "text", text: r.text, viaTool: tool.name, latency: r.latencyMs }));
    await recordLog({ type: "hit", toolId: tool.id, toolName: tool.name, latencyMs: r.latencyMs });
    bumpTool(tool, r.latencyMs);
    return out;
  }

  if (action === "create") {
    offerMsg.resolved = "create";
    const members = db.data.pending.filter((p) => offerMsg.clusterMemberIds.includes(p.id));
    const vec = embed(offerMsg.taskText);
    const tool = await compileToolFrom(members, offerMsg.taskText, vec, creds);
    out.push(msg({ role: "system", kind: "compiled_notice", toolName: tool.name }));
    const r = await callLLM(buildToolPrompt(tool, offerMsg.taskText), "quick", creds);
    out.push(msg({ role: "assistant", kind: "text", text: r.text, viaTool: tool.name, latency: r.latencyMs }));
    await recordLog({ type: "hit", toolId: tool.id, toolName: tool.name, latencyMs: r.latencyMs });
    bumpTool(tool, r.latencyMs);
    return out;
  }

  throw Object.assign(new Error("Unknown action."), { code: "bad_request" });
}

export { processTask, resolveOffer, msg, MATCH_THRESHOLD, CLUSTER_THRESHOLD, CLUSTER_SIZE };
