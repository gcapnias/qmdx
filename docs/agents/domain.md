# Domain Docs

Before exploring, read `CONTEXT.md` at the repo root and relevant ADRs under `docs/adr/`. If these files do not exist, proceed silently; domain-modeling skills create them lazily when terminology or decisions are resolved.

## File structure

This repo uses the single-context layout:

```text
/
|-- CONTEXT.md
|-- docs/adr/
`-- src/
```

## Use the glossary's vocabulary

Use terms as defined in `CONTEXT.md` in issue titles, proposals, hypotheses, and test names. Avoid synonyms the glossary explicitly rejects. If a needed concept is absent, reconsider the terminology or note the gap for `/domain-modeling`.

## Flag ADR conflicts

Explicitly surface output that contradicts an existing ADR rather than silently overriding it.
