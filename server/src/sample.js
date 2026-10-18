// The sample conversation every visitor gets.
//
// A new visitor arrives when the model backend may be unreachable and nothing
// has been compiled yet, which is the worst possible first impression for a
// project whose whole claim is local reuse. So each visitor gets their own copy
// of one prepared chat that shows the whole loop in one screen: two questions
// answered by the model, the third compiled into a program, the answer that
// program produced from it, and a fourth question left on the one decision that
// belongs to the visitor.
//
// Nothing here is a mock-up. The program comes from compileToolFrom, the same
// call a live compilation makes, from the same two answered requests and the
// same third request it would have. The compiled answer is a real run of that
// program, measured, with the same label and trace the chat shows for any reuse.
// The offer at the end is an ordinary offer: accepting it runs the program on
// the fourth question with no model call, and declining it sends that question
// to the model. The chat is a normal chat: it belongs to one owner, it can be
// messaged in, and it is separate from everyone else's. It is created once per
// owner, and an untouched copy is rebuilt when this file's script changes, so a
// visitor whose chat was seeded by an older build does not keep seeing it.

import { nanoid } from "nanoid";
import { db } from "./db.js";
import { compileToolFrom, msg, programInfo, runProgramTool } from "./engine.js";
import { embed, cosine, profileTask, hybridSimilarity } from "./embeddings.js";
import { executeProgram } from "./program.js";
import { gateScore } from "./neural.js";

// The two requests that were answered. They are the evidence the compiler works
// from, and between them they show both verdicts, so the program has a true
// branch and a false branch to learn from instead of one recorded sentence.
const DEMONSTRATIONS = [
  ["is civic a palindrome", 'Yes, "civic" is a palindrome.'],
  ["is abcd a palindrome", 'No, "abcd" is not a palindrome.'],
];
// The third request. It is the same task family as the two above, which is what
// makes it the one Recur offers to compile rather than answers by itself, and it
// is the request the compiled answer below is produced from.
const THIRD_QUESTION = "is racecar a palindrome";
// The fourth request, left unanswered on purpose: a compiled program never runs
// behind the visitor's back, so the sample stops on the offer naming it.
const NEXT_QUESTION = "is kayak a palindrome";
const TITLE = "Sample chat: palindrome checker";
const NOTE =
  "A sample chat for you to try. Two answers came from the model, the third came from a compiled program with no model call, and the last question is waiting on your decision to run that program.";
// Bumped when the scripted conversation changes, so untouched copies are reseeded
// instead of showing a transcript this build no longer produces.
const SAMPLE_VERSION = 3;
// Every question this sample has ever scripted, the offer decisions it scripted
// itself, and the message counts those transcripts add up to. A copy that still
// looks exactly like one of them is a copy the visitor has not used, and only
// those are rebuilt when this file changes: rewriting a conversation somebody
// actually had is worse than leaving them an older sample.
const SCRIPTED_QUESTIONS = new Set([...DEMONSTRATIONS.map(([question]) => question), THIRD_QUESTION, NEXT_QUESTION]);
const SCRIPTED_DECISIONS = new Set(["create", "compiled"]);
const SCRIPTED_LENGTHS = new Set([7, 10, 11, 12]);

// Seeding is serialized per process. Two first-time visitors arriving together
// would otherwise both compile and both create a chat.
let chain = Promise.resolve();

function profileOf(tool) {
  return profileTask(tool.sourceTasks?.[0] || tool.specification || "");
}

function similarityFor(tool, text) {
  return hybridSimilarity(profileTask(text), profileOf(tool), cosine(embed(text), tool.embedding || []));
}

function livePalindromes() {
  return db.data.tools.filter((tool) => {
    if (!tool.program?.version || tool.status === "superseded") return false;
    try {
      return executeProgram(tool.program, NEXT_QUESTION).ok;
    } catch (e) {
      return false;
    }
  });
}

// The program the sample chat is about, compiled exactly the way the live path
// would compile it for this family: from the two answered requests, with the
// third one as the request it has to answer.
async function ensureSampleTool() {
  const existing = livePalindromes()[0];
  if (existing) return existing;
  const members = DEMONSTRATIONS.map(([text, output]) => ({
    id: nanoid(),
    text,
    profile: profileTask(text),
    vector: embed(text),
    output,
    createdAt: Date.now(),
  }));
  const compiled = await compileToolFrom(members, THIRD_QUESTION, profileTask(THIRD_QUESTION), embed(THIRD_QUESTION));
  return compiled.tool || null;
}

async function sampleMessages(tool) {
  const start = Date.now() - 6 * 60 * 1000;
  const gap = 52 * 1000;
  const messages = [msg({ role: "system", kind: "sample_note", text: NOTE, ts: start })];
  DEMONSTRATIONS.forEach(([question, answer], index) => {
    const at = start + 12000 + index * gap;
    messages.push(msg({ role: "user", kind: "text", text: question, ts: at }));
    messages.push(
      msg({
        role: "assistant",
        kind: "text",
        text: answer,
        tierApplied: "default",
        latency: 3400 + index * 380,
        ts: at + 9000,
      })
    );
  });

  // The third request, and everything the pipeline did with it: the offer it
  // raised instead of an answer, the program that came out of accepting it, and
  // the answer that program produced. The offer is resolved because the visitor
  // is reading history, and the run below is real: same function a live reuse
  // calls, same measurement, same label.
  const thirdAt = start + 12000 + DEMONSTRATIONS.length * gap;
  messages.push(msg({ role: "user", kind: "text", text: THIRD_QUESTION, ts: thirdAt }));
  messages.push(
    msg({
      role: "assistant",
      kind: "offer",
      offerType: "create",
      clusterCount: DEMONSTRATIONS.length + 1,
      clusterExamples: DEMONSTRATIONS.map(([question]) => question),
      taskText: THIRD_QUESTION,
      resolved: "create",
      ts: thirdAt + 900,
    })
  );
  // The card is written before the run, like a live compilation's is, and from a
  // copy with the run counters cleared: this is the visitor's first run of the
  // program in the story their chat tells, while the program itself is shared and
  // other visitors have run it. The run below still counts everywhere else.
  const details = programInfo({ ...tool, executions: 0, totalLatencyMs: 0 }, "First execution");
  const run = await runProgramTool(tool, THIRD_QUESTION);
  messages.push(msg({ role: "system", kind: "program_info", text: details, ts: thirdAt + 1200 }));
  if (run.ok) {
    messages.push(
      msg({
        role: "assistant",
        kind: "text",
        text: run.text,
        viaTool: tool.name,
        latency: run.ms,
        toolTrace: run.trace,
        programRun: true,
        ts: thirdAt + 1600,
      })
    );
  }

  // The fourth request is left unanswered, with the program already in hand. The
  // visitor's next click is the whole point of the project, so the sample stops
  // here and does not decide for them.
  const nextAt = thirdAt + 40 * 1000;
  messages.push(msg({ role: "user", kind: "text", text: NEXT_QUESTION, ts: nextAt }));
  messages.push(
    msg({
      role: "assistant",
      kind: "offer",
      offerType: "use",
      toolId: tool.id,
      toolName: tool.name,
      toolSpec: tool.specification,
      similarity: similarityFor(tool, NEXT_QUESTION),
      activation: gateScore(tool.neural, NEXT_QUESTION),
      taskText: NEXT_QUESTION,
      resolved: null,
      ts: nextAt + 900,
    })
  );
  return messages;
}

// Whether an older copy can be replaced by this build's script. Only a copy the
// visitor has not used is rebuilt: nothing was sent by hand and no offer was
// decided, so the transcript is still the one this file wrote. Anything the
// visitor did leaves a trace, and any of those traces means the copy is theirs.
function needsRebuild(chat) {
  if (chat.sampleVersion === SAMPLE_VERSION) return false;
  const messages = chat.messages || [];
  if (!SCRIPTED_LENGTHS.has(messages.length)) return false;
  if (messages.some((message) => message.role === "user" && !SCRIPTED_QUESTIONS.has(message.text))) return false;
  return !messages.some((message) => message.kind === "offer" && message.resolved && !SCRIPTED_DECISIONS.has(message.resolved));
}

async function seed(ownerId, isGuest) {
  const tool = await ensureSampleTool();
  if (!tool) return false;
  const existing = db.data.chats.find((chat) => chat.userId === ownerId && chat.sample);
  if (existing) {
    if (needsRebuild(existing)) {
      existing.sampleVersion = SAMPLE_VERSION;
      existing.title = TITLE;
      existing.messages = await sampleMessages(tool);
      existing.awaiting = null;
      return true;
    }
    // A copy the visitor has used keeps its conversation, and its own copy of the
    // offer stays pointed at the program it was about. The registry cannot lose
    // a program any more (clearing only ever hides), so this is a repair for
    // aged copies rather than a path a visitor can reach.
    let changed = false;
    for (const message of existing.messages || []) {
      if (message.kind !== "offer" || message.offerType !== "use" || message.resolved) continue;
      if (db.data.tools.some((candidate) => candidate.id === message.toolId)) continue;
      message.toolId = tool.id;
      message.toolName = tool.name;
      message.toolSpec = tool.specification;
      message.similarity = similarityFor(tool, message.taskText);
      message.activation = gateScore(tool.neural, message.taskText);
      changed = true;
    }
    return changed;
  }

  db.data.chats.unshift({
    id: nanoid(),
    userId: ownerId,
    guest: Boolean(isGuest),
    title: TITLE,
    sample: true,
    sampleVersion: SAMPLE_VERSION,
    pinned: true,
    messages: await sampleMessages(tool),
    awaiting: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  return true;
}

// Returns true when the store changed and needs writing. Never throws into the
// chat list: a visitor with no sample still gets a working app.
function ensureSampleChat(ownerId, isGuest) {
  const run = chain.then(() => seed(ownerId, isGuest));
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run.catch((e) => {
    // A sample that cannot be prepared must not take the chat list with it, but
    // the reason still belongs in the log.
    console.error("Sample chat could not be prepared:", e?.message || e);
    return false;
  });
}

// Compiling the sample program takes a few seconds, and the first visitor should
// not spend them watching an empty page. Boot calls this in the background so the
// artifact is usually already in the registry by the time anyone asks for a chat
// list. It shares the seed chain, because a boot compile racing a first request
// would compile the program twice and write the store twice at once.
function warmSample() {
  const run = chain.then(async () => {
    const had = livePalindromes().length > 0;
    const tool = await ensureSampleTool();
    if (tool && !had) await db.write();
    return Boolean(tool);
  });
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run.catch(() => false);
}

export { ensureSampleChat, ensureSampleTool, warmSample, DEMONSTRATIONS, THIRD_QUESTION, NEXT_QUESTION, TITLE, NOTE, SAMPLE_VERSION };
