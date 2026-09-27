// Recur's acceptance head: a tiny neural network trained locally at compile
// time. It answers one question about a new request: is this inside the input
// distribution this program was compiled from? The symbolic program does the
// work; the head decides whether a match is close enough to be worth offering
// the user, so a program is never pushed at a request it only vaguely fits.
//
// Everything here is deterministic, dependency free, and runs in microseconds:
// no model calls, no network, no floating point surprises across runs.

import { embed, DIM } from "./embeddings.js";

const SPARSE_FLOOR = 0.004;

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

function gaussian(random) {
  let u = 0;
  let v = 0;
  while (u === 0) u = random();
  while (v === 0) v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function normalize(vector) {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  return vector.map((value) => value / norm);
}

function round(value, places = 4) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

// Training walks dense weight rows; execution walks the compact sparse rows that
// are stored in the compiled artifact. Both compute the same function.
function forwardDense(model, vector) {
  const hidden = new Array(model.hidden).fill(0);
  for (let unit = 0; unit < model.hidden; unit++) {
    const row = model.w1[unit];
    let sum = model.b1[unit];
    for (let index = 0; index < DIM; index++) {
      const feature = vector[index];
      if (feature !== 0) sum += row[index] * feature;
    }
    hidden[unit] = Math.tanh(sum);
  }
  let output = model.b2;
  for (let unit = 0; unit < model.hidden; unit++) output += model.w2[unit] * hidden[unit];
  return { hidden, output };
}

function forward(model, vector) {
  const hidden = new Array(model.hidden).fill(0);
  for (let unit = 0; unit < model.hidden; unit++) {
    let sum = model.b1[unit];
    const row = model.w1[unit];
    if (Array.isArray(row[0])) {
      for (const [index, weight] of row) sum += weight * (vector[index] || 0);
    } else {
      for (let index = 0; index < DIM; index++) {
        const feature = vector[index];
        if (feature !== 0) sum += row[index] * feature;
      }
    }
    hidden[unit] = Math.tanh(sum);
  }
  let output = model.b2;
  for (let unit = 0; unit < model.hidden; unit++) output += model.w2[unit] * hidden[unit];
  return { hidden, output };
}

function sigmoid(x) {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const e = Math.exp(x);
  return e / (1 + e);
}

// Balanced, deterministic train/holdout split. The holdout accuracy is reported
// as-is, including when the sample is too small to be flattering.
function splitDataset(features, labels, seed, holdoutRatio = 0.25) {
  const order = features.map((_, index) => index);
  const random = mulberry32(seed);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const byLabel = { 0: [], 1: [] };
  for (const index of order) byLabel[labels[index]].push(index);
  const holdout = [];
  for (const label of ["0", "1"]) {
    const list = byLabel[label];
    const take = Math.min(list.length - 1, Math.max(1, Math.round(list.length * holdoutRatio)));
    if (take > 0) holdout.push(...list.slice(0, take));
  }
  const holdoutSet = new Set(holdout);
  const train = order.filter((index) => !holdoutSet.has(index));
  return { train, holdout, random };
}

function balanced(rows, labels, random) {
  const positives = rows.filter((_, i) => labels[i] === 1);
  const negatives = rows.filter((_, i) => labels[i] === 0);
  if (!positives.length || !negatives.length) return { rows, labels };
  const target = Math.max(positives.length, negatives.length);
  const expand = (list, label) => {
    const out = [];
    while (out.length < target) for (const row of list) out.push({ row, label });
    return out;
  };
  const mixed = [...expand(positives, 1), ...expand(negatives, 0)];
  for (let i = mixed.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [mixed[i], mixed[j]] = [mixed[j], mixed[i]];
  }
  return { rows: mixed.map((item) => item.row), labels: mixed.map((item) => item.label) };
}

// The head decides for itself where its own boundary sits: the threshold that
// best separates the examples it learned from is stored in the artifact, so an
// uncalibrated constant is never the thing that blocks a program.
function separatingThreshold(model, rows, labels) {
  if (!rows.length) return 0.5;
  const scored = rows.map((row, index) => ({ score: sigmoid(forward(model, row).output), label: labels[index] }));
  const candidates = [...new Set([0.05, 0.2, 0.35, 0.5, ...scored.map((item) => item.score)])].sort((a, b) => a - b);
  let best = { threshold: 0.5, balancedAccuracy: 0 };
  for (const threshold of candidates) {
    let positivesRight = 0;
    let positivesSeen = 0;
    let negativesRight = 0;
    let negativesSeen = 0;
    for (const item of scored) {
      const predicted = item.score >= threshold ? 1 : 0;
      if (item.label === 1) {
        positivesSeen += 1;
        if (predicted === 1) positivesRight += 1;
      } else {
        negativesSeen += 1;
        if (predicted === 0) negativesRight += 1;
      }
    }
    const sensitivity = positivesSeen ? positivesRight / positivesSeen : 0;
    const specificity = negativesSeen ? negativesRight / negativesSeen : 1;
    const balancedAccuracy = (sensitivity + specificity) / 2;
    if (balancedAccuracy > best.balancedAccuracy) best = { threshold, balancedAccuracy };
  }
  return best;
}

function accuracy(model, rows, labels) {
  if (!rows.length) return null;
  let correct = 0;
  for (let i = 0; i < rows.length; i++) {
    const score = sigmoid(forward(model, rows[i]).output);
    if ((score >= 0.5 ? 1 : 0) === labels[i]) correct += 1;
  }
  return round(correct / rows.length, 3);
}

function trainAcceptanceGate({ positives, negatives, hidden = 12, epochs = 420, lr = 0.6, momentum = 0.9, l2 = 2e-4, seed = 1337 }) {
  const positiveTexts = [...new Set(positives.map((text) => String(text || "").trim()).filter(Boolean))];
  const negativeTexts = [...new Set(negatives.map((text) => String(text || "").trim()).filter(Boolean))];
  if (!positiveTexts.length) return null;

  const rows = [...positiveTexts, ...negativeTexts].map((text) => normalize(embed(text)));
  const labels = [...positiveTexts.map(() => 1), ...negativeTexts.map(() => 0)];
  const { train, holdout, random } = splitDataset(rows, labels, seed);
  const balancedSet = balanced(train.map((index) => rows[index]), train.map((index) => labels[index]), random);
  const trainRows = balancedSet.rows;
  const trainLabels = balancedSet.labels;

  const init = mulberry32(seed);
  const model = {
    hidden,
    w1: Array.from({ length: hidden }, () => Array.from({ length: DIM }, () => round(gaussian(init) * 0.12, 4))),
    b1: new Array(hidden).fill(0),
    w2: Array.from({ length: hidden }, () => round(gaussian(init) * 0.12, 4)),
    b2: 0,
  };
  const velocity = {
    w1: model.w1.map((row) => row.map(() => 0)),
    b1: new Array(hidden).fill(0),
    w2: new Array(hidden).fill(0),
    b2: 0,
  };

  let loss = 0;
  for (let epoch = 0; epoch < epochs; epoch++) {
    const gw1 = model.w1.map((row) => row.map(() => 0));
    const gb1 = new Array(hidden).fill(0);
    const gw2 = new Array(hidden).fill(0);
    let gb2 = 0;
    loss = 0;
    for (let row = 0; row < trainRows.length; row++) {
      const vector = trainRows[row];
      const label = trainLabels[row];
      const { hidden: activations, output } = forwardDense(model, vector);
      const probability = sigmoid(output);
      const clamped = Math.min(1 - 1e-9, Math.max(1e-9, probability));
      loss += -(label * Math.log(clamped) + (1 - label) * Math.log(1 - clamped));
      const dOutput = probability - label;
      for (let unit = 0; unit < hidden; unit++) {
        gw2[unit] += dOutput * activations[unit];
        const delta = dOutput * model.w2[unit] * (1 - activations[unit] * activations[unit]);
        gb1[unit] += delta;
        const gradRow = gw1[unit];
        for (let index = 0; index < DIM; index++) {
          const feature = vector[index];
          if (feature !== 0) gradRow[index] += delta * feature;
        }
      }
      gb2 += dOutput;
    }
    const scale = 1 / Math.max(1, trainRows.length);
    for (let unit = 0; unit < hidden; unit++) {
      for (let index = 0; index < DIM; index++) {
        const grad = gw1[unit][index] * scale + l2 * model.w1[unit][index];
        if (grad === 0) continue;
        velocity.w1[unit][index] = momentum * velocity.w1[unit][index] - lr * grad;
        model.w1[unit][index] += velocity.w1[unit][index];
      }
      const gradBias = gb1[unit] * scale;
      velocity.b1[unit] = momentum * velocity.b1[unit] - lr * gradBias;
      model.b1[unit] += velocity.b1[unit];
      const gradOut = gw2[unit] * scale + l2 * model.w2[unit];
      velocity.w2[unit] = momentum * velocity.w2[unit] - lr * gradOut;
      model.w2[unit] += velocity.w2[unit];
    }
    const gradB2 = gb2 * scale;
    velocity.b2 = momentum * velocity.b2 - lr * gradB2;
    model.b2 += velocity.b2;
  }

  // Store the input layer sparsely: most of the 256 hashed features never fire,
  // so dropping negligible weights keeps the compiled artifact small without
  // changing any prediction that matters.
  let storedWeights = 0;
  const w1 = model.w1.map((row) => {
    const pairs = [];
    for (let index = 0; index < DIM; index++) {
      const value = row[index];
      if (Math.abs(value) < SPARSE_FLOOR) continue;
      pairs.push([index, round(value, 4)]);
    }
    storedWeights += pairs.length;
    return pairs;
  });

  const compiled = {
    version: 1,
    kind: "acceptance-head",
    featureDim: DIM,
    hidden,
    w1,
    b1: model.b1.map((value) => round(value, 4)),
    w2: model.w2.map((value) => round(value, 4)),
    b2: round(model.b2, 4),
    weights: storedWeights + hidden * 2 + 1,
    stats: {},
  };
  // Keep the learned boundary permissive: the similarity matcher is the primary
  // gate, and the head exists to catch requests that are clearly a different
  // kind of task.
  const separation = separatingThreshold(compiled, trainRows, trainLabels);
  compiled.threshold = round(Math.min(0.6, Math.max(0.1, separation.threshold)), 3);
  compiled.stats = {
    positives: positiveTexts.length,
    negatives: negativeTexts.length,
    epochs,
    loss: round(loss / Math.max(1, trainRows.length), 4),
    trainAccuracy: accuracy(compiled, trainRows, trainLabels),
    holdoutAccuracy: accuracy(compiled, holdout.map((index) => rows[index]), holdout.map((index) => labels[index])),
    holdoutSize: holdout.length,
    balancedAccuracy: round(separation.balancedAccuracy, 3),
  };
  return compiled;
}

// Activation in [0, 1] for a request, or 1 when no head is attached so that an
// uncalibrated model can never block a program on its own.
function gateActivation(model, vector) {
  if (!model || !Array.isArray(model.w1)) return 1;
  return sigmoid(forward(model, vector).output);
}

function gateScore(model, text) {
  if (!model) return 1;
  return gateActivation(model, normalize(embed(text)));
}

export { trainAcceptanceGate, gateActivation, gateScore, SPARSE_FLOOR, separatingThreshold };
