// Task representations used by Recur's pattern learner.
// A vector is useful as a tie breaker, but it must never decide alone that two
// unrelated requests are the same reusable task.

const DIM = 256;

const STOP = new Set(
  ("a an the is are was were be been being this that these those to of in on for with and or but " +
    "if then so as at by from into it its it's i you your my our their his her do does did can could " +
    "should would will shall not no yes please just very really about me tell show give want need what which how whats"
  ).split(" ")
);

const TOKEN_ALIASES = new Map([
  ["what's", "what"],
  ["whats", "what"],
  ["elements", "ordinal-item"],
  ["element", "ordinal-item"],
  ["terms", "ordinal-item"],
  ["term", "ordinal-item"],
  ["values", "ordinal-item"],
  ["value", "ordinal-item"],
  ["items", "ordinal-item"],
  ["item", "ordinal-item"],
  ["numbers", "ordinal-item"],
  ["number", "ordinal-item"],
]);

// Families whose requests are the same computation with different values in
// them, so an exact profile agreement is already strong evidence.
const PARAMETRIC_INTENTS = new Set(["palindrome", "reverse", "arithmetic", "sequence-element"]);

// Operations the compiler can compute exactly. A request that names one of them
// is a real task even when the wording heuristics give it a generic label.
const DECIDABLE_OPERATIONS = new Set([
  "check-palindrome",
  "reverse-text",
  "calculate-expression",
  "lookup-sequence-element",
  "count-items",
  "classify",
]);

const GENERIC = new Set([
  "test", "testing", "hello", "hi", "hey", "ok", "okay", "thanks", "thank", "cool", "yes", "no",
  "asdf", "abc", "abcd", "foo", "bar", "lorem", "something", "anything", "help",
]);

const DOMAIN_WORDS = {
  math: new Set("add subtract multiply divide arithmetic calculate equation number numbers ordinal-item sum difference product quotient plus minus times percent percentage fibonacci sequence series progression".split(" ")),
  strings: new Set("palindrome palindrome reverse reversed reversing backwards backward flip invert string word words characters character text letters letter vowels vowel consonants consonant digits spelling anagram".split(" ")),
  programming: new Set("code coding program programming language cpp c++ python javascript typescript java rust go function class compiler bug error debug api algorithm".split(" ")),
  writing: new Set("write rewrite edit improve grammar summarize summary email essay paragraph document translate translation".split(" ")),
};

function tokenize(text) {
  return (String(text || "").toLowerCase().match(/[a-z0-9+#.']+/g) || [])
    .map((t) => t.replace(/^['.]+|['.]+$/g, ""))
    .map((t) => TOKEN_ALIASES.get(t) || t)
    // Single digits are content in arithmetic and sequence tasks ("what is 6
    // times 7"), so they are kept while one-letter words are noise.
    .filter((t) => (t.length > 1 || /[0-9]/.test(t)) && !STOP.has(t));
}

function hashToken(tok) {
  let h = 2166136261;
  for (let i = 0; i < tok.length; i++) {
    h ^= tok.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % DIM;
}

function embed(text) {
  const v = new Array(DIM).fill(0);
  const toks = tokenize(text);
  for (const t of toks) v[hashToken(t)] += 1;
  for (let i = 0; i < toks.length - 1; i++) v[hashToken(toks[i] + "_" + toks[i + 1])] += 0.75;
  let norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  return a.reduce((sum, value, i) => sum + value * (b[i] || 0), 0);
}

function centroid(vectors) {
  const valid = vectors.filter((v) => Array.isArray(v) && v.length === DIM);
  const v = new Array(DIM).fill(0);
  for (const vec of valid) for (let i = 0; i < DIM; i++) v[i] += vec[i];
  const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

function intersectionSize(a, b) {
  const right = new Set(b || []);
  return (a || []).filter((item) => right.has(item)).length;
}

function detectIntent(text, tokens) {
  const lower = String(text || "").toLowerCase();
  if (/\bpalindrom/.test(lower)) return "palindrome";
  // Reversal is its own family, named by the request itself. It used to fall
  // through to a generic question, which meant "whats the reverse of 'abcd'"
  // never counted as a task and could never trigger a reusable program.
  if (/\b(?:revers(?:e|ed|ing)|backwards?|flip|invert)\b/.test(lower)) return "reverse";
  const hasOrdinal = /\b(?:nth|\d+(?:st|nd|rd|th)|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/i.test(lower);
  const hasSequenceItem = /\b(?:number|numbers|element|elements|term|terms|value|values|item|items)\b/i.test(lower);
  const hasSequenceMarker = /\b(?:sequence|series|fibonacci|progression)\b/i.test(lower);
  if ((hasOrdinal && hasSequenceItem) || (hasSequenceMarker && (hasOrdinal || hasSequenceItem))) return "sequence-element";
  if (/\b(?:what is|calculate|solve|compute)\b.*(?:\d|plus|minus|times|multipl|divid|percent)/.test(lower) || /\d\s*[+*\/%-]\s*\d/.test(lower)) return "arithmetic";
  if (/\b(debug|fix|error|bug|broken|doesn't work|not working)\b/.test(lower)) return "debug";
  if (/\b(write|draft|compose|rewrite|edit|improve|translate|summarize)\b/.test(lower)) return "writing";
  if (/\b(example|examples|list|name|give me)\b/.test(lower)) return "list";
  if (/\b(what is|what are|explain|meaning of|define|how does)\b/.test(lower)) return "explain";
  if (/\b(code|implement|function|program|algorithm)\b/.test(lower)) return "code";
  if (tokens.length >= 3) return "question";
  return "generic";
}

function detectDomain(tokens, intent) {
  const scores = Object.fromEntries(Object.entries(DOMAIN_WORDS).map(([key, words]) => [key, tokens.filter((t) => words.has(t)).length]));
  const winner = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  if (winner && winner[1] > 0) return winner[0];
  if (intent === "palindrome" || intent === "reverse") return "strings";
  if (["arithmetic", "sequence-element"].includes(intent)) return "math";
  if (["code", "debug"].includes(intent)) return "programming";
  if (intent === "writing") return "writing";
  return "general";
}

function detectOperation(text, intent) {
  const lower = String(text || "").toLowerCase();
  if (intent === "palindrome") return "check-palindrome";
  if (intent === "sequence-element") return "lookup-sequence-element";
  if (intent === "arithmetic") return "calculate-expression";
  if (intent === "reverse" || /\b(reverse|reversed|backwards?|flip|invert)\b/.test(lower)) return "reverse-text";
  // Counting in a named span is a decidable computation, and each count is a
  // different one. They used to share one operation, which meant the compiler
  // treated "how many vowels are in banana" as an open question whose answer
  // could be fitted by anything that reproduced the number, including a rule
  // that ignored the span entirely. Naming the count is what lets the compiler
  // require the counting step it stands for.
  const counts = /\b(?:how many|count|number of)\b/.test(lower) ? lower : null;
  if (counts) {
    if (/\bvowels?\b/.test(counts)) return "count-vowels";
    if (/\bconsonants?\b/.test(counts)) return "count-consonants";
    if (/\bwords?\b/.test(counts)) return "count-words";
    if (/\b(?:letters?|characters?)\b/.test(counts)) return "count-letters";
    return "count-items";
  }
  if (/\b(classify|categorize|is this)\b/.test(lower)) return "classify";
  if (/\b(explain|what is|define|meaning)\b/.test(lower)) return "explain-concept";
  if (/\b(write|draft|compose)\b/.test(lower)) return "generate-text";
  if (/\b(summarize|summary)\b/.test(lower)) return "summarize";
  if (/\b(debug|fix|error|bug)\b/.test(lower)) return "debug-code";
  return intent;
}

function profileTask(text) {
  const raw = String(text || "").trim();
  const tokens = tokenize(raw);
  const intent = detectIntent(raw, tokens);
  const domain = detectDomain(tokens, intent);
  const operation = detectOperation(raw, intent);
  const wordTokens = tokens.filter((token) => /[a-z]/.test(token));
  const numeric = /\d/.test(raw);
  // Parametric families repeat with different values in the same frame, so one
  // content word plus a number is already a real task ("what is 6 times 7").
  // Everything else still needs two content words before it counts as a task
  // worth clustering.
  const contentful = wordTokens.length >= 2 || (PARAMETRIC_INTENTS.has(intent) && numeric && tokens.length > 0);
  // A request that names a concrete operation the compiler can compute is a
  // task even when the wording heuristics produce no label for it. Without this
  // the operation column and the profile would disagree about the same request.
  const namesOperation = operation !== intent && DECIDABLE_OPERATIONS.has(operation);
  const meaningful = raw.length >= 6 && contentful && (intent !== "generic" || namesOperation) && !tokens.every((token) => GENERIC.has(token));
  const keywords = [...new Set(tokens)].slice(0, 32);
  return {
    version: 3,
    meaningful,
    intent,
    domain,
    operation,
    keywords,
    tokenCount: tokens.length,
    fingerprint: `${intent}:${domain}:${operation}`,
  };
}

function hybridSimilarity(a, b, vectorSimilarity = 0) {
  if (!a?.meaningful || !b?.meaningful) return 0;
  const overlap = intersectionSize(a.keywords, b.keywords) / Math.max(1, Math.min(a.keywords.length, b.keywords.length));
  const sameShape = a.intent === b.intent && a.domain === b.domain && a.operation === b.operation;

  // Exact task profiles receive the strongest score. When wording heuristics
  // disagree (for example, one request says "what is" and another says
  // "calculate"), a shared domain plus meaningful vocabulary can still point
  // to the same reusable computation. This is what lets one Fibonacci or
  // classification program survive natural paraphrases without merging
  // unrelated questions.
  if (sameShape) {
    // Parametric tasks are repeated with fresh values: "what is 6 times 7" and
    // "what is 2 plus 2" share almost no vocabulary, yet they are the same
    // recurring computation. For these families the profile agreement carries
    // the match and the words only refine it.
    const parametric = PARAMETRIC_INTENTS.has(a.intent) || a.operation === "reverse-text" || a.operation === "count-items";
    if (!parametric && overlap < 0.25) return 0;
    const base = parametric ? 0.86 : 0.76;
    const keywordWeight = parametric ? 0.08 : 0.16;
    return Math.min(1, base + overlap * keywordWeight + Math.max(0, vectorSimilarity) * 0.08);
  }
  // Two requests that name different operations are different tasks even when
  // they share a domain and most of their words: "how many vowels are in banana"
  // and "how many letters are in banana" are one word apart and compute
  // different things, so they must never end up in one family.
  if (a.operation !== a.intent && b.operation !== b.intent && a.operation !== b.operation) return 0;
  if (a.domain !== b.domain || overlap < 0.35) return 0;
  return Math.min(1, 0.62 + overlap * 0.22 + Math.max(0, vectorSimilarity) * 0.16);
}

export { DIM, embed, cosine, centroid, profileTask, hybridSimilarity };
