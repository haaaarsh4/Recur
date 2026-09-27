// Recur's task pipeline.
//
// Two paths exist and they are deliberately different:
//
//   general  : the model answers. Used for one-off requests and for the first
//              few repeats while the learner is still collecting evidence.
//   compiled : a program synthesized from verified demonstrations is executed
//              locally. No model call happens on this path, not while compiling
//              and not while reusing. This is the whole point of the project.
//
// Compiling writes an executable artifact (see program.js) plus a small
// acceptance head trained locally (see neural.js). Reusing runs that artifact.

import { nanoid } from "nanoid";
import { db, registryDescription } from "./db.js";
import { embed, cosine, centroid, profileTask, hybridSimilarity } from "./embeddings.js";
import { callLLM } from "./llm.js";
import {
  COMPILER_VERSION,
  RUNTIME,
  compileProgram,
  executeProgram,
  gradeProgram,
  leaveOneOut,
  stressTest,
  sampleProgramInputs,
  nameProgram,
  sanitizeName,
  specificationFor,
  programListing,
  programSummary,
  uncoveredBranches,
  derivedBranches,
} from "./program.js";
import { trainAcceptanceGate, gateScore } from "./neural.js";

const MATCH_THRESHOLD = 0.78;
// How close a request has to be to a compiled program before that program is put
// in front of the user as an offer even when the acceptance head is unsure. Two
// thresholds, two jobs: similarity says the request is about the same task, and
// the head says it is inside the input distribution the program was compiled
// from. Either one is enough to offer. Nothing is ever run on a match alone:
// reuse is offered, and the program runs when the user picks it.
const STRONG_MATCH_THRESHOLD = 0.84;
const CLUSTER_THRESHOLD = 0.78;
const CLUSTER_SIZE = 3;
// Repetition is local and recent, so the buffer never needs to be large. An
// unbounded one would also make every request rescan the whole history.
const MAX_PENDING = 200;
// The head can stop a program being offered on its own; it can never stop one the
// user explicitly asked for.
const GATE_MIN = 0.35;
const GATE_SAMPLE_POSITIVES = 12;

const DISTRACTORS = [
  "what is the capital of france",
  "explain how photosynthesis works",
  "write a short poem about the ocean",
  "summarize this article in three bullets",
  "debug this python function for me",
  "what is the weather like tomorrow",
  "translate this sentence into spanish",
  "give me ideas for a birthday present",
  "what time is it in tokyo right now",
  "review my resume and suggest improvements",
  "what is the difference between http and https",
  "plan a three day trip to rome",
];

function msg(fields) {
  return { id: nanoid(), ts: Date.now(), ...fields };
}

function normalizeKey(text) {
  return String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// matching
// ---------------------------------------------------------------------------

function usableProfile(item) {
  // Recompute the profile from the original request when it is available. This
  // lets improved normalization repair old pending observations instead of
  // trusting a stale profile saved by an earlier matcher.
  const source = item?.text || item?.sourceTasks?.[0];
  if (source) {
    const recovered = profileTask(source);
    if (recovered.meaningful) return recovered;
  }
  if (item?.profile?.meaningful) return item.profile;
  const recovered = profileTask(item?.specification || "");
  return recovered.meaningful ? recovered : null;
}

function taskSimilarity(profile, vector, item) {
  const other = usableProfile(item);
  if (!other) return 0;
  return hybridSimilarity(profile, other, cosine(vector, item.vector || item.embedding));
}

// A tool only counts once it holds an executable program. Legacy contracts from
// the earlier compiler are listed in the registry but can never be reused, and a
// program that a later compilation replaced is read-only history.
function isReusableTool(tool) {
  const name = String(tool?.name || "").toLowerCase();
  if (!name || /(?:kebab-case-name|semantic-kebab-name|placeholder)/.test(name)) return false;
  if (tool?.status === "superseded") return false;
  return Boolean(tool?.program && tool.program.version && tool.program.read && tool.program.emit);
}

// Every reusable program that is close enough to this request, strongest match
// first. Reuse considers all of them, because one program that cannot read the
// request must never hide another program that can.
function matchCandidates(profile, vec) {
  return db.data.tools
    .filter(isReusableTool)
    .map((tool) => ({ tool, sim: taskSimilarity(profile, vec, tool) }))
    .filter((candidate) => candidate.sim >= MATCH_THRESHOLD)
    .sort((a, b) => b.sim - a.sim);
}

function clusterFor(profile, vec) {
  // Every successful observation counts, including repeated identical requests.
  // Frequency is evidence that a task is worth compiling.
  return db.data.pending.filter((pending) => taskSimilarity(profile, vec, pending) >= CLUSTER_THRESHOLD);
}

function uniqueExamples(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = normalizeKey(item.text);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function rememberPending(text, profile, vector, output = null) {
  if (!profile.meaningful) return;
  db.data.pending.push({
    id: nanoid(),
    text,
    profile,
    vector,
    output: output ? String(output).slice(0, 1200) : null,
    createdAt: Date.now(),
  });
  if (db.data.pending.length > MAX_PENDING) db.data.pending = db.data.pending.slice(-MAX_PENDING);
}

// A program that could not read the request is worth naming when the family is
// otherwise about to be compiled again: the user asked something the registry
// already appears to cover, and the reason it went to the model is specific.
function closedNote(candidate) {
  return `The registered program ${candidate.tool.name} was compiled only from the inputs it was verified on, so it could not read this wording`;
}

// ---------------------------------------------------------------------------
// prompts: only for the general path and for asking a clarifying question.
// Nothing here is ever used to produce a compiled program's answer.
// ---------------------------------------------------------------------------

function buildGeneralPrompt(text) {
  return `Answer the request directly and concisely. Verify simple facts, arithmetic, spelling, and string properties yourself before answering. Never agree with a false premise. Use at most 3 short sentences unless the user explicitly asks for detail. If examples are requested, give only the requested examples with a one-line explanation. No preamble and no meta commentary.\n\nRequest: ${text}`;
}

function buildClarifyPrompt(taskText, context) {
  return `A user sent this request: "${taskText}"\n\nContext: ${context}\n\nAsk ONE short, natural clarifying question that would help decide how to handle it. Reply with only the question, nothing else.`;
}

function identityReply(tier) {
  if (tier === "quick") return "I am Recur Quick, the fast Recur mode powered by the lightweight model for quick everyday questions. I can answer requests and help detect repeated patterns for reusable tools.";
  if (tier === "complex") return "I am Recur Complex, the deepest Recur mode for harder reasoning. I use the strongest model in your local setup while keeping Recur's reusable-tool workflow.";
  return "I am Recur, the balanced Recur mode for normal questions. You can think of this as the basic or standard Recur model. I answer requests, notice repeated patterns, and help turn repeated work into reusable tools.";
}

// ---------------------------------------------------------------------------
// evidence: verified demonstration pairs, conflicts discarded first
// ---------------------------------------------------------------------------

// The rule the user asked for: an input that ever produced two different outputs
// is not evidence of anything, so it is removed before compiling.
function verifiedPairs(items) {
  const groups = new Map();
  for (const item of items) {
    if (!item?.output) continue;
    const key = normalizeKey(item.text);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, { input: item.text, outputs: new Map() });
    const output = String(item.output).trim();
    groups.get(key).outputs.set(output, (groups.get(key).outputs.get(output) || 0) + 1);
  }
  const pairs = [];
  const discarded = [];
  for (const group of groups.values()) {
    const outputs = [...group.outputs.keys()];
    if (outputs.length > 1) discarded.push({ input: group.input, outputs: outputs.slice(0, 3) });
    else pairs.push({ input: group.input, output: outputs[0] });
  }
  return { pairs, discarded };
}

function gateNegatives(members, profile) {
  const memberKeys = new Set(members.map((member) => normalizeKey(member.text)));
  const negatives = [...DISTRACTORS];
  for (const pending of db.data.pending) {
    if (memberKeys.has(normalizeKey(pending.text))) continue;
    negatives.push(pending.text);
  }
  for (const tool of db.data.tools) {
    for (const test of tool.tests || []) negatives.push(test.input);
  }
  return [...new Set(negatives.filter(Boolean))].slice(0, 40);
}

// ---------------------------------------------------------------------------
// compilation: synthesize a program, train the acceptance head, record evidence
// ---------------------------------------------------------------------------

function seedOf(text) {
  let hash = 2166136261;
  for (const ch of String(text)) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) >>> 0;
}

async function compileToolFrom(members, currentText, currentProfile, currentVec) {
  // One program per task family. An existing program only covers this family
  // when it can actually answer the request: a program that declines everything
  // must not block the family from being compiled properly later.
  const existing = db.data.tools.find((candidate) => isReusableTool(candidate)
    && taskSimilarity(currentProfile, currentVec, candidate) >= MATCH_THRESHOLD
    && executeProgram(candidate.program, currentText).ok);
  if (existing) {
    const memberIds = new Set(members.map((member) => member.id));
    db.data.pending = db.data.pending.filter((pending) => !memberIds.has(pending.id));
    return { tool: existing, existing: true, reason: "an existing program already covers this task family", discarded: [] };
  }
  const { pairs, discarded } = verifiedPairs(members);
  if (!pairs.length) {
    const reason = discarded.length
      ? "every observation in this cluster had conflicting answers, so there was nothing verified to compile from"
      : "this cluster has no recorded answers yet, so there is nothing verified to compile from";
    return { tool: null, reason, discarded };
  }
  const startedAt = Date.now();
  const compiled = compileProgram(pairs, currentProfile);
  if (!compiled.program) {
    return { tool: null, reason: compiled.reason, discarded, explored: compiled.explored || 0 };
  }
  const program = compiled.program;
  const grade = gradeProgram(program, pairs);
  const generalization = leaveOneOut(pairs, currentProfile);
  const stress = stressTest(program, seedOf(currentText));
  const neural = trainAcceptanceGate({
    positives: [...pairs.map((pair) => pair.input), ...sampleProgramInputs(program, GATE_SAMPLE_POSITIVES, seedOf(currentText))],
    negatives: gateNegatives(members, currentProfile),
    seed: seedOf(currentText + program.cost),
  });

  const vectors = [...members.map((member) => member.vector), currentVec].filter((vector) => Array.isArray(vector));
  const tool = {
    id: nanoid(),
    name: sanitizeName(nameProgram(program, currentProfile)),
    specification: specificationFor(program),
    runtime: RUNTIME,
    compiler: COMPILER_VERSION,
    status: "active",
    program,
    listing: programListing(program),
    summary: programSummary(program),
    tests: pairs.slice(0, 12),
    discarded: discarded.slice(0, 8),
    metrics: {
      demonstrations: pairs.length,
      reproduced: grade.reproduced,
      consistency: grade.consistency,
      coverage: program.coverage || { demonstrations: pairs.length, exact: grade.reproduced, variants: 0, explained: grade.reproduced },
      generalization,
      stress,
      compileMs: Date.now() - startedAt,
      candidatesExplored: compiled.explored || 0,
      modelCalls: 0,
    },
    neural,
    profile: currentProfile,
    embedding: centroid(vectors),
    sourceTasks: uniqueExamples(members).map((member) => member.text).slice(0, 6),
    createdAt: Date.now(),
    executions: 0,
    totalLatencyMs: 0,
    lastRun: null,
  };
  // A verified lookup that was compiled from replies the compiler now knows were
  // wrong must not stay in place to win future matches and decline them. It is
  // kept in the registry as history, marked as replaced.
  const superseded = db.data.tools.filter((candidate) => isReusableTool(candidate)
    && candidate.summary?.family === "table"
    && taskSimilarity(currentProfile, currentVec, candidate) >= MATCH_THRESHOLD
    && !executeProgram(candidate.program, currentText).ok);
  for (const stale of superseded) {
    stale.status = "superseded";
    stale.supersededBy = tool.name;
    stale.supersededReason = "a later compilation covers this task family with a program compiled from better evidence";
  }
  if (superseded.length) tool.supersedes = superseded.map((stale) => stale.name);
  tool.description = registryDescription(tool, currentProfile);
  db.data.tools.unshift(tool);
  const memberIds = new Set(members.map((member) => member.id));
  db.data.pending = db.data.pending.filter((pending) => !memberIds.has(pending.id));
  return { tool, discarded, grade, generalization, stress, explored: compiled.explored || 0, superseded: superseded.map((stale) => stale.name) };
}

// ---------------------------------------------------------------------------
// execution: deterministic, local, no model call
// ---------------------------------------------------------------------------

function accepts(tool, text) {
  return executeProgram(tool.program, text).ok;
}

async function runProgramTool(tool, text) {
  if (!isReusableTool(tool)) return { ok: false, reason: "this tool holds no executable program" };
  const run = executeProgram(tool.program, text);
  if (!run.ok) return { ok: false, reason: run.reason, trace: run.trace };
  bumpTool(tool, run.ms);
  tool.lastRun = { at: Date.now(), ms: run.ms, input: String(text).slice(0, 200), output: run.text.slice(0, 300) };
  await recordLog({ type: "program", toolId: tool.id, toolName: tool.name, latencyMs: run.ms });
  return { ok: true, text: run.text, ms: run.ms, trace: run.trace, path: run.path };
}

function bumpTool(tool, latency) {
  tool.executions = (tool.executions || 0) + 1;
  tool.totalLatencyMs = (tool.totalLatencyMs || 0) + latency;
}

async function recordLog(entry) {
  db.data.log.push({ id: nanoid(), ts: Date.now(), ...entry });
}

// Leave-one-out wording, in the honest direction: a fold that compiles a program
// which answers the held-out request does generalize, and saying so separately
// from the folds that also reproduced the recorded wording keeps a run of model
// errors from reading as a failure of the program.
// Locally executed programs finish in a fraction of a millisecond, so a rounded
// zero would read as "did not run".
function formatMs(value) {
  if (value == null || Number.isNaN(Number(value))) return "not measured";
  const ms = Number(value);
  return ms < 1 ? "<1ms" : `${Math.round(ms)}ms`;
}

function generalizationLine(summary) {
  const folds = summary?.folds ?? 0;
  const passed = summary?.passed ?? 0;
  const computed = summary?.computed ?? passed;
  if (summary?.note) return `${summary.note} (${folds} demonstration${folds === 1 ? "" : "s"} recorded)`;
  if (!folds) return "no folds, too few demonstrations";
  if (computed !== passed) {
    return `leave-one-out answered ${computed}/${folds} held-out requests, and reproduced the recorded wording in ${passed} of those`;
  }
  return `leave-one-out ${passed}/${folds} folds answered a held-out request with the recorded wording`;
}

function programInfo(tool, heading = "Program details") {
  const metrics = tool.metrics || {};
  const neural = tool.neural?.stats || null;
  const stress = metrics.stress || {};
  const coverage = metrics.coverage || {};
  const exact = coverage.exact ?? metrics.reproduced ?? 0;
  const demonstrations = metrics.demonstrations || 0;
  const lines = [
    `Program: ${tool.name}`,
    `Task: ${tool.specification}`,
    `Runtime: ${tool.runtime} (typed dataflow interpreter, executed locally at reuse, no model call)`,
    `Path: ${tool.summary?.path || programListing(tool.program).join(" → ")}`,
    `Compiled from: ${demonstrations} verified demonstration${demonstrations === 1 ? "" : "s"}, ${(tool.discarded || []).length} conflicting input${(tool.discarded || []).length === 1 ? "" : "s"} discarded before compilation, 0 model calls`,
    `Consistency: the program computes an answer for all ${demonstrations} demonstration${demonstrations === 1 ? "" : "s"}; ${exact} reproduced the recorded wording exactly${coverage.variants ? `, ${coverage.variants} said the same thing in different words` : ""}${coverage.faults ? `, ${coverage.faults} recorded ${coverage.faults === 1 ? "reply was" : "replies were"} set aside as a model error` : ""}`,
    coverage.faults
      ? `Wording source: ${[...new Set((tool.tests || []).map((test) => test.output))].length} recorded phrasings were seen; the sentence the program displays follows their shape, while the value comes from the computation`
      : `Wording source: ${[...new Set((tool.tests || []).map((test) => test.output))].length} distinct phrasings were seen; the program emits the phrasing supported by the most demonstrations`,
    `Generalization: ${generalizationLine(metrics.generalization)}; wording derived for ${derivedBranches(tool.program).length} unseen branch${derivedBranches(tool.program).length === 1 ? "" : "es"}`,
    `Acceptance head: ${neural ? `${tool.neural.hidden} hidden units, ${tool.neural.weights} stored weights, holdout accuracy ${Math.round((neural.holdoutAccuracy ?? 0) * 100)}% on ${neural.holdoutSize} examples` : "not trained"}`,
    `Search: ${metrics.candidatesExplored || 0} candidate programs explored in ${metrics.compileMs || 0}ms`,
    `Stress test: ${stress.cases || 0} generated in-domain inputs, ${stress.executed || 0} executed, ${stress.declined || 0} declined, ${stress.crashes || 0} exceptions, fully deterministic`,
  ];
  const outliers = coverage.outliers || [];
  if (coverage.authority) {
    lines.push(`Authority: these requests name a computation with one correct answer, so the program computes it. A recorded reply that disagreed with the computation cannot also be right, and is set aside as a model error instead of being imitated`);
  }
  if (outliers.length) {
    lines.push(`Evidence check: ${outliers.length} recorded repl${outliers.length === 1 ? "y" : "ies"} set aside`);
    for (const outlier of outliers.slice(0, 4)) {
      lines.push(`  - "${outlier.output}"${outlier.reason ? ` (${outlier.reason})` : ""}`);
    }
  }
  const disagreements = coverage.disagreements || [];
  if (disagreements.length && metrics.coverage?.closestPath) {
    lines.push(`Evidence check: the closest computation (${metrics.coverage.closestPath}) could not reproduce ${disagreements.length} recorded answer${disagreements.length === 1 ? "" : "s"}: ${disagreements.map((pair) => `"${pair.output}"`).join(", ")}. Two answers cannot both describe one computation, so this task is filed as a verified lookup instead`);
  }
  const missing = uncoveredBranches(tool.program);
  if (missing.length) lines.push(`Uncovered branches: ${missing.join(", ")} (the program declines instead of guessing)`);
  if (programSummary(tool.program).family === "table") {
    lines.push(coverage.singleDemonstration
      ? "Generalization note: this request was repeated with the same wording, and one demonstration cannot identify a computation, so the recorded reply is answered as a verified lookup and every other wording declines"
      : "Generalization note: this task has no rule that reproduces the demonstrations, so it was compiled as a verified lookup that answers observed inputs and declines the rest");
  }
  const runs = tool.executions || 0;
  const averageMs = runs ? (tool.totalLatencyMs || 0) / runs : null;
  lines.push(`${heading}: ${runs ? `${runs} local run${runs === 1 ? "" : "s"}, average ${formatMs(averageMs)}` : "this is the first local run"}; no model call`);
  return lines.join("\n");
}

function declineInfo(tool, reason) {
  return [
    `Program: ${tool.name}`,
    `Status: declined this request`,
    `Reason: ${reason}`,
    `Compiled path: ${tool.summary?.path || programListing(tool.program).join(" → ")}`,
    "Fallback: answered by the model instead, because the compiled program has no verified rule for this input",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// pipeline
// ---------------------------------------------------------------------------

async function processTask(chat, text, tier, creds = null) {
  const profile = profileTask(text);
  const vec = embed(text);
  // A compiled program is a match for this request only when it can actually
  // read it. A program that cannot must never stand in for one that can, and it
  // must never hide its task family from being compiled properly: the request
  // falls through to the repetition logic below, exactly like a fresh task, so
  // the family can still earn its offer.
  const candidates = matchCandidates(profile, vec);
  const matched = candidates.filter((candidate) => accepts(candidate.tool, text));
  const closed = candidates.find((candidate) => !matched.includes(candidate));

  if (matched.length) {
    // A compiled program never answers behind the user's back. The strongest
    // readable candidate becomes an offer that names the program and the task it
    // was compiled from, and the program runs only when the user picks it (or
    // answers "yes" to the offer). Reuse is always the user's decision.
    //
    // The acceptance head still decides something real: whether this request is
    // close enough to the family to be worth putting in front of them. A request
    // the head does not recognise, and that is not a strong match on similarity
    // either, is left to the normal pipeline instead of being handed a program
    // the head doubts. The head carries the boundary it learned at compile time;
    // GATE_MIN only applies to tools compiled before that boundary existed, and a
    // tool with no head attached is never blocked.
    const offered = matched.find(
      (candidate) => candidate.sim >= STRONG_MATCH_THRESHOLD || gateScore(candidate.tool.neural, text) >= (candidate.tool.neural?.threshold ?? GATE_MIN)
    );
    if (offered) {
      return [msg({
        role: "assistant",
        kind: "offer",
        offerType: "use",
        toolId: offered.tool.id,
        toolName: offered.tool.name,
        toolSpec: offered.tool.specification,
        similarity: offered.sim,
        activation: gateScore(offered.tool.neural, text),
        taskText: text,
        resolved: null,
      })];
    }
  }

  const asksIdentity = /\b(what|who)\s+(are|is)\s+(you|recur|this chatbot|this assistant)\b/i.test(text) || /\bwhat does recur do\b/i.test(text) || /\b(what|which)\s+(model|version|tier)\b/i.test(text) || /\bwhat (model|version) are you (using|running)\b/i.test(text) || /\bwhich model (are you|do you)\b/i.test(text);
  if (asksIdentity) return [msg({ role: "assistant", kind: "text", text: identityReply(tier), tierApplied: tier, latency: 0 })];

  const cluster = clusterFor(profile, vec);
  if (cluster.length >= CLUSTER_SIZE - 1) {
    return [msg({
      role: "assistant",
      kind: "offer",
      offerType: "create",
      clusterCount: cluster.length + 1,
      clusterExamples: uniqueExamples(cluster).slice(0, 4).map((item) => item.text),
      clusterMemberIds: cluster.map((item) => item.id),
      clusterNote: closed ? closedNote(closed) : null,
      taskText: text,
      resolved: null,
    })];
  }

  const r = await callLLM(buildGeneralPrompt(text), tier, creds);
  await recordLog({ type: "general", latencyMs: r.latencyMs });
  rememberPending(text, profile, vec, r.text);
  return [msg({ role: "assistant", kind: "text", text: r.text, tierApplied: tier, latency: r.latencyMs })];
}

async function resolveOffer(chat, offerMsg, action, tier, creds = null) {
  const out = [];
  if (action === "clarify") {
    offerMsg.resolved = "clarify";
    const ctx = offerMsg.offerType === "use" ? `I have an existing program for: "${offerMsg.toolSpec}". Check whether this task really fits.` : "I'm deciding whether to compile a reusable program from a few strongly similar requests.";
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
      db.data.pending = db.data.pending.filter((pending) => !ids.has(pending.id));
    }
    return out;
  }
  if (action === "use") {
    offerMsg.resolved = "use";
    const tool = db.data.tools.find((candidate) => candidate.id === offerMsg.toolId);
    if (!tool) throw Object.assign(new Error("That tool no longer exists."), { code: "not_found" });
    // The user asked for the compiled program, so the compiled program runs.
    // This path never calls a model to produce the answer.
    const run = await runProgramTool(tool, offerMsg.taskText);
    if (run.ok) {
      out.push(msg({ role: "assistant", kind: "text", text: run.text, viaTool: tool.name, latency: run.ms, toolTrace: run.trace, programRun: true }));
      return out;
    }
    out.push(msg({ role: "system", kind: "program_info", text: declineInfo(tool, run.reason) }));
  }
  if (action === "create") {
    offerMsg.resolved = "create";
    const members = db.data.pending.filter((pending) => (offerMsg.clusterMemberIds || []).includes(pending.id));
    const currentProfile = profileTask(offerMsg.taskText);
    const vec = embed(offerMsg.taskText);
    // Reuse a program for this family only when it can answer this request. A
    // program that declines it disagrees with the evidence the user just gave, so
    // it is not coverage and compilation below replaces it.
    const existing = matchCandidates(currentProfile, vec)
      .map((candidate) => candidate.tool)
      .concat(db.data.tools.filter((candidate) => isReusableTool(candidate) && usableProfile(candidate)?.fingerprint === currentProfile.fingerprint))
      .find((candidate) => accepts(candidate, offerMsg.taskText));
    let tool = existing || null;
    if (existing) {
      offerMsg.resolved = "existing";
      const memberIds = new Set(members.map((member) => member.id));
      db.data.pending = db.data.pending.filter((pending) => !memberIds.has(pending.id));
    } else {
      const compiled = await compileToolFrom(members, offerMsg.taskText, currentProfile, vec);
      if (!compiled.tool) {
        const discarded = compiled.discarded || [];
        out.push(msg({
          role: "system",
          kind: "program_info",
          text: [
            "Program: not compiled",
            `Reason: ${compiled.reason}`,
            `Evidence: ${(discarded.length ? `${discarded.length} conflicting input${discarded.length === 1 ? "" : "s"} discarded, ` : "")}${members.length} request${members.length === 1 ? "" : "s"} in this cluster`,
            "Fallback: this request is answered by the model instead, because no deterministic program fits the evidence",
          ].join("\n"),
        }));
      } else {
        tool = compiled.tool;
        out.push(msg({ role: "system", kind: "program_info", text: programInfo(tool, "First execution") }));
      }
    }
    if (tool) {
      const run = await runProgramTool(tool, offerMsg.taskText);
      if (run.ok) {
        out.push(msg({ role: "assistant", kind: "text", text: run.text, viaTool: tool.name, latency: run.ms, toolTrace: run.trace, programRun: true }));
        return out;
      }
      out.push(msg({ role: "system", kind: "program_info", text: declineInfo(tool, run.reason) }));
    }
  }
  if (action !== "create" && action !== "use") {
    throw Object.assign(new Error("Unknown action."), { code: "bad_request" });
  }
  // Only reached when a compiled program declined the request or compilation had
  // nothing to compile from. The request still needs an answer.
  const r = await callLLM(buildGeneralPrompt(offerMsg.taskText), tier, creds);
  await recordLog({ type: "general", latencyMs: r.latencyMs });
  out.push(msg({ role: "assistant", kind: "text", text: r.text, tierApplied: tier, latency: r.latencyMs }));
  return out;
}

export {
  processTask,
  resolveOffer,
  accepts,
  msg,
  programInfo,
  compileToolFrom,
  runProgramTool,
  verifiedPairs,
  MATCH_THRESHOLD,
  STRONG_MATCH_THRESHOLD,
  CLUSTER_THRESHOLD,
  CLUSTER_SIZE,
};
