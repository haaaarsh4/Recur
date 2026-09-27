// Verifies the compiler and runtime: programs are synthesized from
// demonstrations, then executed deterministically on new inputs.
//
// Run with: npm --prefix server test

import test from "node:test";
import assert from "node:assert/strict";
import { profileTask } from "../src/embeddings.js";
import { compileProgram, executeProgram, gradeProgram, leaveOneOut, stressTest, nameProgram, specificationFor } from "../src/program.js";
import { trainAcceptanceGate, gateScore } from "../src/neural.js";

function compile(pairs, firstInput = pairs[0].input) {
  const result = compileProgram(pairs, profileTask(firstInput));
  assert.ok(result.program, `expected a compiled program: ${result.reason || ""}`);
  return result.program;
}

function answers(program, inputs) {
  return inputs.map((input) => {
    const run = executeProgram(program, input);
    assert.ok(run.ok, `program declined ${JSON.stringify(input)}: ${run.reason}`);
    return run.text;
  });
}

test("compiles a palindrome checker and answers fresh words", () => {
  const program = compile([
    { input: "is civic a palindrome", output: 'Yes, "civic" is a palindrome.' },
    { input: "check madam as a palindrome", output: 'Yes, "madam" is a palindrome.' },
  ]);
  assert.equal(program.emit.op, "truth");
  assert.deepEqual(answers(program, ["is racecar a palindrome", "check kayak as a palindrome"]), [
    'Yes, "racecar" is a palindrome.',
    'Yes, "kayak" is a palindrome.',
  ]);
  // Both demonstrations only showed the true branch; the opposite wording is
  // derived by the documented counterpart transform over the observed template.
  assert.deepEqual(answers(program, ["is hello a palindrome"]), ['No, "hello" is not a palindrome.']);
  assert.equal(nameProgram(program, profileTask("is civic a palindrome")), "palindrome-checker");
  assert.match(specificationFor(program), /reads the same way backwards/);
});

test("describes a program in one short sentence about what it runs", () => {
  const program = compile([
    { input: "is civic a palindrome", output: 'Yes, "civic" is a palindrome.' },
    { input: "is madam a palindrome", output: 'Yes, "madam" is a palindrome.' },
  ]);
  const specification = specificationFor(program);
  // Short enough to scan in a registry row, and it reads as a sentence rather
  // than as a dump of the program's operations.
  assert.ok(specification.length <= 140, specification);
  assert.match(specification, /^Reads .+, then .+\.$/);
  assert.ok(!/[{}]/.test(specification), specification);
  assert.ok(!/select wording|true\/false|apply the contract/.test(specification), specification);
  assert.ok(!/\.\./.test(specification), specification);
});

test("never compiles wording that states a number the computation did not produce", () => {
  // A small model answered these three requests with a verdict about the
  // position "the 7th number", which nothing computes: the requests ask whether
  // a number is in the series and what the tenth element is. Whatever the
  // compiler does with evidence like that, it may not end up asserting a
  // position of its own.
  const pairs = [
    { input: "is 12 in the fibonacci series", output: "Yes, 12 is the 7th number in the Fibonacci series." },
    { input: "what is the 10th element in the Fibonacci series", output: "The 10th element in the Fibonacci series is 55." },
    { input: "is 10 in the fibonacci series", output: "Yes, 10 is the 7th number in the Fibonacci sequence." },
  ];
  const result = compileProgram(pairs, profileTask(pairs[0].input));
  assert.ok(result.program, result.reason);
  for (const probe of ["is 7 in the fibonacci series", "is 55 in the fibonacci series", "what is the 12th element in the Fibonacci series"]) {
    const run = executeProgram(result.program, probe);
    if (!run.ok) continue; // declining is always allowed
    assert.ok(!/\b7th\b/.test(run.text), `fabricated a position for ${probe}: ${run.text}`);
  }
  // The wording it can keep is the wording the request itself supplies.
  const fresh = executeProgram(result.program, "is 3 in the fibonacci series");
  assert.ok(!fresh.ok, `a request outside the recorded answers should decline, got ${fresh.text}`);
});

test("learns both boolean branches when both were observed", () => {
  const program = compile([
    { input: "is civic a palindrome", output: 'Yes, "civic" is a palindrome.' },
    { input: "is hello a palindrome", output: 'No, "hello" is not a palindrome.' },
    { input: "is madam a palindrome", output: 'Yes, "madam" is a palindrome.' },
  ]);
  assert.deepEqual(answers(program, ["is radar a palindrome", "is zebra a palindrome"]), [
    'Yes, "radar" is a palindrome.',
    'No, "zebra" is not a palindrome.',
  ]);
});

test("evaluates arithmetic instead of recalling it", () => {
  const program = compile([
    { input: "what is 2 plus 2", output: "4" },
    { input: "what is 1+1", output: "2" },
  ]);
  assert.equal(program.emit.op, "plain");
  assert.deepEqual(answers(program, ["what is 10 times 3", "what is 7 - 2", "what is (3+4)*2"]), ["30", "5", "14"]);
});

test("normalizes inconsistent wording from the answers it was given", () => {
  // Exactly what a small local model does: the same answer phrased differently
  // in each reply. One of the two is reproduced exactly, the other is
  // recognised as the same answer, and the compiled program still checks
  // palindrome-ness instead of parroting a sentence.
  const pairs = [
    { input: "is civic a palindrome", output: 'Yes, "civic" is a palindrome.' },
    { input: "check madam as a palindrome", output: "Madam is a palindrome." },
  ];
  const program = compile(pairs);
  assert.equal(program.emit.op, "truth");
  assert.equal(program.coverage.exact, 1);
  assert.equal(program.coverage.variants, 1);
  assert.equal(program.coverage.explained, 2);
  assert.deepEqual(answers(program, ["is racecar a palindrome", "is zebra a palindrome"]), [
    'Yes, "racecar" is a palindrome.',
    'No, "zebra" is not a palindrome.',
  ]);
});

test("a reply that contradicts a decidable computation is recorded, not obeyed", () => {
  // madam reads the same both ways, so the second reply is simply wrong. The
  // property is decidable, so the computation stands, the reply is reported as a
  // recorded model error, and the program answers the request correctly instead
  // of the family collapsing into a lookup that can answer nothing.
  const pairs = [
    { input: "is civic a palindrome", output: 'Yes, "civic" is a palindrome.' },
    { input: "is madam a palindrome", output: 'No, "madam" is not a palindrome.' },
  ];
  const program = compile(pairs);
  assert.equal(program.family, "rule");
  assert.equal(program.coverage.authority, true);
  assert.equal(program.coverage.faults, 1);
  assert.match(program.coverage.outliers[0].reason, /verdict contradicts/);
  assert.deepEqual(answers(program, ["is madam a palindrome", "is zebra a palindrome"]), [
    'Yes, "madam" is a palindrome.',
    'No, "zebra" is not a palindrome.',
  ]);
});

test("conflicting replies about a task with no rule still do not compile", () => {
  const pairs = [
    { input: "what is the capital of france", output: "Paris" },
    { input: "what is the capital of france", output: "Lyon" },
  ];
  const result = compileProgram(pairs, profileTask(pairs[0].input));
  assert.equal(result.program, null);
  assert.match(result.reason, /do not share one deterministic computation/);
});

test("compiles a correct reverser even when every recorded reply got it wrong", () => {
  // A small model reverses "abcd" to "cba", "defg" to "gfde" and echoes
  // "hello" back unchanged. Reversal is decidable, so the program computes the
  // answer and each reply is recorded with the value it got wrong.
  const pairs = [
    { input: "whats the reverse of 'abcd'", output: "The reverse of 'abcd' is 'cba'." },
    { input: "whats the reverse of 'defg'", output: "The reverse of 'defg' is 'gfde'." },
    { input: "whats the reverse of 'hello'", output: "The reverse of 'hello' is 'hello'." },
    { input: "whats the reverse of 'king'", output: "The reverse of 'king' is 'king'." },
  ];
  const program = compile(pairs);
  assert.equal(program.family, "rule");
  assert.equal(program.coverage.faults, 4);
  assert.match(program.coverage.outliers[0].reason, /computation gives/);
  assert.deepEqual(answers(program, ["whats the reverse of 'zebra'", "whats the reverse of 'civic'"]), [
    "The reverse of 'zebra' is 'arbez'.",
    "The reverse of 'civic' is 'civic'.",
  ]);
});

test("keeps the computation and reports the answer that disagreed with it", () => {
  // A small model will happily claim that racecar is not a palindrome. The
  // property is decidable, so the computation stands, the compiler computes
  // rather than recalls, and the reply is recorded on the tool instead of
  // vanishing.
  const pairs = [
    { input: "is civic a palindrome", output: 'Yes, "civic" is a palindrome.' },
    { input: "is madam a palindrome", output: 'Yes, "madam" is a palindrome.' },
    { input: "is racecar a palindrome", output: 'No, "racecar" is not a palindrome.' },
  ];
  const program = compile(pairs);
  assert.equal(program.family, "rule");
  assert.equal(program.coverage.contradictions, 0);
  assert.equal(program.coverage.faults, 1);
  assert.deepEqual(program.coverage.outliers, [{ input: "is racecar a palindrome", output: 'No, "racecar" is not a palindrome.', reason: "the reply's verdict contradicts the computed answer" }]);
  assert.deepEqual(answers(program, ["is racecar a palindrome", "is kayak a palindrome", "is zebra a palindrome"]), [
    'Yes, "racecar" is a palindrome.',
    'Yes, "kayak" is a palindrome.',
    'No, "zebra" is not a palindrome.',
  ]);
});

test("compiles string transforms", () => {
  const reverse = compile([
    { input: "reverse hello", output: "olleh" },
    { input: "reverse world", output: "dlrow" },
  ]);
  assert.deepEqual(answers(reverse, ["reverse abc"]), ["cba"]);

  const upper = compile([
    { input: "uppercase hello", output: "HELLO" },
    { input: "uppercase world", output: "WORLD" },
  ]);
  assert.deepEqual(answers(upper, ["uppercase qwerty"]), ["QWERTY"]);
});

test("counts from the request rather than from a table", () => {
  const letters = compile([
    { input: "how many letters are in strawberry", output: "10" },
    { input: "how many letters are in banana", output: "6" },
  ]);
  assert.deepEqual(answers(letters, ["how many letters are in kiwi"]), ["4"]);

  const vowels = compile([
    { input: "how many vowels are in banana", output: "3" },
    { input: "how many vowels are in strawberry", output: "2" },
  ]);
  assert.deepEqual(answers(vowels, ["how many vowels are in kiwi"]), ["2"]);
});

test("computes sequence values at unseen positions", () => {
  const program = compile([
    { input: "what is the 8th fibonacci number", output: "21" },
    { input: "what is the 10th fibonacci number", output: "55" },
  ]);
  assert.deepEqual(answers(program, ["what is the 12th fibonacci number", "what is the 5th fibonacci number"]), ["144", "5"]);
});

test("falls back to a verified lookup table when nothing generalizes", () => {
  const pairs = [
    { input: "what is the capital of france", output: "Paris" },
    { input: "what is the capital of japan", output: "Tokyo" },
  ];
  const program = compile(pairs);
  assert.equal(program.family, "table");
  assert.deepEqual(answers(program, ["what is the capital of france"]), ["Paris"]);
  const unknown = executeProgram(program, "what is the capital of nowhere");
  assert.equal(unknown.ok, false);
});

test("reports exact consistency and honest generalization", () => {
  const pairs = [
    { input: "is civic a palindrome", output: 'Yes, "civic" is a palindrome.' },
    { input: "is madam a palindrome", output: 'Yes, "madam" is a palindrome.' },
    { input: "is racecar a palindrome", output: 'Yes, "racecar" is a palindrome.' },
  ];
  const program = compile(pairs);
  const grade = gradeProgram(program, pairs);
  assert.equal(grade.consistency, 1);
  const loo = leaveOneOut(pairs, profileTask(pairs[0].input));
  assert.equal(loo.folds, 3);
  assert.equal(loo.passed, 3);

  const stress = stressTest(program, 1234);
  assert.equal(stress.crashes, 0);
  assert.equal(stress.deterministic, stress.cases);
  assert.ok(stress.executed > 0);

  // A lookup table cannot generalize, and the metric says so instead of
  // pretending otherwise.
  const tablePairs = [
    { input: "what is the capital of france", output: "Paris" },
    { input: "what is the capital of japan", output: "Tokyo" },
  ];
  const tableLoo = leaveOneOut(tablePairs, profileTask(tablePairs[0].input));
  assert.equal(tableLoo.passed, 0);
});

test("programs are pure: same input, same output, no state", () => {
  const program = compile([
    { input: "is civic a palindrome", output: 'Yes, "civic" is a palindrome.' },
    { input: "check madam as a palindrome", output: 'Yes, "madam" is a palindrome.' },
  ]);
  const first = executeProgram(program, "is level a palindrome");
  const second = executeProgram(program, "is level a palindrome");
  assert.equal(first.text, second.text);
  assert.ok(first.trace.length >= 2);
});

test("acceptance head is trained locally and separates task families", () => {
  const model = trainAcceptanceGate({
    positives: [
      "is civic a palindrome",
      "is racecar a palindrome",
      "check madam as a palindrome",
      "is level a palindrome",
      "verify kayak as a palindrome",
    ],
    negatives: [
      "what is the capital of france",
      "explain photosynthesis in simple terms",
      "write a poem about the ocean",
      "what is 12 times 4",
      "summarize this article",
      "debug my python function",
    ],
    seed: 4242,
  });
  assert.ok(model, "expected a trained head");
  assert.ok(model.stats.trainAccuracy >= 0.8, `train accuracy was ${model.stats.trainAccuracy}`);
  const inFamily = gateScore(model, "is rotator a palindrome");
  const outOfFamily = gateScore(model, "explain photosynthesis in simple terms");
  assert.ok(inFamily > outOfFamily, `expected ${inFamily} > ${outOfFamily}`);
  // No head attached means no gate: it can never block a program.
  assert.equal(gateScore(null, "anything"), 1);
});
