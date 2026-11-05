import { describe, it, expect } from "vitest";
import {
  combinedTsquery,
  FUZZY_MIN_LENGTH,
  likePattern,
  MAX_TERMS,
  needsTrigramArm,
  parseSearchTerms,
  termTsquery,
} from "@/lib/search/terms";

describe("parseSearchTerms", () => {
  it("splits a query into lowercased terms", () => {
    expect(parseSearchTerms("Invoice March").map((t) => t.text)).toEqual(["invoice", "march"]);
  });

  it("drops duplicates and blank space", () => {
    expect(parseSearchTerms("  invoice   INVOICE  march ").map((t) => t.text)).toEqual([
      "invoice",
      "march",
    ]);
  });

  it("keeps a query of many words bounded", () => {
    const query = Array.from({ length: MAX_TERMS + 4 }, (_, i) => `word${i}`).join(" ");
    expect(parseSearchTerms(query)).toHaveLength(MAX_TERMS);
  });

  it("returns nothing for a blank query", () => {
    expect(parseSearchTerms("   ")).toEqual([]);
    expect(parseSearchTerms("")).toEqual([]);
  });

  it("truncates a pasted paragraph into one term", () => {
    const terms = parseSearchTerms("a".repeat(200));
    expect(terms).toHaveLength(1);
    expect(terms[0]?.text.length).toBeLessThanOrEqual(64);
  });
});

describe("likePattern", () => {
  it("wraps the term in wildcards", () => {
    expect(likePattern("invoice")).toBe("%invoice%");
  });

  it("escapes the LIKE metacharacters", () => {
    expect(likePattern("50%_off")).toBe("%50\\%\\_off%");
    expect(likePattern("back\\slash")).toBe("%back\\\\slash%");
  });
});

describe("termTsquery", () => {
  it("asks for a prefix so a partial word still hits", () => {
    expect(termTsquery("invoic")).toBe("invoic:*");
  });

  it("keeps letters and digits only, which is what keeps to_tsquery from erroring", () => {
    expect(termTsquery("a&b|c!(d)")).toBe("abcd:*");
    expect(termTsquery("e-mail")).toBe("email:*");
    expect(termTsquery("rechnung")).toBe("rechnung:*");
  });

  it("gives up on a term with nothing searchable in it", () => {
    expect(termTsquery("---")).toBeNull();
    expect(termTsquery("%")).toBeNull();
  });
});

describe("the trigram gate", () => {
  it(`only arms terms of ${FUZZY_MIN_LENGTH} characters or more`, () => {
    expect(parseSearchTerms("card")[0]?.fuzzy).toBe(false);
    expect(parseSearchTerms("cards")[0]?.fuzzy).toBe(true);
  });

  it("leaves symbols alone", () => {
    expect(parseSearchTerms("----")[0]?.fuzzy).toBe(false);
  });

  it("reports whether any term needs the lowered threshold", () => {
    expect(needsTrigramArm(parseSearchTerms("card"))).toBe(false);
    expect(needsTrigramArm(parseSearchTerms("card march"))).toBe(true);
  });
});

describe("combinedTsquery", () => {
  it("ANDs every term", () => {
    expect(combinedTsquery(parseSearchTerms("invoice march"))).toBe("invoice:* & march:*");
  });

  it("skips a term with no word characters", () => {
    expect(combinedTsquery(parseSearchTerms("invoice ---"))).toBe("invoice:*");
  });

  it("is null when nothing is searchable, so no tsquery is built at all", () => {
    expect(combinedTsquery(parseSearchTerms("--- !!!"))).toBeNull();
  });
});
