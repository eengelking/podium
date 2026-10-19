import { describe, expect, it } from "vitest";
import { slug, stripLinks, stripTags, trimClosing } from "./docLinks.mjs";

describe("stripTags", () => {
  it("removes a tag and keeps the text around it", () => {
    expect(stripTags("a <b>bold</b> word")).toBe("a bold word");
  });

  it("leaves no complete tag behind when tags are nested (#489)", () => {
    expect(stripTags("<<b>b>x")).toBe("b>x");
    expect(stripTags("<scr<script>ipt>x")).toBe("ipt>x");
    expect(stripTags("<<script>script>x<</script>/script>")).toBe("script>x/script>");
  });

  it("keeps a lone < or > and the empty <>", () => {
    expect(stripTags("a < b")).toBe("a < b");
    expect(stripTags("a > b")).toBe("a > b");
    expect(stripTags("a <> b <i>c</i>")).toBe("a <> b c");
  });

  it("stays linear on long runs of < (#487)", () => {
    const t = Date.now();
    expect(stripTags("<".repeat(100_000)).length).toBe(100_000);
    expect(stripTags("<>".repeat(50_000)).length).toBe(100_000);
    expect(Date.now() - t).toBeLessThan(2000);
  });
});

describe("slug", () => {
  it("gives GitHub's anchor for a heading", () => {
    expect(slug("A <b>Bold</b> `code` heading!")).toBe("a-bold-code-heading");
    expect(slug("C # sharp")).toBe("c--sharp");
  });
});

describe("trimClosing", () => {
  it("drops closing hashes and the space before them, and keeps a hash inside", () => {
    expect(trimClosing("Title ##")).toBe("Title");
    expect(trimClosing("C # sharp")).toBe("C # sharp");
    expect(trimClosing("###")).toBe("");
  });
});

describe("stripLinks", () => {
  it("keeps the text of a link and drops its target", () => {
    expect(stripLinks("See [the guide](a.md) and [more](b.md) now")).toBe("See the guide and more now");
  });

  it("leaves brackets that are not a link alone", () => {
    expect(stripLinks("a [b] c")).toBe("a [b] c");
    expect(stripLinks("[[x]](y) z")).toBe("[[x]](y) z");
    expect(stripLinks("[[x](y) z")).toBe("[x z");
    expect(stripLinks("[a](unclosed")).toBe("[a](unclosed");
    expect(stripLinks("no brackets")).toBe("no brackets");
  });

  it("stays linear on brackets that never close (#487)", () => {
    const t = Date.now();
    stripLinks("[".repeat(100_000));
    stripLinks("[a](".repeat(30_000));
    stripLinks("[a]".repeat(30_000));
    expect(Date.now() - t).toBeLessThan(2000);
  });
});
