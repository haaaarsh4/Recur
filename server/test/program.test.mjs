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
  assert.match(specificationFor(program), /palindrome/i);
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

test("a contradictory demonstration stops a program from compiling", () => {
  const pairs = [
    { input: "is civic a palindrome", output: 'Yes, "civic" is a palindrome.' },
    { input: "is madam a palindrome", output: 'No, "madam" is not a palindrome.' },
  ];
  const result = compileProgram(pairs, profileTask(pairs[0].input));
  // The two answers disagree about the same computation, so nothing generalizes
  // and the task is compiled as a verified lookup instead.
  assert.equal(result.program.family, "table");
  assert.deepEqual(answers(result.program, ["is civic a palindrome"]), ['Yes, "civic" is a palindrome.']);
});

test("keeps the computation and reports the answer that disagreed with it", () => {
  // A small model will happily claim that racecar is not a palindrome. The
  // property is decidable, so the majority stands, the compiler computes rather
  // than recalls, and the outlier is recorded on the tool instead of vanishing.
  const pairs = [
    { input: "is civic a palindrome", output: 'Yes, "civic" is a palindrome.' },
    { input: "is madam a palindrome", output: 'Yes, "madam" is a palindrome.' },
    { input: "is racecar a palindrome", output: 'No, "racecar" is not a palindrome.' },
  ];
  const program = compile(pairs);
  assert.equal(program.family, "rule");
  assert.equal(program.coverage.contradictions, 1);
  assert.deepEqual(program.coverage.outliers, [{ input: "is racecar a palindrome", output: 'No, "racecar" is not a palindrome.' }]);
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
