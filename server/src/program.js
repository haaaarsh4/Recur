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

import { profileTask } from "./embeddings.js";

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

// Yes and no change the claim, not the wording that carries it, so they are
// allowed to differ between two ways of wording the same answer.
const WORDING_TOKENS = new Set([...FILLER, "yes", "no", "yep", "nope", "true", "false", "indeed", "correct", "incorrect", "sure", "certainly", "definitely", "not", "also", "then", "thus", "hence"]);

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

// `label` is the one description of an operation, and it is written the way a
// person would say it. The execution trace, the compiled path and the registry
// line all read the same sentence parts, so a program can never be described as
// something other than what it runs: an internal name or a raw operation dump
// has nowhere to come from.
const READERS = {
  identity: { out: "text", label: "the request text", run: (input) => normalizeSpaces(input) || undefined },
  firstWord: { out: "text", label: "the first word in the request", run: (input) => stripEdges(wordTokens(input)[0]) || undefined },
  lastWord: {
    out: "text",
    label: "the last word in the request",
    run: (input) => {
      const tokens = wordTokens(input).map(stripEdges).filter(Boolean);
      return tokens.length ? tokens[tokens.length - 1] : undefined;
    },
  },
  quoted: {
    out: "text",
    label: "the quoted text in the request",
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
  ordinal: { out: "number", label: "the position number in the request", run: (input) => ordinalValue(input) },
  wordList: { out: "list", label: "the words of the request", run: (input) => wordTokens(input) },
  wordBefore: { out: "text", label: 'the word before "{{keyword}}"', arg: "keyword", run: (input, arg) => anchoredWord(input, arg.keyword, "before") },
  wordAfter: { out: "text", label: 'the word after "{{keyword}}"', arg: "keyword", run: (input, arg) => anchoredWord(input, arg.keyword, "after") },
  restAfter: { out: "text", label: 'the text after "{{keyword}}"', arg: "keyword", run: (input, arg) => anchoredRest(input, arg.keyword, "after") },
  restBefore: { out: "text", label: 'the text before "{{keyword}}"', arg: "keyword", run: (input, arg) => anchoredRest(input, arg.keyword, "before") },
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
  lower: { in: ["text"], out: "text", label: "lowercases it", run: (v) => v.toLowerCase() },
  upper: { in: ["text"], out: "text", label: "uppercases it", run: (v) => v.toUpperCase() },
  collapse: { in: ["text"], out: "text", label: "collapses the spaces", run: (v) => normalizeSpaces(v) },
  unquote: { in: ["text"], out: "text", label: "trims the quotes", run: (v) => stripEdges(v) || undefined },
  alnum: { in: ["text"], out: "text", label: "keeps only its letters and digits", run: (v) => alnum(v) || undefined },
  reverse: { in: ["text"], out: "text", label: "reverses it", run: (v) => [...v].reverse().join("") },
  sortChars: { in: ["text"], out: "text", label: "sorts its characters", run: (v) => [...v].sort().join("") },
  firstChar: { in: ["text"], out: "text", label: "takes its first character", run: (v) => v.slice(0, 1) || undefined },
  lastChar: { in: ["text"], out: "text", label: "takes its last character", run: (v) => v.slice(-1) || undefined },
  length: { in: ["text", "list"], out: "number", label: "measures its length", run: (v) => (isList(v) ? v.length : [...v].length) },
  countWords: { in: ["text"], out: "number", label: "counts its words", run: (v) => wordTokens(v).length },
  countVowels: { in: ["text"], out: "number", label: "counts its vowels", run: (v) => (v.match(/[aeiou]/gi) || []).length },
  countConsonants: { in: ["text"], out: "number", label: "counts its consonants", run: (v) => (v.match(/[bcdfghjklmnpqrstvwxyz]/gi) || []).length },
  digitSum: { in: ["text", "number"], out: "number", label: "adds up its digits", run: (v) => digitSum(v) },
  toNumber: { in: ["text"], out: "number", label: "reads it as a number", run: (v) => (Number.isFinite(Number(v)) ? Number(v) : undefined) },
  countChar: { in: ["text"], out: "number", label: 'counts the "{{letter}}" characters', param: "letter", run: (v, arg) => (v.toLowerCase().split(arg.letter).length - 1) },
  charAt: { in: ["text"], out: "text", label: "takes the character at position {{number}}", param: "ordinal-position", run: (v, arg) => v[arg.number - 1] || undefined },
  equalsReversed: { in: ["text"], out: "bool", label: "checks whether it reads the same way backwards", run: (v) => alnum(v).length > 0 && alnum(v) === [...alnum(v)].reverse().join("") },
  equalsLiteral: { in: ["text"], out: "bool", label: 'checks whether it equals "{{token}}"', param: "token", run: (v, arg) => alnum(v) === alnum(arg.token) },
  containsLiteral: { in: ["text"], out: "bool", label: 'checks whether it contains "{{token}}"', param: "token", run: (v, arg) => v.toLowerCase().includes(String(arg.token).toLowerCase()) },
  startsWith: { in: ["text"], out: "bool", label: 'checks whether it starts with "{{token}}"', param: "token", run: (v, arg) => v.toLowerCase().startsWith(String(arg.token).toLowerCase()) },
  endsWith: { in: ["text"], out: "bool", label: 'checks whether it ends with "{{token}}"', param: "token", run: (v, arg) => v.toLowerCase().endsWith(String(arg.token).toLowerCase()) },
  isDigits: { in: ["text"], out: "bool", label: "checks whether it is all digits", run: (v) => /^\d+$/.test(v) },
  isUpper: { in: ["text"], out: "bool", label: "checks whether it is uppercase", run: (v) => /[a-z]/.test(v) && v === v.toUpperCase() },
  isLower: { in: ["text"], out: "bool", label: "checks whether it is lowercase", run: (v) => /[A-Z]/.test(v) && v === v.toLowerCase() },
  not: { in: ["bool"], out: "bool", label: "negates the result", run: (v) => !v },
  add: { in: ["number"], out: "number", label: "increases it by {{number}}", param: "number", run: (v, arg) => v + arg.number },
  subtract: { in: ["number"], out: "number", label: "decreases it by {{number}}", param: "number", run: (v, arg) => v - arg.number },
  multiply: { in: ["number"], out: "number", label: "multiplies it by {{number}}", param: "number", run: (v, arg) => v * arg.number },
  divide: { in: ["number"], out: "number", label: "divides it by {{number}}", param: "number", run: (v, arg) => (arg.number === 0 ? undefined : v / arg.number) },
  mod: { in: ["number"], out: "number", label: "takes the remainder after dividing by {{number}}", param: "number", run: (v, arg) => (arg.number === 0 ? undefined : v % arg.number) },
  negate: { in: ["number"], out: "number", label: "negates it", run: (v) => -v },
  abs: { in: ["number"], out: "number", label: "takes its absolute value", run: (v) => Math.abs(v) },
  square: { in: ["number"], out: "number", label: "squares it", run: (v) => nthSquare(v) },
  factorial: { in: ["number"], out: "number", label: "takes its factorial", run: (v) => factorial(v) },
  fibonacci: { in: ["number"], out: "number", label: "takes the Fibonacci number at that position", run: (v) => fib(v) },
  triangular: { in: ["number"], out: "number", label: "takes the triangular number at that position", run: (v) => nthTriangular(v) },
  primeAt: { in: ["number"], out: "number", label: "takes the nth prime", run: (v) => nthPrime(v) },
  sum: { in: ["list"], out: "number", label: "adds the values up", run: (v) => { const nums = v.map(Number).filter(Number.isFinite); return nums.length ? nums.reduce((a, b) => a + b, 0) : undefined; } },
  count: { in: ["list"], out: "number", label: "counts them", run: (v) => v.length },
  join: { in: ["list"], out: "text", label: "joins them", run: (v) => v.join("") || undefined },
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

// Whether a sentence actually reports a value, rather than merely containing its
// characters inside another word. The reply "The reverse of 'abcd' is 'cba'."
// does not report the value "d" even though "abcd" contains that letter, and a
// program whose computed value happened to be a letter of the request's own word
// used to pass that off as the reply agreeing with it.
// A program may only state numbers it derived. Every number in an answer has to
// come from the request it was given, the span it extracted, or the value it
// computed; a number from nowhere is one recorded reply's incidental content.
// "Yes, 12 is the 7th number in the Fibonacci series." states a position nothing
// computed, so it cannot be evidence for a program whose whole result was a
// yes/no verdict. This is what stops a rule from copying a claim it never
// established, whatever the task family happens to be.
function digitRuns(text) {
  return String(text ?? "").match(/\d+/g) || [];
}

function derivesEveryNumber(text, value, input, subject) {
  const known = new Set([...digitRuns(input), ...digitRuns(formatValue(subject))]);
  const valueText = formatValue(value);
  // A sentence that reports the computed value is quoting the computation, so
  // the numbers inside that value count as derived too.
  if (reportsValue(text, valueText)) for (const run of digitRuns(valueText)) known.add(run);
  return digitRuns(text).every((run) => known.has(run));
}

function reportsValue(text, value) {
  const needle = String(value ?? "").trim().toLowerCase();
  const needleTokens = needle.match(/[a-z0-9]+/g) || [];
  if (!needleTokens.length) return false;
  const textTokens = (String(text ?? "").toLowerCase().match(/[a-z0-9]+/g) || []);
  if (needleTokens.length > 1) return textTokens.join(" ").includes(needleTokens.join(" "));
  return textTokens.includes(needleTokens[0]);
}

function containsValue(text, value) {
  const haystack = normalizeSpaces(String(text ?? "")).toLowerCase();
  const needle = normalizeSpaces(String(value ?? "")).toLowerCase();
  if (!needle) return false;
  if (haystack.includes(needle)) return true;
  const packed = alnum(needle);
  return packed.length > 1 && alnum(haystack).includes(packed);
}

// A recorded reply sometimes answers about a different word than the request
// named: "is abdor a palindrome" can come back as a sentence about "abcdeba".
// The reply is still a usable phrasing sample, because its own echoed span shows
// where the placeholder belongs. The request's subject is used whenever the
// reply does mention it.
function echoedNeedle(answer, subject) {
  const text = String(answer ?? "");
  if (containsValue(text, subject)) return subject;
  const quoted = text.match(/["'`]([^"'`]{1,60})["'`]/);
  if (quoted && /[a-z0-9]/i.test(quoted[1])) return quoted[1];
  return null;
}

// The value a reply reports, located by the reply's own content when it never
// mentions the computed value. A reply of "5" to "what is 2 plus 2" still shows
// where the value sits in the sentence, which is what lets the compiler record
// that the reply miscomputed rather than treat the whole reply as unusable.
function valueNeedle(answer, value) {
  const needle = echoedNeedle(answer, value);
  if (needle !== null) return needle;
  const numbers = String(answer ?? "").match(/-?\d+(?:\.\d+)?/g);
  return numbers && numbers.length ? numbers[0] : null;
}

// Template inference with a support count. Demonstrated answers are noisy, so
// the winning wording is the one that explains the most demonstrations, not
// whichever one happened to be first.
function bestTemplate(needles, answers, placeholder, { requirePlaceholder = true, bonus = () => 0, needleFor = echoedNeedle } = {}) {
  let best = null;
  for (let anchor = 0; anchor < answers.length; anchor++) {
    const candidate = substitute(answers[anchor], needleFor(answers[anchor], needles[anchor]), placeholder);
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
// observed template: swap the Yes/No marker and flip the negation, so the
// branch that was never observed still gets a natural sentence.
function counterpartTemplate(template) {
  const text = String(template ?? "");
  if (!text.includes("{subject}")) return null;
  const marker = text.match(/^(\s*)(Yes|No)\b/);
  if (!marker) return null;
  const affirmative = marker[2] === "Yes";
  const swapped = text.replace(/^(\s*)(Yes|No)\b/, `$1${affirmative ? "No" : "Yes"}`);
  if (affirmative) {
    let negated = false;
    const derived = swapped.replace(/\b(is|are|was|were|has|have|had|does|do|did|can|could|will|would)\b(?!\s+(?:not|n't)\b)/, (match) => {
      negated = true;
      return match === "can" ? "cannot" : match === "could" ? "could not" : `${match} not`;
    });
    return negated ? derived : null;
  }
  // Denial to affirmation: the negation has to come out, otherwise the derived
  // branch would deny the very property it is supposed to affirm.
  const derived = swapped.replace(/\s+\bnot\b/, "").replace(/\bn't\b/, "").replace(/\bcannot\b/, "can");
  return derived === swapped ? null : derived;
}

// Does a reply assert the property, deny it, or say nothing either way? The
// wording of a reply is evidence about phrasing, but its verdict has to be read
// separately, because a small model answers "Yes, hello is a palindrome."
function assertedPolarity(text) {
  const lower = normalizeSpaces(text).toLowerCase();
  if (!lower) return null;
  const affirms = /^(?:yes|yeah|yep|correct|true|affirmative|it is|indeed)\b/.test(lower);
  const denies = /^(?:no|nope|nah|false|incorrect|negative)\b/.test(lower)
    || /\b(?:is|are|was|were|does|do|did|has|have)\s+not\b/.test(lower)
    || /\b(?:isn't|aren't|wasn't|weren't|doesn't|don't|didn't|hasn't|haven't|can't|cannot|won't)\b/.test(lower);
  if (affirms && !denies) return true;
  if (denies && !affirms) return false;
  return null;
}

// The value a reply reports, when its wording is known: split the template at
// the value placeholder, require the reply to carry the same wording around it,
// and read the span in between. This is how a reply that claims the reverse of
// "hello" is "hello" is caught claiming a value the computation never produces.
function reportedValue(template, answer, subjectText) {
  if (typeof template !== "string" || !template.includes("{value}")) return null;
  const [head, ...rest] = template.split("{value}");
  const tail = rest.join("{value}");
  const fill = (part) => normalizeSpaces(String(part).replace(/\{subject\}/g, subjectText)).toLowerCase();
  const text = normalizeSpaces(answer).toLowerCase();
  const prefix = fill(head);
  const suffix = fill(tail);
  if (prefix && !text.startsWith(prefix)) return null;
  if (suffix && !text.endsWith(suffix)) return null;
  const end = suffix ? text.length - suffix.length : text.length;
  if (end <= prefix.length) return null;
  const span = stripEdges(text.slice(prefix.length, end).trim());
  return span || null;
}

// Why a recorded reply disagrees with a definitional computation, if it can be
// shown to be the reply's own error. Every reason is a claim the compiler checks
// on its own, so a reply is only set aside when there is a concrete reason to
// distrust it rather than a preference for the program.
function recordingFault(emitter, expected, subject, value) {
  const text = normalizeSpaces(expected);
  const subjectText = formatValue(subject);
  if (emitter.op === "truth") {
    const asserted = assertedPolarity(text);
    if (asserted !== null && asserted !== value) return "the reply's verdict contradicts the computed answer";
  }
  // A reply that quotes a different word than the request named is answering
  // about something else, and the compiler can say so instead of guessing.
  const quoted = text.match(/["'`]([^"'`]{1,60})["'`]/g) || [];
  if (quoted.length && !quoted.some((span) => alnum(span) && alnum(span) === alnum(subjectText))) {
    return "the reply is about a different word than the request named";
  }
  const branch = emitter.op === "truth" ? (value ? emitter.arg.true : emitter.arg.false) : emitter.op === "plain" ? "{value}" : emitter.arg?.template;
  const reported = reportedValue(branch, text, subjectText);
  if (reported !== null && alnum(reported) !== alnum(formatValue(value)) && !containsValue(reported, formatValue(value))) {
    return `the reply reports "${reported}" where the computation gives "${formatValue(value)}"`;
  }
  return null;
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
function phraseVariant(emitter, produced, expected, subject, value) {
  if (produced === undefined) return false;
  const valueText = formatValue(value);
  // Does the wording carry the computed value at all? A program whose sentence
  // reports a value can only accept a rephrasing that reports this value:
  // "The reverse of 'defg' is 'hello'." is not another way of saying "The
  // reverse of 'defg' is 'gfed'.".
  const template = typeof emitter.arg?.template === "string" ? emitter.arg.template : "";
  const branches = [emitter.arg?.true, emitter.arg?.false].filter((branch) => typeof branch === "string");
  const valueSlot = emitterReportsValue(emitter);
  if (typeof value === "string" && value.trim() && !valueSlot && !reportsValue(expected, value)) return false;
  // A rephrasing still has to report the value the program computed. When the
  // recorded reply names it and the produced sentence leaves it out, the wording
  // has been baked around one demonstrated answer instead of around the
  // computation: "The reverse of 'defg' is 'dcba'." is not another way of
  // saying "The reverse of 'defg' is 'gfed'.", whatever else the two sentences
  // share.
  if (valueText && reportsValue(expected, valueText) && !reportsValue(produced, valueText)) return false;
  if (valueSlot && !reportsValue(expected, valueText)) return false;
  // A boolean reply is a rephrasing when it asserts the same verdict, whatever
  // words it uses: "Madam is a palindrome." says what "Yes, \"madam\" is a
  // palindrome." says.
  if (emitter.op === "truth") {
    const asserted = assertedPolarity(expected);
    if (asserted !== null) return asserted === value;
  }
  // Otherwise the wording left after the subject and the value are removed has to
  // be the same wording. A paraphrase may leave wording out, but it may not
  // introduce content the recorded reply never carried: a sentence that asserts
  // a value nobody computed, because a demonstrated answer was baked into a
  // spare placeholder, is a different claim, not another way of wording one.
  // Affirmation and negation markers count as wording, since "Yes, X holds." and
  // "X holds." are the same claim.
  const a = residualTokens(produced, [subject, valueText]);
  const b = residualTokens(expected, [subject, valueText]);
  if (!a.size || !b.size) return false;
  for (const token of a) if (!b.has(token) && !WORDING_TOKENS.has(token)) return false;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared) >= 0.6;
}

// Wrap an emitter with the evidence for it. Every demonstration is either
// reproduced exactly, recognised as the same answer in different words, or
// accounted for as a faulty recording. For an operation whose value is fixed by
// the request itself, a disagreement can be shown to be the recorded reply's own
// error, so that reply is reported as a fault instead of blocking the
// computation. Everything else stays a contradiction.
// Whether an emitter claims to report a computed value, as opposed to choosing
// wording by outcome the way a boolean branch does.
function emitterReportsValue(emitter) {
  if (emitter.op === "plain") return true;
  const template = typeof emitter.arg?.template === "string" ? emitter.arg.template : "";
  const branches = [emitter.arg?.true, emitter.arg?.false].filter((branch) => typeof branch === "string");
  return template.includes("{value}") || branches.some((branch) => branch.includes("{value}"));
}

function withCoverage(emitter, inputs, subjects, values, answers, { definitional = false } = {}) {
  const verdicts = [];
  const faults = [];
  // A sentence only reproduces a recorded reply when the reply also reports the
  // value the computation produced. Otherwise a reply that echoed the request's
  // own word back as its answer could be reproduced perfectly by a template whose
  // two placeholders were swapped the wrong way round, and the program would then
  // read backwards on every fresh request.
  const mustReportValue = definitional && emitterReportsValue(emitter);
  values.forEach((value, i) => {
    const produced = emitAnswer(emitter, value, subjects[i]);
    // A sentence that states a number the program never derived does not
    // reproduce the computation, however exactly it matches the reply it was
    // read from. The check comes first so a reply cannot be reproduced by
    // copying a claim the program cannot make.
    if (!derivesEveryNumber(produced, value, inputs[i], subjects[i])) {
      verdicts.push("contradiction");
      return;
    }
    if (produced === answers[i] && (!mustReportValue || reportsValue(answers[i], formatValue(value)))) {
      verdicts.push("exact");
      return;
    }
    // A specific, checkable reason to distrust the recorded reply is reported as
    // such before the looser wording comparison, so the artifact says exactly
    // what was wrong with it rather than filing it as another phrasing.
    const reason = definitional ? recordingFault(emitter, answers[i], subjects[i], value) : null;
    if (reason) {
      verdicts.push("fault");
      faults.push({ input: inputs[i], output: answers[i], reason });
      return;
    }
    if (phraseVariant(emitter, produced, answers[i], formatValue(subjects[i]), value)) {
      verdicts.push("variant");
      return;
    }
    verdicts.push("contradiction");
  });
  const count = (kind) => verdicts.filter((verdict) => verdict === kind).length;
  const exactCount = count("exact");
  return {
    ...emitter,
    verdicts,
    faults,
    exactCount,
    variantCount: count("variant"),
    faultCount: count("fault"),
    contradictions: count("contradiction"),
    explainedCount: exactCount + count("variant") + count("fault"),
  };
}

// Emitter candidates are all scored against the demonstrations and the best
// evidence wins, instead of the first shape that happened to produce something.
// A wording that phrases every recorded reply beats one that only fits the reply
// it was read from, which is what lets a program answer for all of them.
function inferEmitter(inputs, subjects, values, answers, definitional = false) {
  const subjectStrings = subjects.map(formatValue);
  const valueStrings = values.map(formatValue);
  const candidates = [];
  const consider = (emitter) => {
    const scored = withCoverage(emitter, inputs, subjects, values, answers, { definitional });
    if (scored.explainedCount > 0) candidates.push(scored);
  };

  // 1. The answer is exactly the computed value.
  if (values.every((value, i) => formatValue(value) === answers[i])) consider({ op: "plain", arg: {} });

  // 2. Boolean predicate: different wording per truth value.
  if (values.every(isBool)) {
    // A reply's own Yes/No marker says which branch its wording belongs to. When
    // a reply contradicts the computed value, its sentence is still the phrasing
    // of the branch it claims, so the wording lands where it belongs instead of
    // teaching the program to answer backwards.
    const asserted = answers.map((answer) => assertedPolarity(answer));
    const trustAsserted = asserted.some((polarity, i) => polarity !== null && polarity !== values[i]);
    const branchOf = (i) => (trustAsserted && asserted[i] !== null ? asserted[i] : values[i]);
    const branches = { true: null, false: null };
    const support = { true: 0, false: 0 };
    const observed = { true: 0, false: 0 };
    let ok = true;
    for (const truth of [true, false]) {
      const indexes = values.map((value, i) => (branchOf(i) === truth ? i : -1)).filter((i) => i !== -1);
      observed[truth] = indexes.length;
      if (!indexes.length) continue;
      // A literal branch is not a computation. Rule programs must derive their
      // wording from the subject or the computed value, otherwise the search
      // would happily memorize one answer per demonstration. Tasks that really
      // do have literal answers compile as a verified lookup instead.
      const found = bestTemplate(indexes.map((i) => subjectStrings[i]), indexes.map((i) => answers[i]), "{subject}", {
        // Prefer wording that can be flipped for the unseen branch: "Yes, X is a
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
        consider({ op: "truth", arg: { true: branches.true, false: branches.false, derived, support, observed } });
      }
    }
  }

  // 3. The answer wraps the extracted subject.
  const subjectTemplate = bestTemplate(subjectStrings, answers, "{subject}");
  if (subjectTemplate) consider({ op: "template", arg: { template: subjectTemplate.template, support: subjectTemplate.support } });

  // 4. The answer wraps the computed value.
  const valueTemplate = bestTemplate(valueStrings, answers, "{value}", { needleFor: valueNeedle });
  if (valueTemplate) consider({ op: "template", arg: { template: valueTemplate.template, support: valueTemplate.support } });

  // 5. The answer carries both the subject and the value, in either order. Each
  // reply is a candidate skeleton, not only the ones that already fit every
  // other reply.
  for (let anchor = 0; anchor < Math.min(4, answers.length); anchor++) {
    const answer = answers[anchor];
    const subject = subjectStrings[anchor];
    // The value can sit anywhere in the sentence, and the reply that names the
    // subject usually names the value somewhere else in the same reply. Try the
    // value position, the quoted spans and the subject so both placeholders can
    // be found in one reply: "The reverse of 'abcd' is 'cba'." teaches
    // "The reverse of '{subject}' is '{value}'.".
    // The inner text of a quoted span, not the quotes themselves: replacing the
    // whole quoted span would take its quotation marks with it, and the wording
    // of the reply quotes that span.
    const quoted = [...String(answer).matchAll(/["'`]([^"'`]{1,60})["'`]/g)].map((match) => match[1]);
    // The request's own word goes into the {subject} slot first. A reply that
    // echoed that word as its answer ("The reverse of 'hello' is 'hello'.") would
    // otherwise build the template with the two placeholders swapped, because the
    // first substitution would claim the subject's occurrence for {value}.
    const subjectFirst = substitute(answer, subject, "{subject}");
    if (subjectFirst !== null && subjectFirst.includes("{subject}")) {
      for (const needle of [...new Set([valueNeedle(answer, valueStrings[anchor]), ...quoted, valueStrings[anchor]].filter(Boolean))]) {
        const withValue = substitute(subjectFirst, needle, "{value}");
        if (withValue === null || !withValue.includes("{value}")) continue;
        consider({ op: "template", arg: { template: withValue } });
      }
    }
    const needles = [...new Set([valueNeedle(answer, valueStrings[anchor]), ...quoted, subject].filter(Boolean))];
    for (const needle of needles) {
      const withValue = substitute(answer, needle, "{value}");
      if (withValue === null || !withValue.includes("{value}")) continue;
      if (!containsValue(withValue, subject)) continue;
      const withBoth = substitute(withValue, subject, "{subject}");
      if (withBoth === null || !withBoth.includes("{subject}")) continue;
      consider({ op: "template", arg: { template: withBoth } });
    }
  }

  if (!candidates.length) return null;
  // A branch-aware boolean program is preferred when it is as well supported as
  // a single-sentence template, because it can answer both outcomes.
  const kindRank = (emitter) => (emitter.op === "truth" ? 2 : emitter.op === "plain" ? 1 : 0);
  // Coverage first, then the kind of sentence, then simplicity. Exact agreement
  // is not compared here on its own: a template can agree with every reply
  // verbatim while actually being a memorised sentence, so agreement is judged
  // through the verdicts (a reply only counts as reproduced when the wording
  // says what the computation says) rather than as a separate score.
  candidates.sort((a, b) => a.contradictions - b.contradictions
    || b.explainedCount - a.explainedCount
    || kindRank(b) - kindRank(a)
    || costOf({ steps: [], emit: b }) - costOf({ steps: [], emit: a }));
  return candidates[0];
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
  "count-letters": { steps: ["length", "count"] },
  "count-vowels": { steps: ["countVowels"] },
  "count-consonants": { steps: ["countConsonants"] },
  "count-words": { steps: ["countWords"] },
  classify: { steps: ["equalsReversed", "containsLiteral", "startsWith", "endsWith", "isDigits", "isUpper", "isLower", "equalsLiteral"] },
  "count-items": { steps: ["length", "count", "countWords", "countVowels", "countChar", "digitSum"] },
};

// Operations whose answer is fixed by the request itself: reversing a string,
// testing whether it reads the same both ways, evaluating a written expression,
// counting the letters of a named span. For these the computation is the
// authority, so a recorded reply that disagrees is a model error rather than a
// second opinion about what the task is. Operations missing from this set are
// still steerable by their profile (classify and sequence lookups) but need
// their demonstrations to agree before a rule may be compiled from them.
const DEFINITIONAL_OPERATIONS = new Set([
  "check-palindrome",
  "reverse-text",
  "calculate-expression",
  "count-letters",
  "count-vowels",
  "count-consonants",
  "count-words",
]);

function affinityRank(program, profile) {
  const hint = AFFINITY_OPERATORS[profile.operation];
  if (!hint) return 0;
  if (hint.readers?.includes(program.read.op)) return 1;
  if (hint.steps?.some((step) => program.steps.some((candidate) => candidate.op === step))) return 1;
  return 0;
}

// Whether a candidate program actually performs the computation its request
// names, rather than merely reading the right span. "Reversing" a word has to
// reverse something: without this, a chain of incidental steps that happens to
// reproduce a recorded reply can be filed as the operation itself, which is how
// one demonstration used to produce an absurd but "clean" program.
function performsOperation(shape, profile) {
  const hint = AFFINITY_OPERATORS[profile.operation];
  if (!hint) return false;
  if (hint.readers?.includes(shape.read.op)) return true;
  return Boolean(hint.steps?.some((step) => shape.steps.some((candidate) => candidate.op === step)));
}

// Readers that take a span of the request as the subject. A definitional
// computation consumes a span (the word, the quoted string, the expression), not
// the whole sentence, so these are the readings it may be compiled from.
const SUBJECT_READERS = new Set([
  "firstWord", "lastWord", "quoted", "numberLast", "numberFirst", "expression", "ordinal",
  "wordBefore", "wordAfter", "restBefore", "restAfter",
]);

// How well a reader matches what the replies are actually about. `variety` counts
// how many different subjects the demonstrations produce: a reader that keeps
// returning the same word on every request is reading the request's own wording
// rather than the value the replies report. `agreement` counts how often a reply
// echoes the subject, using the span the reply itself quotes when it quotes one.
function readerEvidence(subjects, answers) {
  const texts = subjects.map(formatValue);
  const variety = new Set(texts.map((text) => text.toLowerCase())).size;
  // A subject made only of function words is a fragment of the request's wording
  // ("is hello a palindrome" read as "everything before hello" gives "is"), not
  // the value the reply reports about.
  const contentful = texts.every((text) => {
    const tokens = wordTokens(text);
    return !tokens.length || tokens.some((token) => !FILLER.has(token.toLowerCase()));
  });
  let agreement = 0;
  for (let i = 0; i < texts.length; i++) {
    const subject = texts[i];
    const quoted = String(answers[i]).match(/["'`]([^"'`]{1,60})["'`]/g);
    if (quoted) {
      if (quoted.some((span) => alnum(span) && alnum(span) === alnum(subject))) agreement += 1;
      continue;
    }
    if (containsValue(answers[i], subject)) agreement += 1;
  }
  return { variety, agreement, contentful, subjectLength: texts.join(" ").length };
}

// Preference between two candidate programs. Confidence first: a candidate that
// leaves demonstrations unaccounted for never wins. Then the operation the
// requests name, because a definitional operation is the task itself. Then how
// well the reader reads what the replies talk about, then how much of the
// evidence reproduces verbatim, then how many recorded replies had to be
// explained away, then simplicity.
function compareSolutions(a, b) {
  if (a.contradictions !== b.contradictions) return a.contradictions - b.contradictions;
  if (a.definitional !== b.definitional) return Number(b.definitional) - Number(a.definitional);
  if (a.definitional) {
    if (a.contentful !== b.contentful) return Number(b.contentful) - Number(a.contentful);
    if (a.variety !== b.variety) return b.variety - a.variety;
    if (a.agreement !== b.agreement) return b.agreement - a.agreement;
    // The reply reports the value the computation consumes, so the shortest
    // reading that still reads every request is the one it is about: a longer
    // span would carry request wording inside the value.
    if (a.subjectLength !== b.subjectLength) return a.subjectLength - b.subjectLength;
    // Simplicity decides between two readings of the same operation: an extra
    // step has to earn its place, because a step that flips the computed value
    // is usually what makes a recorded error look reproducible. Exact agreement
    // is deliberately not compared before this: a program can agree verbatim by
    // memorising one demonstrated sentence, which is exactly what the simpler
    // reading is allowed to beat.
    if (a.cost !== b.cost) return a.cost - b.cost;
  }
  if (a.exactCount !== b.exactCount) return b.exactCount - a.exactCount;
  if (a.variantCount !== b.variantCount) return b.variantCount - a.variantCount;
  if (a.faultCount !== b.faultCount) return a.faultCount - b.faultCount;
  if (a.affinity !== b.affinity) return b.affinity - a.affinity;
  return a.cost - b.cost;
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
    const inputs = pairs.map((pair) => pair.input);
    const queue = [{ steps: [], values: subjects, subjects }];
    let cursor = 0;
    while (cursor < queue.length && explored < budget) {
      const node = queue[cursor++];
      explored += 1;
      const shape = { read: root, steps: node.steps };
      const affinity = affinityRank(shape, profile);
      const definitional = affinity > 0 && DEFINITIONAL_OPERATIONS.has(profile.operation);
      const emit = inferEmitter(inputs, node.subjects, node.values, answers, definitional);
      if (emit) {
        solutions.push({
          read: root,
          steps: node.steps,
          emit,
          affinity,
          definitional,
          performs: performsOperation(shape, profile),
          ...readerEvidence(node.subjects, answers),
          cost: costOf({ steps: node.steps, emit }),
          exactCount: emit.exactCount,
          variantCount: emit.variantCount,
          faultCount: emit.faultCount,
          contradictions: emit.contradictions,
          explained: emit.explainedCount,
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
  solutions.sort(compareSolutions);
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
  // A rule may be compiled in three ways, in order of how much it takes on
  // trust.
  //
  //   clean       : reproduces every demonstration and sets none aside.
  //   authoritative: the requests name an operation with one definition, the
  //                 candidate computes exactly that, and every disagreeing reply
  //                 is a recorded error the compiler can point at (a verdict
  //                 that contradicts the computed answer, a reply about a
  //                 different word, or a value the computation never produces).
  //                 This is the difference between compiling the task the user
  //                 is repeating and compiling whatever a small model happened
  //                 to say, which is how a palindrome family used to end up as a
  //                 lookup that answered nothing.
  //   majority    : a strict majority of demonstrations support it and only
  //                 outliers disagree.
  //
  // Everything set aside is reported with the tool, never silently dropped.
  const seed = seedFrom(cleaned.map((pair) => pair.input).join("|"));
  // The authority of an operation only carries a cluster whose requests all name
  // that same operation, so a mixed cluster cannot be resolved by computing one
  // of the two tasks it contains.
  const oneOperation = cleaned.every((pair) => profileTask(pair.input).operation === profile.operation);
  // One demonstration does not identify a program: the same single reply can be
  // reproduced by an absurd chain of steps that happens to end in the right
  // characters. Two demonstrations that name different subjects are the minimum
  // evidence that identifies a rule, which is the same line leave-one-out
  // reports. Below it the verified lookup is the honest artifact.
  const minimumEvidence = (solution) => solution.variety >= 2;
  // When the request names an operation with one definition, the compiled rule
  // has to be that operation. This is the authority rule: the computation is the
  // task, so a rule that only reads the right span is not it. Families without a
  // definition keep their own evidence standard below.
  const definitionalCluster = (solution) => !DEFINITIONAL_OPERATIONS.has(profile.operation) || solution.performs;
  const isClean = (solution) => solution.contradictions === 0 && solution.faultCount === 0 && solution.exactCount >= 1;
  const isAuthoritative = (solution) => oneOperation
    && solution.definitional
    && solution.contentful
    && SUBJECT_READERS.has(solution.read.op)
    && solution.contradictions === 0
    && solution.explained === cleaned.length;
  const isMajority = (solution) => solution.faultCount === 0 && solution.contradictions > 0 && solution.exactCount >= 1 && solution.exactCount + solution.variantCount > solution.contradictions;
  const acceptable = (solution) => minimumEvidence(solution)
    && definitionalCluster(solution)
    && (isClean(solution) || isAuthoritative(solution) || isMajority(solution));
  // The ranked list decides, so the most confident acceptable program wins even
  // when a lower ranked one would satisfy a stricter tier.
  const rule = search.solutions.find((solution) => acceptable(solution) && respondsToInput(solution, seed));
  let program = null;
  if (rule) {
    program = { version: 1, family: "rule", read: rule.read, steps: rule.steps, emit: rule.emit };
    const outliers = (rule.emit.faults || []).concat((rule.emit.verdicts || []).map((verdict, i) => (verdict === "contradiction" ? cleaned[i] : null)).filter(Boolean));
    program.coverage = {
      demonstrations: cleaned.length,
      exact: rule.exactCount,
      variants: rule.variantCount,
      faults: rule.faultCount,
      explained: rule.explained,
      contradictions: rule.contradictions,
      authority: rule.definitional === true && rule.faultCount > 0,
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
      program.coverage = {
        demonstrations: cleaned.length,
        exact: cleaned.length,
        variants: 0,
        explained: cleaned.length,
        contradictions: 0,
        disagreements,
        closestPath: closest ? programPath({ read: closest.read, steps: closest.steps, emit: closest.emit }) : null,
        // A family that names a decidable computation reached the lookup fallback
        // only because one request was ever repeated: one demonstration cannot
        // identify a program, so the recorded reply is answered and nothing more
        // is claimed about it.
        singleDemonstration: cleaned.length < 2 && DEFINITIONAL_OPERATIONS.has(profile.operation),
      };
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
  // A program has to answer more than one way across its own in-domain requests.
  // The check is deliberately generous: the ranking already prefers the simplest
  // computation, so this only rules out a program that recites a single line.
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

// A monotonic clock with sub-millisecond resolution, so a program that executes
// locally reports how long it really took instead of rounding every run to 0ms.
// The wall clock is the fallback where the performance API is unavailable.
function now() {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

function elapsedFrom(startedAt) {
  return Math.round((now() - startedAt) * 1000) / 1000;
}

function executeProgram(program, input) {
  const startedAt = now();
  const trace = [];
  const reader = READERS[program.read.op];
  if (!reader) return { ok: false, reason: "unknown reader", ms: elapsedFrom(startedAt), trace };
  const subject = reader.run(input, program.read.arg || {});
  if (subject === undefined) {
    return { ok: false, reason: "the request does not match this program's input pattern", ms: elapsedFrom(startedAt), trace: [`read: ${readerLabel(program.read)} -> no match`] };
  }
  trace.push(`read: ${readerLabel(program.read)} -> ${formatValue(subject)}`);
  let value = subject;
  for (const step of program.steps) {
    const spec = STEPS[step.op];
    if (!spec) return { ok: false, reason: `unknown step ${step.op}`, ms: elapsedFrom(startedAt), trace };
    const next = spec.run(value, step.arg || {});
    if (next === undefined) {
      return { ok: false, reason: `step failed: ${stepLabel(step)}`, ms: elapsedFrom(startedAt), trace };
    }
    value = next;
    trace.push(`step: ${stepLabel(step)} -> ${formatValue(value)}`);
  }
  const text = emitAnswer(program.emit, value, subject);
  if (text === undefined) {
    return { ok: false, reason: program.emit.op === "table" ? "this program has no verified answer for that input" : "no answer branch matched for that input", ms: elapsedFrom(startedAt), trace };
  }
  trace.push(`emit: ${emitterLabel(program.emit)}`);
  // The subject and the computed value come back with the answer so the same
  // evidence rule that chose the wording can be re-checked against a program
  // that was saved earlier (see misdeclaredNumbers).
  return { ok: true, text: normalizeSpaces(text), ms: elapsedFrom(startedAt), trace, path: programPath(program), subject, value };
}

// Re-checks a stored program against its own recorded demonstrations: every
// number it answers with has to be derived from that request or from the value
// the program computed. A rule saved by an earlier build that only reproduced a
// reply by copying a number out of it fails here, which is what stops a stale
// program from answering fresh requests with a fact it never established. A
// verified lookup is exempt on purpose: repeating its recorded answers and
// declining anything else is exactly what it is for.
function misdeclaredNumbers(program, demonstrations) {
  if (!program || program.emit?.op === "table") return [];
  return demonstrations
    .filter((pair) => {
      const run = executeProgram(program, pair.input);
      return run.ok && !derivesEveryNumber(run.text, run.value, pair.input, run.subject);
    })
    .map((pair) => pair.input);
}

// How the program answers, in a phrase that reads correctly after the steps and
// after an arrow in the compiled path. The recorded sentences themselves are not
// pasted in here: they are shown with the demonstrations they came from, where
// they can be read, instead of inflating one line of registry copy.
function emitterLabel(emit) {
  switch (emit.op) {
    case "plain":
      return "returns the computed value";
    case "literal":
      return "returns the recorded answer";
    case "template":
      return "fills in the recorded wording";
    case "truth":
      return "chooses between the recorded wordings";
    case "table":
      return `looks the answer up among the ${Object.keys(emit.arg.map).length} recorded answers`;
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
  // A fold trains on every demonstration except one. With two demonstrations that
  // leaves a single training example, and many programs fit one example, so the
  // measurement would describe the sample size rather than the program. Say so
  // instead of publishing a number that means nothing.
  if (pairs.length < 3) {
    return {
      folds: pairs.length,
      passed: 0,
      computed: 0,
      measured: 0,
      note: "leave-one-out needs at least three demonstrations, because a single training demonstration does not identify a task",
    };
  }
  let passed = 0;
  let computed = 0;
  for (let i = 0; i < pairs.length; i++) {
    const training = pairs.filter((_, index) => index !== i);
    const compiled = compileProgram(training, profile);
    if (!compiled.program) continue;
    const run = executeProgram(compiled.program, pairs[i].input);
    if (!run.ok) continue;
    // `computed` counts the folds where a program compiled from the other
    // demonstrations answered this one at all. `passed` additionally requires the
    // recorded wording, which a model error can never satisfy.
    computed += 1;
    if (normalizeSpaces(run.text) === normalizeSpaces(pairs[i].output)) passed += 1;
  }
  return { folds: pairs.length, passed, computed, measured: pairs.length };
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

// The registry line for a program: what it reads, what it does with it, and how
// it answers. It is assembled from the same operation descriptions the runtime
// traces, so it describes the program that is actually stored rather than a
// summary written somewhere else that could drift away from it. It stays short
// because a long chain of steps is summarised by how many of them there are.
// Everything here is derived from the program, so it works the same way for any
// task the compiler can compile.
const MAX_LISTED_STEPS = 3;

function specificationFor(program) {
  const steps = program.steps.map(stepLabel);
  const listed = steps.slice(0, MAX_LISTED_STEPS);
  const remaining = steps.length - listed.length;
  if (remaining > 0) listed.push(`applies ${remaining} more step${remaining === 1 ? "" : "s"}`);
  const chain = [...listed, emitterLabel(program.emit)].join(", then ");
  return `Reads ${readerLabel(program.read)}, then ${chain}.`;
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
  misdeclaredNumbers,
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
