import { describe, expect, it } from "vitest";
import {
  BenchDataError,
  validateCanonicalization,
  validateJudgments,
  validateManifest,
} from "../src/bench/validate.js";
import {
  buildValidCanonicalization,
  buildValidJudgments,
  buildValidManifest,
} from "./helpers/bench-fixture.js";

describe("benchmark manifest validation", () => {
  it("accepts a manifest reproducing the frozen 16-family structure", () => {
    expect(() => validateManifest(buildValidManifest())).not.toThrow();
  });

  it("rejects a different topic-family count at execution time", () => {
    const manifest = buildValidManifest();
    manifest.families = manifest.families.slice(0, 15);
    expect(() => validateManifest(manifest)).toThrow(BenchDataError);
    expect(() => validateManifest(manifest)).toThrow(/16 frozen topic families/);
  });

  it("requires exactly one two-query and one four-query family plus fourteen singletons", () => {
    const manifest = buildValidManifest();
    // Demote h-02 out of the workload entirely, leaving graph-engineering a
    // singleton: the frozen structure can no longer be reproduced.
    const demoted = manifest.queries.find((query) => query.id === "h-02")!;
    demoted.slice = "robustness";
    delete (demoted as { familyId?: string }).familyId;
    manifest.families[0]!.queryIds = ["h-01"];
    expect(() => validateManifest(manifest)).toThrow(/exactly one family of 2 queries/);
  });

  it("rejects unassigned or double-assigned headline queries", () => {
    const manifest = buildValidManifest();
    (manifest.queries[10] as { familyId?: string }).familyId = undefined;
    expect(() => validateManifest(manifest)).toThrow(/declares familyId undefined/);

    const extra = buildValidManifest();
    extra.queries.push({
      id: "h-21",
      text: "extra headline need",
      slice: "headline",
      provenanceRef: "ledger#h-21",
      intentStatement: "Seeking h-21",
      familyId: "new-family",
    });
    expect(() => validateManifest(extra)).toThrow(/frozen workload requires exactly 20 headline/);
  });

  it("forbids family membership for non-headline queries", () => {
    const manifest = buildValidManifest();
    manifest.queries[0]!.slice = "robustness";
    expect(() => validateManifest(manifest)).toThrow(/non-headline query/);
  });

  it("rejects corpus entries without hash digests", () => {
    const manifest = buildValidManifest({
      corpus: { indexYamlSha256: "nope", indexSqliteSha256: "b".repeat(64) },
    });
    expect(() => validateManifest(manifest)).toThrow(/hex SHA-256/);
  });
});

describe("canonicalization validation", () => {
  it("accepts the alias map", () => {
    expect(() => validateCanonicalization(buildValidCanonicalization())).not.toThrow();
  });

  it("rejects an alias claimed by two canonical documents", () => {
    const file = buildValidCanonicalization();
    file.canonicals["c-00"]!.aliases.push("doc-1");
    expect(() => validateCanonicalization(file)).toThrow(/more than one canonical document/);
  });

  it("rejects empty canonical sets", () => {
    expect(() =>
      validateCanonicalization({ schemaVersion: 1, canonicals: {} }),
    ).toThrow(/must not be empty/);
  });
});

describe("judgment validation", () => {
  it("accepts complete frozen judgments", () => {
    expect(() =>
      validateJudgments(buildValidJudgments(), buildValidManifest(), buildValidCanonicalization()),
    ).not.toThrow();
  });

  it("fails loudly instead of fabricating when judgments are missing", () => {
    const judgments = buildValidJudgments();
    delete judgments.grades["h-07"];
    expect(() =>
      validateJudgments(judgments, buildValidManifest(), buildValidCanonicalization()),
    ).toThrow(/never fabricates judgments/);
  });

  it("enforces required top-10 evidence per headline query", () => {
    const judgments = buildValidJudgments();
    delete judgments.grades["h-07"]!["c-09"];
    expect(() =>
      validateJudgments(judgments, buildValidManifest(), buildValidCanonicalization()),
    ).toThrow(/required top-10 evidence demands at least 10/);
  });

  it("restricts grades to the frozen rubric values 0..3", () => {
    const judgments = buildValidJudgments();
    (judgments.grades["h-01"]! as Record<string, number>)["c-00"] = 4;
    expect(() =>
      validateJudgments(judgments, buildValidManifest(), buildValidCanonicalization()),
    ).toThrow(/integer grade 0\.\.3/);
  });

  it("requires answerability anchors to be judged", () => {
    const judgments = buildValidJudgments();
    // Keep the top-10 pool intact while removing the anchor itself.
    judgments.grades["h-01"]!["c-10"] = 1;
    delete judgments.grades["h-01"]!["c-00"];
    expect(() =>
      validateJudgments(judgments, buildValidManifest(), buildValidCanonicalization()),
    ).toThrow(/answerability anchor/);
  });

  it("rejects unknown canonical ids", () => {
    const judgments = buildValidJudgments();
    judgments.grades["h-01"]!["unknown-canonical"] = 1;
    expect(() =>
      validateJudgments(judgments, buildValidManifest(), buildValidCanonicalization()),
    ).toThrow(/unknown canonical id/);
  });
});
