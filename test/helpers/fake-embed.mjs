// Test-only fake embedding seam for offline QMD index construction and
// vector-probe execution. Never import this from production code.
//
// Two usage modes:
// 1. In-process (index creation in test helpers):
//      const fake = await import("./fake-embed.mjs");
//      const restore = fake.installFakeEmbed({ dimension: 8 });
//      ... create store, await store.embed() ...
//      restore();
// 2. Child-process preload (CLI child tests): launched with
//      NODE_OPTIONS="--import file://.../fake-embed.mjs"
//      QMDX_TEST_FAKE_EMBED_DIM=<dimension>
//    Self-installs before the CLI loads @tobilu/qmd.
//
// The patches hook the LlamaCpp class exported from the SDK's dist/llm.js via
// an absolute URL derived from import.meta.resolve("@tobilu/qmd"). That is the
// same module instance the SDK itself uses, because module identity is keyed
// by resolved URL. Vector dimensions are deterministic per token text so
// probe queries and stored embeddings stay consistent within one dimension.

const TOKENIZER = {
  async tokenize(text) {
    return new Array(Math.max(1, Math.ceil(text.length / 16))).fill(1);
  },
};

let savedEmbed = null;
let savedEmbedBatch = null;
let tokenizerInstalled = false;

function resolveLlmModuleUrl() {
  // import.meta.resolve is unavailable under vitest's SSR transform, so fall
  // back to the flat node_modules layout produced by `npm ci`.
  if (typeof import.meta.resolve === "function") {
    try {
      return import.meta.resolve("@tobilu/qmd").replace(/index\.js$/, "llm.js");
    } catch {
      // fall through
    }
  }
  return new URL(
    "../../node_modules/@tobilu/qmd/dist/llm.js",
    import.meta.url,
  ).href;
}

function fakeVector(text, dimension) {
  const vector = new Array(dimension).fill(0);
  let seed = 0;
  for (let i = 0; i < text.length; i++) {
    seed = (seed * 31 + text.charCodeAt(i)) >>> 0;
    vector[seed % dimension] += ((seed >> 8) % 1000) / 1000;
  }
  return vector;
}

async function install(dimension) {
  if (savedEmbed !== null) throw new Error("fake embed already installed");
  const llm = await import(resolveLlmModuleUrl());
  savedEmbed = llm.LlamaCpp.prototype.embed;
  savedEmbedBatch = llm.LlamaCpp.prototype.embedBatch;
  llm.LlamaCpp.prototype.embed = async function (text) {
    return { embedding: fakeVector(String(text), dimension), model: "fake-embed" };
  };
  llm.LlamaCpp.prototype.embedBatch = async function (texts) {
    return texts.map((text) => ({
      embedding: fakeVector(String(text), dimension),
      model: "fake-embed",
    }));
  };
  if (!tokenizerInstalled) {
    const { setDefaultLlamaCpp } = llm;
    setDefaultLlamaCpp(TOKENIZER);
    tokenizerInstalled = true;
  }
}

export function installFakeEmbed({ dimension = 8 } = {}) {
  return install(dimension).then(() => restoreFakeEmbed);
}

export function restoreFakeEmbed() {
  if (savedEmbed === null) return;
  const promise = import(resolveLlmModuleUrl());
  const embed = savedEmbed;
  const embedBatch = savedEmbedBatch;
  savedEmbed = null;
  savedEmbedBatch = null;
  return promise.then((llm) => {
    llm.LlamaCpp.prototype.embed = embed;
    llm.LlamaCpp.prototype.embedBatch = embedBatch;
    llm.setDefaultLlamaCpp(null);
    tokenizerInstalled = false;
  });
}

const preloadDimension = process.env.QMDX_TEST_FAKE_EMBED_DIM;
if (preloadDimension !== undefined && savedEmbed === null) {
  await install(Number(preloadDimension));
}
