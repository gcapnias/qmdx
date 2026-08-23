# QMD Multilingual Embedding Alternative

> Research for **Choose the QMDX search pipeline architecture**
> Researched: 2026-08-23

## Conclusion

QMD 2.8.3 documents Qwen3-Embedding-0.6B as its multilingual alternative:

```text
hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf
```

The Qwen model owner states support for more than 100 languages. QMD describes the
model as supporting 119 languages, including CJK. QMDX should describe the supported
coverage conservatively as 100+ languages.

QMDX can keep QMD's existing indexing workflow. Configure `models.embed` before
opening the store, then use the existing `qmd update` and `qmd embed -f` commands.
The SDK equivalents are `store.update()` and `store.embed({ force: true })`.

## Migration implications

- Qwen3-Embedding-0.6B produces 1024-dimensional vectors.
- Existing vectors created with QMD's default embedding model are incompatible.
- Switching models therefore requires a complete `qmd embed -f` rebuild.
- The Q8_0 GGUF is approximately 610 MB on disk, but QMD's v2.8.3 changelog reports
  approximately 1190 MB of VRAM per 2048-token context.
- Remote expansion is important on the target workstation because combining this
  embedding model with a local generation model would exceed the practical GPU budget.
- For unattended use, prefer the global QMD configuration or `QMD_EMBED_MODEL`;
  QMD 2.8.3 applies a trust gate to custom models in project-local configuration.

Example global configuration:

```yaml
models:
  embed: "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"
```

Then rebuild:

```sh
qmd update
qmd embed -f
```

`qmd update` is only required when indexed files or collection configuration changed;
the forced embedding rebuild is mandatory after the model switch.

## Corrections to the debugging transcript

The contextual transcript at `.scratch/debugging-qmd-search-results.md` contains
several inaccurate examples:

- QMD model URIs use `hf:`, not `hf://`.
- The documented GGUF filename is case-sensitive:
  `Qwen3-Embedding-0.6B-Q8_0.gguf`.
- The approximate 610 MB file size is not the loaded VRAM footprint; QMD reports
  approximately 1190 MB per context.
- The transcript's `Compendia/bge-m3-GGUF` alternative is not an officially
  documented QMD model and could not be verified as a public model source.
- Cohere `rerank-multilingual-v3.0` is obsolete and must not be selected later.
- JSON-object mode does not enforce QMDX's typed expansion contract; strict JSON
  Schema output is required.

## Primary sources

- QMD README, v2.8.3:
  <https://github.com/tobi/qmd/tree/v2.8.3>
- QMD changelog, v2.8.3:
  <https://github.com/tobi/qmd/blob/v2.8.3/CHANGELOG.md>
- Qwen3-Embedding-0.6B model card:
  <https://huggingface.co/Qwen/Qwen3-Embedding-0.6B>
- Qwen3-Embedding-0.6B GGUF model card:
  <https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF>
- Qwen3 Embedding announcement:
  <https://qwenlm.github.io/blog/qwen3-embedding/>
