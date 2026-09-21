// Lightweight, dependency-free text embeddings used to decide whether two
// tasks are "the same kind of thing". Not a trained model: a hashed
// bag-of-words + character bigram vector, cosine-compared. Cheap, fast,
// deterministic, and good enough to cluster short task descriptions.

const DIM = 192;

const STOP = new Set(
  ("a an the is are was were be been being this that these those to of in on for with and or but " +
    "if then so as at by from into it its it's i you your my our their his her do does did can could " +
    "should would will shall not no yes please just very really about"
  ).split(" ")
);

function tokenize(text) {
  return (text.toLowerCase().match(/[a-z0-9']+/g) || []).filter((t) => t.length > 1 && !STOP.has(t));
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
  for (let i = 0; i < toks.length - 1; i++) v[hashToken(toks[i] + "_" + toks[i + 1])] += 0.6;
  let norm = 0;
  for (let i = 0; i < DIM; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  return v.map((x) => x / norm);
}

function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < DIM; i++) s += a[i] * b[i];
  return s;
}

function centroid(vectors) {
  const v = new Array(DIM).fill(0);
  for (const vec of vectors) for (let i = 0; i < DIM; i++) v[i] += vec[i];
  let norm = 0;
  for (let i = 0; i < DIM; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  return v.map((x) => x / norm);
}

export { DIM, embed, cosine, centroid };
