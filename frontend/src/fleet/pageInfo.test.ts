import { describe, it, expect } from "vitest";
import { FIRST_SENTENCE_MAX, PAGE_INFO, fitSentences, myReportersDescription, sentencesOf } from "./pageInfo";

describe("page names and descriptions (#1209)", () => {
  const pages = Object.entries(PAGE_INFO);

  it("gives every page its own name and its own description", () => {
    expect(new Set(pages.map(([, p]) => p.name)).size).toBe(pages.length);
    expect(new Set(pages.map(([, p]) => p.description)).size).toBe(pages.length);
  });

  it("keeps every first sentence short enough for the banner at 400 px", () => {
    for (const [key, p] of pages) {
      const first = sentencesOf(p.description)[0];
      expect(first.length, `${key}: "${first}"`).toBeLessThanOrEqual(FIRST_SENTENCE_MAX);
    }
  });

  it("starts no description with the page's name followed by a full stop", () => {
    for (const [, p] of pages) expect(p.description.startsWith(`${p.name}.`)).toBe(false);
  });

  it("adds the My reporters sentences only for a person who has reporters", () => {
    const none = myReportersDescription(false);
    const some = myReportersDescription(true);
    expect(none).toBe(PAGE_INFO.myReporters.description);
    expect(some.startsWith(none)).toBe(true);
    expect(some).toContain("asks you below first.");
  });
});

describe("sentencesOf", () => {
  it("splits at a full stop, question mark or exclamation mark followed by a space", () => {
    expect(sentencesOf("One. Two? Three! Four.")).toEqual(["One.", "Two?", "Three!", "Four."]);
  });
  it("returns one sentence for text with no end mark inside it, and none for empty text", () => {
    expect(sentencesOf("Just one")).toEqual(["Just one"]);
    expect(sentencesOf("")).toEqual([]);
  });
});

describe("fitSentences", () => {
  const text = "Aaaa. Bbbb. Cccc.";
  it("shows everything when everything fits, and says nothing was left out", () => {
    expect(fitSentences(text, () => true)).toEqual({ shown: text, clipped: false });
  });
  it("shows the most whole sentences that fit and says some were left out", () => {
    expect(fitSentences(text, (s) => s.length <= 11)).toEqual({ shown: "Aaaa. Bbbb.", clipped: true });
    expect(fitSentences(text, (s) => s.length <= 5)).toEqual({ shown: "Aaaa.", clipped: true });
  });
  it("never cuts inside a sentence: the first one is shown even when it does not fit", () => {
    expect(fitSentences(text, () => false)).toEqual({ shown: "Aaaa.", clipped: true });
  });
  it("does not say a one-sentence description was clipped", () => {
    expect(fitSentences("Only this.", () => false)).toEqual({ shown: "Only this.", clipped: false });
  });
  it("returns nothing for empty text", () => {
    expect(fitSentences("", () => true)).toEqual({ shown: "", clipped: false });
  });
});
