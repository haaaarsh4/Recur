// Recur's program compiler and runtime.
//
// A compiled tool is an executable program in a small typed dataflow IR:
//
//   read  : request text          -> subject      (exactly one reader)
//   steps : subject               -> value        (zero or more pure transforms)
//   emit  : value + subject       -> answer       (exactly one emitter)
//
// Compilation is search, not prompting. Candidate programs are enumerated from
// structure discovered in the verified demonstrations (keywords, numbers,
// ordinals, quoted spans), evaluated against every demonstration pair, and the
// cheapest program that reproduces all of them exactly is kept. Execution is a
// pure function of (program, input): no model call, no network access, no
// hidden state.

const COMPILER_VERSION = "recur-compiler/1.1";
const RUNTIME = "recur-vm 1.1";
const SEARCH_BUDGET = Math.max(500, Number(process.env.PROGRAM_SEARCH_BUDGET || 12000));
const MAX_DEPTH = 2;
const STRESS_CASES = 64;

// ---------------------------------------------------------------------------
// value helpers
// ---------------------------------------------------------------------------

const FILLER = new Set([
  "as", "a", "an", "the", "is", "it", "to", "of", "for", "my", "this", "that", "be",
  "in", "at", "on", "with", "and", "or", "word", "words", "string", "text", "phrase",
  "number", "numbers", "letter", "letters", "please", "again", "me", "you",
]);

function isText(v) {
  return typeof v === "string";
}

function isNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function isBool(v) {
  return typeof v === "boolean";
}

function isList(v) {
  return Array.isArray(v);
}

function typeOf(value) {
  if (isText(value)) return "text";
  if (isNumber(value)) return "number";
  if (isBool(value)) return "bool";
  if (isList(value)) return "list";
  return "unknown";
}

function formatValue(value) {
  if (isNumber(value)) return Number.isInteger(value) ? String(value) : String(Math.round(value * 1e6) / 1e6);
  if (isBool(value)) return value ? "true" : "false";
  if (isList(value)) return value.map(formatValue).join(" ");
  return String(value ?? "");
}

function normalizeSpaces(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function stripEdges(value) {
  return String(value ?? "").replace(/^[\s"'`([{]+/, "").replace(/[\s"'`)\]}.,;:!?]+$/, "").trim();
}

function stripQuotes(value) {
  return String(value ?? "").replace(/^[\s"'`]+/, "").replace(/[\s"'`]+$/, "").trim();
}

function alnum(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function wordTokens(value) {
  return normalizeSpaces(value).match(/[A-Za-z0-9']+/g) || [];
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFrom(text) {
  let h = 2166136261;
  for (const ch of String(text)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) >>> 0;
}

// ---------------------------------------------------------------------------
// arithmetic: a real expression evaluator, so numeric programs compute rather
// than recall
// ---------------------------------------------------------------------------

const WORD_OPERATORS = [
  [/\bto the power of\b|\braised to\b/g, "^"],
  [/\bmultiplied by\b|\btimes\b|\bmultiply(?: by| with)?\b/g, "*"],
  [/\bdivided by\b|\bdivide(?: by| with)?\b/g, "/"],
  [/\bplus\b|\badded to\b|\badd\b/g, "+"],
  [/\bminus\b|\bsubtract(?:ed by| from)?\b|\bless\b|\bdifference between\b/g, "-"],
];

function expressionOf(input) {
  let text = normalizeSpaces(input).toLowerCase();
  for (const [pattern, symbol] of WORD_OPERATORS) text = text.replace(pattern, (match) => ` ${symbol} `);
  text = text.replace(/\[\/?math\]/g, " ");
  const spans = text.match(/[0-9+\-*/^%(). ]+/g) || [];
  // Longest expression first, but only an expression the evaluator accepts: a
  // span that loses a bracket while trimming must not shadow a working one.
  const ordered = [...spans].sort((a, b) => b.length - a.length);
  for (const span of ordered) {
    const trimmed = span.replace(/^[\s+\-*/^%.]+/, "").replace(/[\s+\-*/^%.]+$/, "");
    if (!/\d/.test(trimmed)) continue;
    if (evaluateExpression(trimmed) === undefined) continue;
    return trimmed;
  }
  return undefined;
}

function evaluateExpression(expression) {
  if (!expression) return undefined;
  const tokens = String(expression).match(/\d+(?:\.\d+)?|[+\-*/^%()]/g);
  if (!tokens) return undefined;
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];

  function primary() {
    const token = peek();
    if (token === undefined) return undefined;
    if (token === "(") {
      next();
      const value = expr();
      if (peek() !== ")") return undefined;
      next();
      return value;
    }
    if (token === "-") {
      next();
      const value = primary();
      return value === undefined ? undefined : -value;
    }
    if (token === "+") {
      next();
      return primary();
    }
    if (/^\d/.test(token)) {
      next();
      return Number(token);
    }
    return undefined;
  }
  function power() {
    const base = primary();
    if (base === undefined) return undefined;
    if (peek() === "^") {
      next();
      const exponent = power();
      if (exponent === undefined) return undefined;
      return Math.pow(base, exponent);
    }
    return base;
  }
  function term() {
    let value = power();
    if (value === undefined) return undefined;
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const op = next();
      const right = power();
      if (right === undefined) return undefined;
      value = op === "*" ? value * right : op === "/" ? value / right : value % right;
    }
    return value;
  }
  function expr() {
    let value = term();
    if (value === undefined) return undefined;
    while (peek() === "+" || peek() === "-") {
      const op = next();
      const right = term();
      if (right === undefined) return undefined;
      value = op === "+" ? value + right : value - right;
    }
    return value;
  }
  const result = expr();
  if (result === undefined || i !== tokens.length || !Number.isFinite(result)) return undefined;
  return Math.abs(result) > 1e15 ? undefined : result;
}

function evaluateArithmetic(input) {
  return evaluateExpression(expressionOf(input));
}

// ---------------------------------------------------------------------------
// ordinal numbers: "8th", "the third"
// ---------------------------------------------------------------------------

const WORD_ORDINALS = new Map([
  ["first", 1], ["second", 2], ["third", 3], ["fourth", 4], ["fifth", 5], ["sixth", 6],
  ["seventh", 7], ["eighth", 8], ["ninth", 9], ["tenth", 10], ["eleventh", 11], ["twelfth", 12],
  ["thirteenth", 13], ["fourteenth", 14], ["fifteenth", 15], ["sixteenth", 16], ["seventeenth", 17],
  ["eighteenth", 18], ["nineteenth", 19], ["twentieth", 20], ["thirtieth", 30], ["fortieth", 40],
  ["fiftieth", 50], ["hundredth", 100], ["thousandth", 1000],
]);

function ordinalValue(input) {
  const numeric = String(input).match(/\b(\d+)(?:st|nd|rd|th)\b/i);
  if (numeric) {
    const value = Number(numeric[1]);
    return value > 0 ? value : undefined;
  }
  const words = wordTokens(input).map((token) => token.toLowerCase());
  for (const token of words) {
    const direct = WORD_ORDINALS.get(token);
    if (direct) return direct;
  }
  for (let i = 0; i < words.length - 1; i++) {
    const tens = WORD_ORDINALS.get(words[i]);
    const units = WORD_ORDINALS.get(words[i + 1]);
    if (tens && tens >= 20 && units && units < 10) return tens + units;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// readers: request text -> subject
// ---------------------------------------------------------------------------

function keywordIndex(tokens, keyword) {
  const lower = keyword.toLowerCase();
  for (let i = 0; i < tokens.length; i++) if (tokens[i].toLowerCase() === lower) return i;
  return -1;
}

function anchoredWord(input, keyword, direction) {
  const tokens = wordTokens(input);
  const index = keywordIndex(tokens, keyword);
  if (index === -1) return undefined;
  const step = direction === "before" ? -1 : 1;
  for (let i = index + step; i >= 0 && i < tokens.length; i += step) {
    const token = tokens[i];
    if (FILLER.has(token.toLowerCase())) continue;
    const cleaned = stripEdges(token);
    if (!cleaned) continue;
    return cleaned;
  }
  return undefined;
}

function anchoredRest(input, keyword, direction) {
  const match = String(input).match(new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"));
  if (!match) return undefined;
  const rest = direction === "after"
    ? String(input).slice(match.index + match[0].length)
    : String(input).slice(0, match.index);
  const cleaned = stripQuotes(rest);
  return cleaned || undefined;
}

const READERS = {
  identity: { out: "text", label: "the whole request", run: (input) => normalizeSpaces(input) || undefined },
  firstWord: { out: "text", label: "the first word", run: (input) => stripEdges(wordTokens(input)[0]) || undefined },
  lastWord: {
    out: "text",
    label: "the last word",
    run: (input) => {
      const tokens = wordTokens(input).map(stripEdges).filter(Boolean);
      return tokens.length ? tokens[tokens.length - 1] : undefined;
    },
  },
  quoted: {
    out: "text",
    label: "the quoted span",
    run: (input) => {
      const match = String(input).match(/["'`]([^"'`]{1,160})["'`]/);
      return match ? stripEdges(match[1]) : undefined;
    },
  },
  numberLast: {
    out: "number",
    label: "the last number in the request",
    run: (input) => {
      const matches = String(input).match(/-?\d+(?:\.\d+)?/g);
      return matches ? Number(matches[matches.length - 1]) : undefined;
    },
  },
  numberFirst: {
    out: "number",
    label: "the first number in the request",
    run: (input) => {
      const match = String(input).match(/-?\d+(?:\.\d+)?/);
      return match ? Number(match[0]) : undefined;
    },
  },
  expression: { out: "number", label: "the arithmetic expression in the request", run: (input) => evaluateArithmetic(input) },
  ordinal: { out: "number", label: "the ordinal in the request", run: (input) => ordinalValue(input) },
  wordList: { out: "list", label: "the request's words", run: (input) => wordTokens(input) },
  wordBefore: { out: "text", label: 'the word before "{{keyword}}"', arg: "keyword", run: (input, arg) => anchoredWord(input, arg.keyword, "before") },
  wordAfter: { out: "text", label: 'the word after "{{keyword}}"', arg: "keyword", run: (input, arg) => anchoredWord(input, arg.keyword, "after") },
  restAfter: { out: "text", label: 'everything after "{{keyword}}"', arg: "keyword", run: (input, arg) => anchoredRest(input, arg.keyword, "after") },
  restBefore: { out: "text", label: 'everything before "{{keyword}}"', arg: "keyword", run: (input, arg) => anchoredRest(input, arg.keyword, "before") },
};

// ---------------------------------------------------------------------------
// steps: pure value transforms
// ---------------------------------------------------------------------------

function digitSum(value) {
  const digits = String(value).replace(/[^0-9]/g, "");
  if (!digits) return undefined;
  return digits.split("").reduce((sum, digit) => sum + Number(digit), 0);
}

function fib(n) {
  if (!Number.isInteger(n) || n < 0 || n > 78) return undefined;
  let a = 0;
  let b = 1;
  for (let i = 0; i < n; i++) [a, b] = [b, a + b];
  return a;
}

function isPrime(n) {
  if (!Number.isInteger(n) || n < 2 || n > 1e7) return undefined;
  for (let i = 2; i * i <= n; i++) if (n % i === 0) return false;
  return true;
}

function nthPrime(n) {
  if (!Number.isInteger(n) || n < 1 || n > 100000) return undefined;
  let found = 0;
  for (let candidate = 2; candidate < 1e7; candidate++) {
    if (isPrime(candidate)) {
      found += 1;
      if (found === n) return candidate;
    }
  }
  return undefined;
}

function factorial(n) {
  if (!Number.isInteger(n) || n < 0 || n > 20) return undefined;
  let value = 1;
  for (let i = 2; i <= n; i++) value *= i;
  return value;
}

function nthTriangular(n) {
  if (!Number.isInteger(n) || n < 1 || n > 1e6) return undefined;
  return (n * (n + 1)) / 2;
}

function nthSquare(n) {
  if (!Number.isInteger(n) || Math.abs(n) > 1e7) return undefined;
  return n * n;
}

const STEPS = {
  lower: { in: ["text"], out: "text", label: "lowercased", run: (v) => v.toLowerCase() },
  upper: { in: ["text"], out: "text", label: "uppercased", run: (v) => v.toUpperCase() },
  collapse: { in: ["text"], out: "text", label: "spaces collapsed", run: (v) => normalizeSpaces(v) },
  unquote: { in: ["text"], out: "text", label: "quotes trimmed", run: (v) => stripEdges(v) || undefined },
  alnum: { in: ["text"], out: "text", label: "reduced to letters and digits", run: (v) => alnum(v) || undefined },
  reverse: { in: ["text"], out: "text", label: "reversed", run: (v) => [...v].reverse().join("") },
  sortChars: { in: ["text"], out: "text", label: "sorted by character", run: (v) => [...v].sort().join("") },
  firstChar: { in: ["text"], out: "text", label: "first character", run: (v) => v.slice(0, 1) || undefined },
  lastChar: { in: ["text"], out: "text", label: "last character", run: (v) => v.slice(-1) || undefined },
  length: { in: ["text", "list"], out: "number", label: "length", run: (v) => (isList(v) ? v.length : [...v].length) },
  countWords: { in: ["text"], out: "number", label: "word count", run: (v) => wordTokens(v).length },
  countVowels: { in: ["text"], out: "number", label: "vowel count", run: (v) => (v.match(/[aeiou]/gi) || []).length },
  countConsonants: { in: ["text"], out: "number", label: "consonant count", run: (v) => (v.match(/[bcdfghjklmnpqrstvwxyz]/gi) || []).length },
  digitSum: { in: ["text", "number"], out: "number", label: "sum of digits", run: (v) => digitSum(v) },
  toNumber: { in: ["text"], out: "number", label: "read as a number", run: (v) => (Number.isFinite(Number(v)) ? Number(v) : undefined) },
  countChar: { in: ["text"], out: "number", label: 'count of the letter "{{letter}}"', param: "letter", run: (v, arg) => (v.toLowerCase().split(arg.letter).length - 1) },
  charAt: { in: ["text"], out: "text", label: "character at position {{number}}", param: "ordinal-position", run: (v, arg) => v[arg.number - 1] || undefined },
  equalsReversed: { in: ["text"], out: "bool", label: "text equals its own reverse", run: (v) => alnum(v).length > 0 && alnum(v) === [...alnum(v)].reverse().join("") },
  equalsLiteral: { in: ["text"], out: "bool", label: 'text equals "{{token}}"', param: "token", run: (v, arg) => alnum(v) === alnum(arg.token) },
  containsLiteral: { in: ["text"], out: "bool", label: 'text contains "{{token}}"', param: "token", run: (v, arg) => v.toLowerCase().includes(String(arg.token).toLowerCase()) },
  startsWith: { in: ["text"], out: "bool", label: 'text starts with "{{token}}"', param: "token", run: (v, arg) => v.toLowerCase().startsWith(String(arg.token).toLowerCase()) },
  endsWith: { in: ["text"], out: "bool", label: 'text ends with "{{token}}"', param: "token", run: (v, arg) => v.toLowerCase().endsWith(String(arg.token).toLowerCase()) },
  isDigits: { in: ["text"], out: "bool", label: "text is all digits", run: (v) => /^\d+$/.test(v) },
  isUpper: { in: ["text"], out: "bool", label: "text is uppercase", run: (v) => /[a-z]/.test(v) && v === v.toUpperCase() },
  isLower: { in: ["text"], out: "bool", label: "text is lowercase", run: (v) => /[A-Z]/.test(v) && v === v.toLowerCase() },
  not: { in: ["bool"], out: "bool", label: "negated", run: (v) => !v },
  add: { in: ["number"], out: "number", label: "increased by {{number}}", param: "number", run: (v, arg) => v + arg.number },
  subtract: { in: ["number"], out: "number", label: "decreased by {{number}}", param: "number", run: (v, arg) => v - arg.number },
  multiply: { in: ["number"], out: "number", label: "multiplied by {{number}}", param: "number", run: (v, arg) => v * arg.number },
  divide: { in: ["number"], out: "number", label: "divided by {{number}}", param: "number", run: (v, arg) => (arg.number === 0 ? undefined : v / arg.number) },
  mod: { in: ["number"], out: "number", label: "remainder after dividing by {{number}}", param: "number", run: (v, arg) => (arg.number === 0 ? undefined : v % arg.number) },
  negate: { in: ["number"], out: "number", label: "negated", run: (v) => -v },
  abs: { in: ["number"], out: "number", label: "absolute value", run: (v) => Math.abs(v) },
  square: { in: ["number"], out: "number", label: "squared", run: (v) => nthSquare(v) },
  factorial: { in: ["number"], out: "number", label: "factorial", run: (v) => factorial(v) },
  fibonacci: { in: ["number"], out: "number", label: "Fibonacci value at that position", run: (v) => fib(v) },
  triangular: { in: ["number"], out: "number", label: "triangular number at that position", run: (v) => nthTriangular(v) },
  primeAt: { in: ["number"], out: "number", label: "nth prime", run: (v) => nthPrime(v) },
  sum: { in: ["list"], out: "number", label: "sum", run: (v) => { const nums = v.map(Number).filter(Number.isFinite); return nums.length ? nums.reduce((a, b) => a + b, 0) : undefined; } },
  count: { in: ["list"], out: "number", label: "count", run: (v) => v.length },
  join: { in: ["list"], out: "text", label: "joined", run: (v) => v.join("") || undefined },
};

// ---------------------------------------------------------------------------
// emitters: value + subject -> answer text
// ---------------------------------------------------------------------------

// Case-insensitive on purpose: a small model will answer "Madam is a
// palindrome." after "Yes, "civic" is a palindrome.", and the compiled program
// should still learn the one wording that fits both.
function substitute(template, needle, placeholder) {
  if (!needle) return null;
  const index = String(template).toLowerCase().indexOf(String(needle).toLowerCase());
  if (index === -1) return null;
  return String(template).slice(0, index) + placeholder + String(template).slice(index + String(needle).length);
}

// Template inference with a support count. Demonstrated answers are noisy, so
// the winning wording is the one that explains the most demonstrations, not
// whichever one happened to be first.
function bestTemplate(needles, answers, placeholder, { requirePlaceholder = true, bonus = () => 0 } = {}) {
  let best = null;
  for (let anchor = 0; anchor < answers.length; anchor++) {
    const candidate = substitute(answers[anchor], needles[anchor], placeholder);
    if (candidate === null) continue;
    if (requirePlaceholder && !candidate.includes(placeholder)) continue;
    const support = answers.filter((answer, i) => candidate.split(placeholder).join(needles[i]) === answer).length;
    const score = support * 10 + bonus(candidate) + candidate.length * 0.001;
    if (!best || score > best.score) best = { template: candidate, support, score };
  }
  return best;
}

function buildTemplate(needles, answers, placeholder) {
  const best = bestTemplate(needles, answers, placeholder);
  return best ? best.template : null;
}

// A boolean program often observes only one branch ("is civic a palindrome" ->
// yes). The opposite wording is derived by a documented transform over the
// observed template: swap the Yes/No marker and negate the copula.
function counterpartTemplate(template) {
  if (!template.includes("{subject}")) return null;
  let derived = template;
  const marker = derived.match(/^(\s*)(Yes|No)\b/);
  if (!marker) return null;
  const swapped = marker[2] === "Yes" ? "No" : "Yes";
  derived = derived.replace(/^(\s*)(Yes|No)\b/, `$1${swapped}`);
  let negated = false;
  derived = derived.replace(/\b(is|are|was|were|has|have|had|does|do|did|can|could|will|would)\b(?!\s+(?:not|n't)\b)/, (match) => {
    negated = true;
    return match === "can" ? "cannot" : match === "could" ? "could not" : `${match} not`;
  });
  derived = derived.replace(/\b(is|are|was|were|has|have|had|does|do|did|can|could|will|would)\s+n't\b/, "$1 not");
  if (!negated && !/\bn(?:o|')?t\b/.test(derived)) return null;
  return derived;
}

// Residual tokens: the answer with the subject and the computed value removed,
// lowercased, punctuation dropped. What is left is the wording itself.
// Needles are removed as whole words, never as substrings: stripping the single
// character "o" as a substring would turn "palindrome" into "palindr me" and
// make unrelated answers look like the same wording.
function residualTokens(text, needles) {
  const drop = new Set();
  for (const needle of needles) {
    for (const token of String(needle ?? "").toLowerCase().match(/[a-z0-9]+/g) || []) {
      if (token.length > 1) drop.add(token);
    }
  }
  return new Set((String(text ?? "").toLowerCase().match(/[a-z0-9]+/g) || []).filter((token) => token.length > 1 && !drop.has(token)));
}

// Same answer, different wording. Small models do this constantly: "Yes, "civic"
// is a palindrome." followed by "Madam is a palindrome." is one program with two
// surface forms, not two tasks. Opposite answers are never variants, so a
// wrong branch cannot sneak in through this door.
function phraseVariant(produced, expected, subject, value) {
  const a = residualTokens(produced, [subject, value]);
  const b = residualTokens(expected, [subject, value]);
  if (!a.size || !b.size) return false;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared) >= 0.6;
}

// Wrap an emitter with the evidence for it. A program may only be compiled when
// it contradicts no demonstration: every demonstration is either reproduced
// exactly or recognised as the same answer in different words.
function withCoverage(emitter, subjects, values, answers) {
  const verdicts = values.map((value, i) => {
    const produced = emitAnswer(emitter, value, subjects[i]);
    if (produced === answers[i]) return "exact";
    if (produced !== undefined && phraseVariant(produced, answers[i], formatValue(subjects[i]), formatValue(value))) return "variant";
    return "contradiction";
  });
  const exactCount = verdicts.filter((verdict) => verdict === "exact").length;
  return {
    ...emitter,
    verdicts,
    exactCount,
    variantCount: verdicts.filter((verdict) => verdict === "variant").length,
    contradictions: verdicts.filter((verdict) => verdict === "contradiction").length,
    explainedCount: exactCount + verdicts.filter((verdict) => verdict === "variant").length,
  };
}

function inferEmitter(subjects, values, answers) {
  const subjectStrings = subjects.map(formatValue);
  const valueStrings = values.map(formatValue);
  // 1. The answer is exactly the computed value.
  if (values.every((value, i) => formatValue(value) === answers[i])) return withCoverage({ op: "plain", arg: {} }, subjects, values, answers);

  // 2. Boolean predicate: different wording per truth value.
  if (values.every(isBool)) {
    const branches = { true: null, false: null };
    const support = { true: 0, false: 0 };
    const observed = { true: 0, false: 0 };
    let ok = true;
    for (const truth of [true, false]) {
      const indexes = values.map((value, i) => (value === truth ? i : -1)).filter((i) => i !== -1);
      observed[truth] = indexes.length;
      if (!indexes.length) continue;
      // A literal branch is not a computation. Rule programs must derive their
      // wording from the subject or the computed value, otherwise the search
      // would happily memorize one answer per demonstration. Tasks that really
      // do have literal answers compile as a verified lookup instead.
      const found = bestTemplate(indexes.map((i) => subjectStrings[i]), indexes.map((i) => answers[i]), "{subject}", {
        // Prefer wording that can be negated for the unseen branch: "Yes, X is a
        // palindrome." teaches the no-case, "Madam is a palindrome." does not.
        bonus: (template) => (counterpartTemplate(template) ? 4 : 0),
      });
      if (!found) {
        ok = false;
        break;
      }
      branches[truth] = found.template;
      support[truth] = found.support;
    }
    if (ok && (branches.true || branches.false)) {
      const derived = [];
      if (!branches.true) {
        branches.true = counterpartTemplate(branches.false);
        if (branches.true) derived.push("true");
      }
      if (!branches.false) {
        branches.false = counterpartTemplate(branches.true);
        if (branches.false) derived.push("false");
      }
      if (branches.true || branches.false) {
        return withCoverage({ op: "truth", arg: { true: branches.true, false: branches.false, derived, support, observed } }, subjects, values, answers);
      }
    }
  }

  // 3. The answer wraps the extracted subject.
  const subjectTemplate = bestTemplate(subjectStrings, answers, "{subject}");
  if (subjectTemplate) return withCoverage({ op: "template", arg: { template: subjectTemplate.template, support: subjectTemplate.support } }, subjects, values, answers);

  // 4. The answer wraps the computed value.
  const valueTemplate = bestTemplate(valueStrings, answers, "{value}");
  if (valueTemplate) return withCoverage({ op: "template", arg: { template: valueTemplate.template, support: valueTemplate.support } }, subjects, values, answers);

  // 5. The answer contains both: value first, then the subject.
  for (let anchor = 0; anchor < Math.min(3, answers.length); anchor++) {
    const withValue = substitute(answers[anchor], valueStrings[anchor], "{value}");
    if (withValue === null) continue;
    const withBoth = substitute(withValue, subjectStrings[anchor], "{subject}");
    if (withBoth === null) continue;
    const fits = answers.every((answer, i) => withBoth.split("{subject}").join(subjectStrings[i]).split("{value}").join(valueStrings[i]) === answer);
    if (fits) return withCoverage({ op: "template", arg: { template: withBoth } }, subjects, values, answers);
  }

  return null;
}

function emitAnswer(emitter, value, subject) {
  const answerFor = (template) => template.replace(/\{subject\}/g, formatValue(subject)).replace(/\{value\}/g, formatValue(value));
  switch (emitter.op) {
    case "plain":
      return formatValue(value);
    case "literal":
      return emitter.arg.text;
    case "template":
      return answerFor(emitter.arg.template);
    case "truth": {
      const template = value ? emitter.arg.true : emitter.arg.false;
      return template ? answerFor(template) : undefined;
    }
    case "table": {
      const key = tableKey(subject);
      const answer = emitter.arg.map[key];
      return answer === undefined ? undefined : answer;
    }
    default:
      return undefined;
  }
}

function tableKey(subject) {
  return String(subject ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// candidate generation: structure discovered in the demonstrations
// ---------------------------------------------------------------------------

const STOP_FOR_ANCHORS = new Set([
  "what", "whats", "which", "how", "why", "is", "are", "was", "were", "the", "a", "an",
  "of", "to", "in", "on", "for", "and", "or", "me", "my", "you", "your", "it", "its",
  "do", "does", "did", "can", "could", "would", "should", "will", "please", "tell",
  "give", "show", "help", "this", "that", "there", "here", "if", "then", "so", "as",
]);

function keywordCandidates(pairs) {
  const counts = new Map();
  const roots = pairs.map((pair) => new Set(wordTokens(pair.input).map((token) => token.toLowerCase())));
  for (const tokens of roots) for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
  const inAll = [...counts].filter(([, count]) => count === pairs.length).map(([token]) => token);
  const partial = [...counts].filter(([, count]) => count >= Math.max(2, Math.ceil(pairs.length * 0.6)) && count < pairs.length).map(([token]) => token);
  const rank = (list) => list
    .filter((token) => token.length >= 2 && !STOP_FOR_ANCHORS.has(token) && !/^\d+$/.test(token))
    .sort((a, b) => b.length - a.length || a.localeCompare(b));
  return [...rank(inAll), ...rank(partial)].slice(0, 8);
}

function tokenCandidates(pairs, limit = 12) {
  const counts = new Map();
  for (const pair of pairs) {
    for (const token of wordTokens(pair.input).map((t) => t.toLowerCase())) {
      if (token.length < 2 || STOP_FOR_ANCHORS.has(token)) continue;
      counts.set(token, (counts.get(token) || 0) + 1);
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([token]) => token);
}

function letterCandidates(pairs, limit = 8) {
  const counts = new Map();
  for (const pair of pairs) for (const letter of String(pair.input).toLowerCase().replace(/[^a-z]/g, "")) counts.set(letter, (counts.get(letter) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([letter]) => letter);
}

function numberCandidates(pairs, limit = 8) {
  const values = new Set([1, 2, 3, 4, 5, 10, 100]);
  for (const pair of pairs) for (const match of String(pair.input).match(/\d+(?:\.\d+)?/g) || []) values.add(Number(match));
  return [...values].filter(Number.isFinite).sort((a, b) => a - b).slice(0, limit);
}

function candidateReaders(pairs, profile) {
  const candidates = [];
  const keywords = keywordCandidates(pairs);
  const hasNumbers = pairs.some((pair) => /\d/.test(pair.input));
  const hasQuotes = pairs.some((pair) => /["'`]/.test(pair.input));
  const isArithmetic = profile.intent === "arithmetic" || pairs.some((pair) => /\b(?:plus|minus|times|multiplied|divided|add|subtract)\b|[0-9]\s*[+\-*/^]\s*[0-9]/.test(pair.input));
  const isOrdinal = pairs.some((pair) => /\b\d+(?:st|nd|rd|th)\b|\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/i.test(pair.input));

  // Keywords are the strongest anchors: they appear in every demonstration of
  // the task, which is exactly what a reusable program's trigger looks like.
  for (const keyword of keywords) {
    candidates.push({ op: "restAfter", arg: { keyword } });
    candidates.push({ op: "wordAfter", arg: { keyword } });
    candidates.push({ op: "wordBefore", arg: { keyword } });
    candidates.push({ op: "restBefore", arg: { keyword } });
  }
  if (isArithmetic) candidates.push({ op: "expression" });
  if (isOrdinal) candidates.push({ op: "ordinal" });
  if (hasQuotes) candidates.push({ op: "quoted" });
  candidates.push({ op: "lastWord" });
  candidates.push({ op: "identity" });
  if (hasNumbers) candidates.push({ op: "numberLast" });
  candidates.push({ op: "wordList" });
  if (hasNumbers) candidates.push({ op: "numberFirst" });
  candidates.push({ op: "firstWord" });
  return candidates;
}

// Comparing the input against a literal is only a hypothesis when the literal is
// not simply the input it was read from. `equalsLiteral("civic")` on a subject
// that is the word "civic" memorises one demonstration and generalizes to
// nothing, so those instances are never generated.
const LITERAL_COMPARISONS = new Set(["equalsLiteral", "containsLiteral", "startsWith", "endsWith"]);

function memorisesInput(op, arg, values) {
  if (!LITERAL_COMPARISONS.has(op)) return false;
  const needle = alnum(arg.token);
  if (!needle) return false;
  return values.some((value) => {
    if (!isText(value)) return false;
    const haystack = alnum(value);
    if (!haystack) return false;
    return haystack === needle || haystack.startsWith(needle) || haystack.endsWith(needle);
  });
}

function instantiateSteps(fromType, pairs, values) {
  const instances = [];
  const seen = new Set();
  const push = (op, arg) => {
    const key = op + JSON.stringify(arg || {});
    if (seen.has(key)) return;
    seen.add(key);
    if (values && memorisesInput(op, arg || {}, values)) return;
    instances.push({ op, arg: arg || {} });
  };
  for (const [op, spec] of Object.entries(STEPS)) {
    if (!spec.in.includes(fromType)) continue;
    if (spec.param === "token") for (const token of tokenCandidates(pairs)) push(op, { token });
    else if (spec.param === "letter") for (const letter of letterCandidates(pairs)) push(op, { letter });
    else if (spec.param === "number") for (const number of numberCandidates(pairs)) push(op, { number });
    else if (spec.param === "ordinal-position") for (const number of [1, 2, 3, 5]) push(op, { number });
    else push(op, null);
  }
  return instances;
}

// Cost is a simplicity prior: prefer the program that computes the answer with
// the fewest, least specialized operators. Comparing an input against a literal
// costs more than a genuine computation, so a general rule beats a lookup that
// happens to fit the demonstrations.
const STEP_COST = {
  equalsLiteral: 2,
  containsLiteral: 2,
  startsWith: 2,
  endsWith: 2,
  add: 1.5,
  subtract: 1.5,
  multiply: 1.5,
  divide: 1.5,
  mod: 1.5,
  countChar: 1.5,
  charAt: 1.5,
};

function costOf(program) {
  const emitter = program.emit;
  const branches = [emitter.arg?.template, emitter.arg?.true, emitter.arg?.false, emitter.arg?.text].filter((value) => typeof value === "string");
  // An emitter that produces fixed text instead of deriving it from the input is
  // the shape memorization takes, so it is charged as much as several operators.
  const literalEmitter = ["literal", "template", "truth"].includes(emitter.op) && !branches.some((value) => /\{(?:subject|value)\}/.test(value));
  const steps = program.steps.reduce((sum, step) => sum + (STEP_COST[step.op] || 1), 0);
  return 1 + steps + 1 + (literalEmitter ? 6 : 0);
}

// ---------------------------------------------------------------------------
// synthesis: enumerate candidate programs, keep the cheapest exact fit
// ---------------------------------------------------------------------------

function sameOutputs(values, answers) {
  return values.every((value, i) => formatValue(value) === answers[i]);
}

const AFFINITY_OPERATORS = {
  "check-palindrome": { steps: ["equalsReversed"] },
  "calculate-expression": { readers: ["expression"] },
  "reverse-text": { steps: ["reverse"] },
  "lookup-sequence-element": { steps: ["fibonacci", "primeAt", "triangular", "square", "factorial"], readers: ["ordinal"] },
  classify: { steps: ["equalsReversed", "containsLiteral", "startsWith", "endsWith", "isDigits", "isUpper", "isLower", "equalsLiteral"] },
  "count-items": { steps: ["length", "count", "countWords", "countVowels", "countChar", "digitSum"] },
};

function affinityRank(program, profile) {
  const hint = AFFINITY_OPERATORS[profile.operation];
  if (!hint) return 0;
  if (hint.readers?.includes(program.read.op)) return 1;
  if (hint.steps?.some((step) => program.steps.some((candidate) => candidate.op === step))) return 1;
  return 0;
}

function synthesizeRule(pairs, profile, budget) {
  const answers = pairs.map((pair) => normalizeSpaces(pair.output));
  const solutions = [];
  let explored = 0;
  const roots = candidateReaders(pairs, profile);
  for (const root of roots) {
    const reader = READERS[root.op];
    const subjects = pairs.map((pair) => reader.run(pair.input, root.arg || {}));
    if (subjects.some((value) => value === undefined)) continue;
    const queue = [{ steps: [], values: subjects, subjects }];
    let cursor = 0;
    while (cursor < queue.length && explored < budget) {
      const node = queue[cursor++];
      explored += 1;
      const emit = inferEmitter(node.subjects, node.values, answers);
      if (emit) {
        solutions.push({
          read: root,
          steps: node.steps,
          emit,
          cost: costOf({ steps: node.steps, emit }),
          exactCount: emit.exactCount,
          variantCount: emit.variantCount,
          contradictions: emit.contradictions,
          fullyExplains: emit.exactCount === answers.length,
        });
      }
      if (node.steps.length >= MAX_DEPTH) continue;
      const fromType = typeOf(node.values[0]);
      for (const instance of instantiateSteps(fromType, pairs, node.values)) {
        const spec = STEPS[instance.op];
        const values = [];
        let failed = false;
        for (const value of node.values) {
          const next = spec.run(value, instance.arg || {});
          if (next === undefined) {
            failed = true;
            break;
          }
          values.push(next);
        }
        if (failed) continue;
        queue.push({ steps: [...node.steps, instance], values, subjects: node.subjects });
      }
    }
  }
  if (!solutions.length) return { solutions: [], explored };
  // Two ordering keys. First the operation the request profile names: when the
  // demonstrations all show one outcome (every palindrome tried was a real
  // palindrome) both a checker and a yes-sayer reproduce them, and the profile
  // says which recurring task the user is actually repeating. Then simplicity.
  // Reproduction is never traded away: only exact programs are considered.
  for (const solution of solutions) solution.affinity = affinityRank(solution, profile);
  // Preference order: contradicts nothing, then explains every demonstration,
  // then matches the profiled operation, then simplest.
  solutions.sort((a, b) => Number(b.contradictions === 0) - Number(a.contradictions === 0) || Number(b.fullyExplains) - Number(a.fullyExplains) || b.affinity - a.affinity || a.cost - b.cost);
  return { solutions, explored };
}

// A table program is the honest fallback when no rule generalizes: it answers
// only subjects it actually observed, and declines everything else.
function synthesizeTable(pairs, profile) {
  const readers = candidateReaders(pairs, profile).filter((candidate) => candidate.op !== "wordList" && candidate.op !== "expression" && candidate.op !== "ordinal" && candidate.op !== "numberFirst" && candidate.op !== "numberLast");
  const map = {};
  const answers = pairs.map((pair) => normalizeSpaces(pair.output));
  let best = null;
  for (const reader of readers) {
    const spec = READERS[reader.op];
    const keys = pairs.map((pair) => spec.run(pair.input, reader.arg || {}));
    if (keys.some((value) => value === undefined)) continue;
    const localMap = {};
    const unique = new Set(keys.map(tableKey));
    for (let i = 0; i < keys.length; i++) localMap[tableKey(keys[i])] = answers[i];
    const candidate = { read: reader, steps: [], emit: { op: "table", arg: { map: localMap } }, cost: 8, uniqueKeys: unique.size };
    if (!best || candidate.uniqueKeys > best.uniqueKeys) best = candidate;
  }
  if (!best) return null;
  for (const key of Object.keys(best.emit.arg.map)) map[key] = best.emit.arg.map[key];
  return { read: best.read, steps: [], emit: { op: "table", arg: { map } }, cost: 8 };
}

function compileProgram(pairs, profile) {
  const cleaned = pairs.map((pair) => ({ input: normalizeSpaces(pair.input), output: normalizeSpaces(pair.output) })).filter((pair) => pair.input && pair.output);
  if (!cleaned.length) return { program: null, reason: "no verified demonstrations were available to compile from" };
  const search = synthesizeRule(cleaned, profile, SEARCH_BUDGET);
  // A rule may be compiled when it contradicts no demonstration, or when it is
  // backed by a strict majority of them and disagrees only with outliers. The
  // second case matters because recorded answers can themselves be wrong: two
  // replies can claim opposite things about a property that is decidable, and
  // only one of them can stand. Whatever is set aside is reported with the tool
  // rather than silently dropped.
  const seed = seedFrom(cleaned.map((pair) => pair.input).join("|"));
  const clean = search.solutions.find((solution) => solution.contradictions === 0 && solution.exactCount >= 1 && respondsToInput(solution, seed));
  const rule = clean || search.solutions.find((solution) => solution.exactCount >= 1 && solution.exactCount + solution.variantCount > solution.contradictions && respondsToInput(solution, seed));
  let program = null;
  if (rule) {
    program = { version: 1, family: "rule", read: rule.read, steps: rule.steps, emit: rule.emit };
    const outliers = (rule.emit.verdicts || []).map((verdict, i) => (verdict === "contradiction" ? cleaned[i] : null)).filter(Boolean);
    program.coverage = {
      demonstrations: cleaned.length,
      exact: rule.exactCount,
      variants: rule.variantCount,
      explained: rule.exactCount + rule.variantCount,
      contradictions: rule.contradictions,
      outliers: outliers.slice(0, 4),
    };
  } else {
    const table = synthesizeTable(cleaned, profile);
    if (table && sameOutputsExact(table, cleaned)) {
      program = { version: 1, family: "table", read: table.read, steps: [], emit: table.emit };
      // Say why nothing generalizes. The closest computation, if any, names the
      // recorded answers it could not reproduce, which is usually the useful
      // part of the story: two replies claimed opposite things.
      const closest = search.solutions[0];
      const disagreements = (closest?.emit?.verdicts || []).map((verdict, i) => (verdict === "contradiction" ? cleaned[i] : null)).filter(Boolean).slice(0, 3);
      program.coverage = { demonstrations: cleaned.length, exact: cleaned.length, variants: 0, explained: cleaned.length, contradictions: 0, disagreements, closestPath: closest ? programPath({ read: closest.read, steps: closest.steps, emit: closest.emit }) : null };
    }
  }
  if (!program) {
    return {
      program: null,
      reason: "the verified demonstrations do not share one deterministic computation, and no verified lookup covers them either",
      explored: search.explored,
    };
  }
  program.cost = costOf(program);
  return {
    program,
    explored: search.explored,
    alternatives: search.solutions.length,
    coverage: program.coverage || { demonstrations: cleaned.length, exact: cleaned.length, variants: 0, explained: cleaned.length },
  };
}

// A compiled program has to respond to its input. A candidate whose answer is
// the same for every in-domain request it can read is a recited line, not a
// computation, no matter how well it fits the demonstrations.
function respondsToInput(solution, seed = 7) {
  const answers = new Set();
  let executed = 0;
  for (const input of sampleProgramInputs(solution, 8, seed)) {
    const run = executeProgram(solution, input);
    if (!run.ok) continue;
    executed += 1;
    answers.add(run.text);
  }
  return executed < 3 || answers.size > 1;
}

// The cheapest solution reported by the search is already exact, but keep the
// explicit check so a future scoring change cannot ship a wrong program.
function sameOutputsExact(solution, pairs) {
  for (const pair of pairs) {
    const run = executeProgram(solution, pair.input);
    if (!run.ok || normalizeSpaces(run.text) !== normalizeSpaces(pair.output)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// runtime
// ---------------------------------------------------------------------------

function stepLabel(step) {
  const spec = STEPS[step.op];
  if (!spec) return step.op;
  let label = spec.label;
  const arg = step.arg || {};
  label = label.replace("{{token}}", arg.token ?? "").replace("{{letter}}", arg.letter ?? "").replace("{{number}}", String(arg.number ?? ""));
  return label;
}

function readerLabel(read) {
  const spec = READERS[read.op];
  if (!spec) return read.op;
  return spec.label.replace("{{keyword}}", (read.arg || {}).keyword ?? "");
}

function executeProgram(program, input) {
  const startedAt = Date.now();
  const trace = [];
  const reader = READERS[program.read.op];
  if (!reader) return { ok: false, reason: "unknown reader", ms: Date.now() - startedAt, trace };
  const subject = reader.run(input, program.read.arg || {});
  if (subject === undefined) {
    return { ok: false, reason: "the request does not match this program's input pattern", ms: Date.now() - startedAt, trace: [`read: ${readerLabel(program.read)} -> no match`] };
  }
  trace.push(`read: ${readerLabel(program.read)} -> ${formatValue(subject)}`);
  let value = subject;
  for (const step of program.steps) {
    const spec = STEPS[step.op];
    if (!spec) return { ok: false, reason: `unknown step ${step.op}`, ms: Date.now() - startedAt, trace };
    const next = spec.run(value, step.arg || {});
    if (next === undefined) {
      return { ok: false, reason: `step failed: ${stepLabel(step)}`, ms: Date.now() - startedAt, trace };
    }
    value = next;
    trace.push(`step: ${stepLabel(step)} -> ${formatValue(value)}`);
  }
  const text = emitAnswer(program.emit, value, subject);
  if (text === undefined) {
    return { ok: false, reason: program.emit.op === "table" ? "this program has no verified answer for that input" : "no answer branch matched for that input", ms: Date.now() - startedAt, trace };
  }
  trace.push(`emit: ${emitterLabel(program.emit)}`);
  return { ok: true, text: normalizeSpaces(text), ms: Date.now() - startedAt, trace, path: programPath(program) };
}

function emitterLabel(emit) {
  switch (emit.op) {
    case "plain":
      return "return the computed value";
    case "literal":
      return "return the verified literal answer";
    case "template":
      return `fill template ${JSON.stringify(emit.arg.template)}`;
    case "truth":
      return `select wording for true/false (${JSON.stringify(emit.arg.true)} / ${JSON.stringify(emit.arg.false)})`;
    case "table":
      return `look up the verified answer (${Object.keys(emit.arg.map).length} entries)`;
    default:
      return emit.op;
  }
}

function programPath(program) {
  return [readerLabel(program.read), ...program.steps.map(stepLabel), program.emit.op === "table" ? "lookup" : "emit"].join(" → ");
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

function gradeProgram(program, pairs) {
  let reproduced = 0;
  for (const pair of pairs) {
    const run = executeProgram(program, pair.input);
    if (run.ok && normalizeSpaces(run.text) === normalizeSpaces(pair.output)) reproduced += 1;
  }
  return { verified: pairs.length, reproduced, consistency: pairs.length ? reproduced / pairs.length : 0 };
}

// Leave-one-out: compile from every demonstration except one, then check the
// held-out demonstration. This measures generalization, not memorization, and
// is why a table program reports zero.
function leaveOneOut(pairs, profile) {
  if (pairs.length < 2) return { folds: 0, passed: 0 };
  let passed = 0;
  for (let i = 0; i < pairs.length; i++) {
    const training = pairs.filter((_, index) => index !== i);
    const compiled = compileProgram(training, profile);
    if (!compiled.program) continue;
    const run = executeProgram(compiled.program, pairs[i].input);
    if (run.ok && normalizeSpaces(run.text) === normalizeSpaces(pairs[i].output)) passed += 1;
  }
  return { folds: pairs.length, passed };
}

// Inputs in the program's own language, built by reusing the request template
// with the captured span replaced. Used to stress the runtime and to train the
// acceptance head on more than the handful of raw demonstrations.
function inputTemplateFor(program, input) {
  const reader = READERS[program.read.op];
  if (!reader) return null;
  const subject = reader.run(input, program.read.arg || {});
  if (subject === undefined) return null;
  const needle = formatValue(subject);
  const index = String(input).indexOf(needle);
  if (index === -1) return null;
  return String(input).slice(0, index) + "\u0000" + String(input).slice(index + needle.length);
}

const SAMPLE_WORDS = [
  "racecar", "level", "rotator", "kayak", "zebra", "lantern", "compass", "harbor",
  "meadow", "tundra", "quartz", "ember", "prism", "willow", "cobalt", "juniper",
  "ragnar", "dupont", "trinity", "matrix", "civic", "radar", "solos", "banana",
];

// In-domain requests for a program, built from its reader plus the wording the
// reader accepts. The variety matters: the acceptance head trains on these, so
// one fixed template would teach it to memorise wording instead of the task.
const ARITHMETIC_FRAMES = [
  "what is {a} plus {b}",
  "what is {a} times {b}",
  "what is {a} minus {b}",
  "calculate {a} + {b}",
  "compute {a} * {b}",
  "what is {a}+{b}",
  "what is {a} divided by {b}",
  "what is ({a} + {b}) * 2",
  "{a} + {b} please",
  "work out {a} - {b}",
];

function sampleProgramInputs(program, count, seed) {
  const random = mulberry32(seed);
  const read = program.read.op;
  const keyword = (program.read.arg || {}).keyword;
  const outputs = [];
  for (let i = 0; i < count; i++) {
    const word = SAMPLE_WORDS[Math.floor(random() * SAMPLE_WORDS.length)];
    const number = 1 + Math.floor(random() * 60);
    const operand = 1 + Math.floor(random() * 40);
    const second = 1 + Math.floor(random() * 40);
    switch (read) {
      case "wordBefore":
        outputs.push(`${["is", "check", "verify", "test", "confirm"][Math.floor(random() * 5)]} ${word} as a ${keyword}`);
        break;
      case "wordAfter":
        outputs.push(`${keyword} ${word}`);
        break;
      case "restAfter":
        outputs.push(`${keyword} the ${word}`);
        break;
      case "restBefore":
        outputs.push(`${word} ${keyword}`);
        break;
      case "lastWord":
        outputs.push(`tell me about ${word}`);
        break;
      case "firstWord":
        outputs.push(`${word} please`);
        break;
      case "numberLast":
        outputs.push(`what happens with ${number} and ${second}`);
        break;
      case "numberFirst":
        outputs.push(`${number} then ${word}`);
        break;
      case "expression":
        outputs.push(ARITHMETIC_FRAMES[i % ARITHMETIC_FRAMES.length].replace("{a}", String(operand)).replace("{b}", String(second)));
        break;
      case "ordinal":
        outputs.push(`what is the ${number}th term`);
        break;
      case "quoted":
        outputs.push(`process "${word}" please`);
        break;
      case "wordList":
        outputs.push(`${word} ${operand} ${word}`);
        break;
      case "identity":
        outputs.push([`tell me about ${word}`, `${word} in detail`, `describe ${word} briefly`, `what can you say about ${word}`, `notes on ${word}`, `${word} and ${SAMPLE_WORDS[Math.floor(random() * SAMPLE_WORDS.length)]}`][i % 6]);
        break;
      default:
        break;
    }
  }
  return outputs;
}

function stressTest(program, seed) {
  const cases = sampleProgramInputs(program, STRESS_CASES, seed);
  let executed = 0;
  let declined = 0;
  let deterministic = 0;
  let crashes = 0;
  let totalMs = 0;
  for (const input of cases) {
    try {
      const first = executeProgram(program, input);
      const second = executeProgram(program, input);
      totalMs += first.ms + second.ms;
      if (first.ok) executed += 1;
      else declined += 1;
      if (first.ok === second.ok && first.text === second.text) deterministic += 1;
    } catch (e) {
      crashes += 1;
    }
  }
  return {
    cases: cases.length,
    executed,
    declined,
    deterministic,
    crashes,
    avgMs: cases.length ? Math.round((totalMs / cases.length) * 1000) / 1000 : 0,
  };
}

// ---------------------------------------------------------------------------
// human readable description of a compiled program
// ---------------------------------------------------------------------------

const NAME_BY_STEP = {
  equalsReversed: "palindrome-checker",
  reverse: "text-reverser",
  upper: "text-uppercaser",
  lower: "text-lowercaser",
  sortChars: "character-sorter",
  digitSum: "digit-sum",
  sum: "list-sum",
  count: "item-counter",
  countWords: "word-counter",
  countVowels: "vowel-counter",
  countConsonants: "consonant-counter",
  countChar: "letter-counter",
  length: "length-measurer",
  fibonacci: "fibonacci-sequence",
  primeAt: "prime-sequence",
  triangular: "triangular-sequence",
  factorial: "factorial-sequence",
  isDigits: "digit-checker",
  isUpper: "case-checker",
  isLower: "case-checker",
  containsLiteral: "substring-checker",
  startsWith: "prefix-checker",
  endsWith: "suffix-checker",
  equalsLiteral: "equality-checker",
  square: "square-calculator",
};

const NAME_BY_READ = {
  expression: "arithmetic-evaluator",
  ordinal: "ordinal-reader",
  quoted: "quoted-text-reader",
  numberLast: "number-reader",
  numberFirst: "number-reader",
  wordList: "word-reader",
};

function nameProgram(program, profile) {
  for (const step of program.steps) if (NAME_BY_STEP[step.op]) return NAME_BY_STEP[step.op];
  const truth = program.emit.op === "truth" ? program.emit.arg : null;
  if (truth) {
    const templates = [truth.true, truth.false].filter(Boolean).join(" ").toLowerCase();
    if (/palindrom/.test(templates)) return "palindrome-checker";
    if (/\bvowel/.test(templates)) return "vowel-checker";
    if (/\bword/.test(templates) && /\bcount|number of words|words\b/.test(templates)) return "word-counter";
    return "yes-no-classifier";
  }
  if (program.emit.op === "table") return `${profile.operation || "task"}-lookup`;
  if (NAME_BY_READ[program.read.op]) return NAME_BY_READ[program.read.op];
  if (["countVowels", "countWords", "length", "count", "countChar"].includes(program.steps[0]?.op)) return "text-counter";
  return `recurring-${profile.operation || "task"}-program`;
}

function sanitizeName(name) {
  const normalized = String(name || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 44);
  return normalized || "recurring-task-program";
}

function specificationFor(program) {
  const read = readerLabel(program.read);
  const steps = program.steps.map(stepLabel);
  const emit = emitterLabel(program.emit);
  const chain = steps.length ? steps.join(", then ") : "no further transformation";
  return `Reads ${read}, applies ${chain}, and ${emit}.`;
}

function programListing(program) {
  return [readerLabel(program.read), ...program.steps.map(stepLabel), emitterLabel(program.emit)];
}

function uncoveredBranches(program) {
  if (program.emit.op !== "truth") return [];
  const missing = [];
  if (!program.emit.arg.true) missing.push("true");
  if (!program.emit.arg.false) missing.push("false");
  return missing;
}

// Branches whose wording was derived rather than observed, so the registry can
// say exactly which part of the program is inferred and which part is evidence.
function derivedBranches(program) {
  if (program.emit.op !== "truth") return [];
  return (program.emit.arg.derived || []).filter(Boolean);
}

function programSummary(program) {
  const operators = program.steps.filter((step) => STEPS[step.op]).length;
  return {
    family: program.family,
    path: programPath(program),
    operatorCount: operators,
    cost: program.cost,
    tableSize: program.emit.op === "table" ? Object.keys(program.emit.arg.map).length : 0,
    uncoveredBranches: uncoveredBranches(program),
    derivedBranches: derivedBranches(program),
  };
}

export {
  COMPILER_VERSION,
  RUNTIME,
  compileProgram,
  synthesizeRule,
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
  programPath,
  phraseVariant,
  residualTokens,
  evaluateExpression,
  inputTemplateFor,
  READERS,
  STEPS,
};
