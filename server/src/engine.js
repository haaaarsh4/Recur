import { nanoid } from "nanoid";
import { db, registryDescription } from "./db.js";
import { embed, cosine, centroid, profileTask, hybridSimilarity } from "./embeddings.js";
import { callLLM, callLLMJson } from "./llm.js";

const MATCH_THRESHOLD = 0.78;
const CLUSTER_THRESHOLD = 0.78;
const CLUSTER_SIZE = 3;
const DATASET_TARGET = Math.max(500, Math.min(10000, Number(process.env.PROGRAM_DATASET_SIZE || 2000)));

function msg(fields) {
  return { id: nanoid(), ts: Date.now(), ...fields };
}

function usableProfile(item) {
  // Recompute the profile from the original request when it is available. This
  // lets improved normalization repair old pending observations and legacy
  // tools instead of trusting a stale profile saved by an earlier matcher.
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

function isReusableTool(tool) {
  const name = String(tool?.name || "").toLowerCase();
  return Boolean(name && !/(?:kebab-case-name|semantic-kebab-name|placeholder)/.test(name));
}

function bestMatch(profile, vec) {
  let best = null;
  let bestSim = 0;
  for (const tool of db.data.tools) {
    if (!isReusableTool(tool)) continue;
    const sim = taskSimilarity(profile, vec, tool);
    if (sim > bestSim) {
      bestSim = sim;
      best = tool;
    }
  }
  return { best, bestSim };
}

function clusterFor(profile, vec) {
  // Every successful observation counts, including repeated identical requests.
  // Frequency is evidence that a task is worth compiling; deduplicating here
  // was the reason the same question could be asked forever without reaching
  // the compilation threshold.
  return db.data.pending.filter((pending) => taskSimilarity(profile, vec, pending) >= CLUSTER_THRESHOLD);
}

function uniqueExamples(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = String(item.text || "").toLowerCase().replace(/\s+/g, " ").trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function rememberPending(text, profile, vector, output = null) {
  if (!profile.meaningful) return;
  db.data.pending.push({ id: nanoid(), text, profile, vector, output: output ? String(output).slice(0, 1200) : null, createdAt: Date.now() });
}

function buildGeneralPrompt(text) {
  return `Answer the request directly and concisely. Verify simple facts, arithmetic, spelling, and string properties yourself before answering. Never agree with a false premise. Use at most 3 short sentences unless the user explicitly asks for detail. If examples are requested, give only the requested examples with a one-line explanation. No preamble and no meta commentary.\n\nRequest: ${text}`;
}

function identityReply(tier) {
  if (tier === "quick") return "I am Recur Quick, the fast Recur mode powered by the lightweight model for quick everyday questions. I can answer requests and help detect repeated patterns for reusable tools.";
  if (tier === "complex") return "I am Recur Complex, the deepest Recur mode for harder reasoning. I use the strongest model in your local setup while keeping Recur's reusable-tool workflow.";
  return "I am Recur, the balanced Recur mode for normal questions. You can think of this as the basic or standard Recur model. I answer requests, notice repeated patterns, and help turn repeated work into reusable tools.";
}

function buildToolPrompt(tool, text) {
  const examples = tool.examples?.length ? "\nVerified examples:\n" + tool.examples.map((e) => `input=${e.input}\noutput=${e.output}`).join("\n") : "";
  return `Task: ${tool.specification}${examples}\n\nInput: ${text}\n\nReturn only the correct answer for the input. Do not repeat the task, input, examples, or instructions.`;
}

function looksLikePromptEcho(text) {
  return /(?:apply the contract|new request:|you are executing|verified behavior examples|do not mention this prompt)/i.test(String(text || ""));
}

async function runTool(tool, text, creds = null) {
  let result = await callLLM(buildToolPrompt(tool, text), "default", creds);
  // Small local models sometimes copy the execution prompt. Never expose that
  // internal prompt to the user; retry with the normal answer contract.
  if (looksLikePromptEcho(result.text)) result = await callLLM(buildGeneralPrompt(text), "default", creds);
  return result;
}

function programInfo(tool) {
  const dataset = tool.dataset || {};
  const split = dataset.split || {};
  const sourceCount = tool.sourceTasks?.length || 0;
  const pending = dataset.status === "background synthesis queued";
  return [
    `Program: ${tool.name}`,
    `Task: ${tool.specification}`,
    `Runtime: ${tool.runtime || "contract-guided model program"}`,
    pending
      ? `Dataset synthesis: queued from ${dataset.seed || 0} verified user observations toward an initial ${dataset.generationTarget || "unknown"}-example dataset and full ${dataset.target || "unknown"}-example target.`
      : `Dataset: ${dataset.total || 0} examples (${dataset.seed || 0} user observations + ${dataset.generated || 0} teacher-generated candidates).`,
    pending ? "Splits: pending until background dataset synthesis completes." : `Splits: train ${split.train || 0} · validation ${split.validation || 0} · test ${split.test || 0}.`,
    `Dataset status: ${dataset.status || "not generated"} (initial target ${dataset.generationTarget || "unknown"}; full target ${dataset.target || "unknown"}).`,
    `Source requests: ${sourceCount}.`,
    `Training: ${tool.trainingStatus || "not run; no separate neural weights are trained by this Node prototype"}.`,
    `Accuracy: ${tool.accuracy == null ? "not measured; a test set exists only after an actual trained runtime evaluates it" : `${tool.accuracy}%`}.`,
    "Status: saved and available for future matching requests.",
  ].join("\n");
}

function buildCompilePrompt(samples) {
  return `You are compiling a reusable neural program from verified demonstrations. Infer only the common computation shared by these demonstrations; do not solve a different or broader task.\n\nVerified demonstrations:\n${samples.map((s, i) => `${i + 1}. INPUT: ${s.input}\n   VERIFIED OUTPUT: ${s.output || "(not available; infer the task, but do not invent an output example)"}`).join("\n")}\n\nReturn ONLY JSON with this shape:\n{"name":"semantic-kebab-name","specification":"one precise sentence describing the input, computation, and output"}\n\nRules: name must be a meaningful 2-to-4-word kebab-case name, never a schema placeholder; specification must be narrow and executable; never claim the program performs a task that is not evidenced. Do not return examples.`;
}

function buildDatasetPrompt(specification, seedSamples, count) {
  return `Create ${count} diverse candidate demonstrations for this task specification:\n${specification}\n\nExisting verified observations:\n${seedSamples.map((sample) => `input=${sample.input}\noutput=${sample.output}`).join("\n")}\n\nReturn ONLY JSON in this shape: {"examples":[{"input":"...","output":"..."}]}\nGenerate realistic, varied, edge-case inputs and the exact expected outputs. Do not include explanations, task descriptions, or instructions. These are teacher-labelled candidates and will be validated before any training.`;
}

function buildClarifyPrompt(taskText, context) {
  return `A user sent this request: "${taskText}"\n\nContext: ${context}\n\nAsk ONE short, natural clarifying question that would help decide how to handle it. Reply with only the question, nothing else.`;
}

function sanitizeName(name) {
  if (!name || typeof name !== "string") return null;
  const normalized = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  if (!normalized || /^(?:kebab-case-name-2-to-4-words|semantic-kebab-name|placeholder|example-name)$/.test(normalized)) return null;
  return normalized;
}

async function recordLog(entry) {
  db.data.log.push({ id: nanoid(), ts: Date.now(), ...entry });
}

function bumpTool(tool, latency) {
  tool.executions = (tool.executions || 0) + 1;
  tool.totalLatencyMs = (tool.totalLatencyMs || 0) + latency;
}

function verifiedSamples(items) {
  const groups = new Map();
  for (const item of items) {
    if (!item.output) continue;
    const key = String(item.text).toLowerCase().replace(/\s+/g, " ").trim();
    const outputs = groups.get(key) || new Set();
    outputs.add(String(item.output).trim());
    groups.set(key, outputs);
  }
  const conflicting = new Set([...groups].filter(([, outputs]) => outputs.size > 1).map(([key]) => key));
  return items
    .filter((item) => item.output && !conflicting.has(String(item.text).toLowerCase().replace(/\s+/g, " ").trim()))
    .map((item) => ({ input: item.text, output: item.output }));
}

function safeSpecification(specification, profile) {
  const value = String(specification || "").replace(/\s+/g, " ").trim();
  if (!value || looksLikePromptEcho(value)) return `Performs the recurring ${profile.operation} task described by the verified examples.`;
  return value.slice(0, 500);
}

function cleanDatasetExamples(examples) {
  const byInput = new Map();
  for (const item of Array.isArray(examples) ? examples : []) {
    const input = String(item?.input || "").trim().slice(0, 500);
    const output = String(item?.output || "").trim().slice(0, 500);
    if (!input || !output || looksLikePromptEcho(input) || looksLikePromptEcho(output)) continue;
    const key = input.toLowerCase().replace(/\s+/g, " ");
    const existing = byInput.get(key);
    if (existing && existing.output !== output) {
      byInput.delete(key);
      continue;
    }
    if (!existing) byInput.set(key, { input, output });
  }
  return [...byInput.values()];
}

function datasetMetadata(all, seedCount, status = "background synthesis queued") {
  const trainCount = Math.floor(all.length * 0.7);
  const validationCount = Math.floor(all.length * 0.15);
  return {
    seed: seedCount,
    generated: Math.max(0, all.length - seedCount),
    total: all.length,
    target: DATASET_TARGET,
    generationTarget: Math.min(DATASET_TARGET, Math.max(seedCount + 96, 256)),
    split: {
      train: trainCount,
      validation: validationCount,
      test: Math.max(0, all.length - trainCount - validationCount),
    },
    status,
    sample: all.slice(0, 12),
  };
}

async function generateDataset(specification, seedSamples, creds = null, onProgress = null) {
  const seed = cleanDatasetExamples(seedSamples);
  const generationTarget = Math.min(DATASET_TARGET, Math.max(seed.length + 96, 256));
  let all = [...seed];
  let attempts = 0;
  while (all.length < generationTarget && attempts < 10) {
    attempts += 1;
    const remaining = generationTarget - all.length;
    const batchCount = Math.min(4, Math.ceil(remaining / 24));
    const requests = Array.from({ length: batchCount }, () =>
      callLLMJson(buildDatasetPrompt(specification, all, Math.min(remaining, 24)), "default", creds)
    );
    const results = await Promise.allSettled(requests);
    const next = results.flatMap((result) => result.status === "fulfilled" ? result.value.data?.examples || [] : []);
    const previousLength = all.length;
    all = cleanDatasetExamples([...all, ...next]);
    if (all.length === previousLength) break;
    onProgress?.(datasetMetadata(all, seed.length, "background synthesis running"));
  }
  const status = all.length >= generationTarget ? "initial dataset target met; full target may continue in background" : "background synthesis incomplete; only valid examples retained";
  return datasetMetadata(all, seed.length, status);
}

async function compileToolFrom(members, currentText, currentProfile, currentVec, creds = null) {
  const samples = verifiedSamples(members);
  const compileSamples = [...samples, { input: currentText, output: null }];
  const { data } = await callLLMJson(buildCompilePrompt(compileSamples), "default", creds);
  const texts = [...members.map((m) => m.text), currentText];
  const vecs = [...members.map((m) => m.vector), currentVec];
  const specification = safeSpecification(data.specification, currentProfile);
  const dataset = datasetMetadata(samples, samples.length);
  const tool = {
    id: nanoid(),
    name: sanitizeName(data.name) || `${currentProfile.domain}-${currentProfile.operation}`,
    specification,
    description: registryDescription({ specification, examples: samples, sourceTasks: texts }, currentProfile),
    // Runtime prompting uses only observed examples. Synthetic candidates are
    // recorded as dataset metadata until a real trainer validates them.
    examples: samples.slice(0, 6).map((e) => ({ input: String(e.input).slice(0, 300), output: String(e.output).slice(0, 300) })),
    dataset,
    sourceTasks: texts.slice(0, 6),
    profile: currentProfile,
    runtime: "contract-guided model program",
    trainingStatus: "teacher dataset synthesis queued in background; separate neural-weight training not run in this Node build",
    accuracy: null,
    embedding: centroid(vecs),
    createdAt: Date.now(),
    executions: 0,
    totalLatencyMs: 0,
  };
  db.data.tools.unshift(tool);
  // Do not block the chat response while generating the larger teacher dataset.
  generateDataset(specification, samples, creds, (progress) => {
    Object.assign(tool, { dataset: progress });
    db.write().catch(() => {});
  }).then((finalDataset) => {
    Object.assign(tool, { dataset: finalDataset });
    db.write().catch(() => {});
  }).catch(() => {});
  const memberIds = new Set(members.map((m) => m.id));
  db.data.pending = db.data.pending.filter((p) => !memberIds.has(p.id));
  return tool;
}

async function processTask(chat, text, tier, creds = null) {
  const profile = profileTask(text);
  const vec = embed(text);
  const { best, bestSim } = bestMatch(profile, vec);

  // A compiled tool always gets first refusal. Even deterministic or simple
  // requests must explicitly offer the existing tool instead of creating a
  // second tool for the same task family.
  if (best && bestSim >= MATCH_THRESHOLD) {
    return [msg({ role: "assistant", kind: "offer", offerType: "use", toolId: best.id, toolName: best.name, toolSpec: best.specification, similarity: bestSim, taskText: text, resolved: null })];
  }

  const asksIdentity = /\b(what|who)\s+(are|is)\s+(you|recur|this chatbot|this assistant)\b/i.test(text) || /\bwhat does recur do\b/i.test(text) || /\b(what|which)\s+(model|version|tier)\b/i.test(text) || /\bwhat (model|version) are you (using|running)\b/i.test(text) || /\bwhich model (are you|do you)\b/i.test(text);
  if (asksIdentity) return [msg({ role: "assistant", kind: "text", text: identityReply(tier), tierApplied: tier, latency: 0 })];

  const cluster = clusterFor(profile, vec);
  if (cluster.length >= CLUSTER_SIZE - 1) {      return [msg({ role: "assistant", kind: "offer", offerType: "create", clusterCount: cluster.length + 1, clusterExamples: uniqueExamples(cluster).slice(0, 4).map((c) => c.text), clusterMemberIds: cluster.map((c) => c.id), taskText: text, resolved: null })];
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
    const ctx = offerMsg.offerType === "use" ? `I have an existing tool for: "${offerMsg.toolSpec}". Check whether this task really fits.` : "I'm deciding whether to compile a reusable tool from a few strongly similar requests.";
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
    const r = await runTool(tool, offerMsg.taskText, creds);
    out.push(msg({ role: "assistant", kind: "text", text: r.text, viaTool: tool.name, latency: r.latencyMs }));
    await recordLog({ type: "hit", toolId: tool.id, toolName: tool.name, latencyMs: r.latencyMs });
    bumpTool(tool, r.latencyMs);
    return out;
  }
  if (action === "create") {
    offerMsg.resolved = "create";
    const members = db.data.pending.filter((p) => offerMsg.clusterMemberIds.includes(p.id));
    const currentProfile = profileTask(offerMsg.taskText);
    const vec = embed(offerMsg.taskText);
    const existing = db.data.tools.find((candidate) => isReusableTool(candidate) && (taskSimilarity(currentProfile, vec, candidate) >= MATCH_THRESHOLD || usableProfile(candidate)?.fingerprint === currentProfile.fingerprint));
    if (existing) {
      offerMsg.resolved = "existing";
      const r = await runTool(existing, offerMsg.taskText, creds);
      out.push(msg({ role: "assistant", kind: "text", text: r.text, viaTool: existing.name, latency: r.latencyMs }));
      bumpTool(existing, r.latencyMs);
      await recordLog({ type: "hit", toolId: existing.id, toolName: existing.name, latencyMs: r.latencyMs });
      return out;
    }
    const tool = await compileToolFrom(members, offerMsg.taskText, currentProfile, vec, creds);
    // Compilation deliberately emits exactly one explanatory message. The
    // following assistant message is reserved for the original answer.
    out.push(msg({ role: "system", kind: "program_info", text: programInfo(tool), toolName: tool.name }));
    const r = await runTool(tool, offerMsg.taskText, creds);
    out.push(msg({ role: "assistant", kind: "text", text: r.text, viaTool: tool.name, latency: r.latencyMs }));
    await recordLog({ type: "hit", toolId: tool.id, toolName: tool.name, latencyMs: r.latencyMs });
    bumpTool(tool, r.latencyMs);
    return out;
  }
  throw Object.assign(new Error("Unknown action."), { code: "bad_request" });
}

export { processTask, resolveOffer, msg, MATCH_THRESHOLD, CLUSTER_THRESHOLD, CLUSTER_SIZE };
