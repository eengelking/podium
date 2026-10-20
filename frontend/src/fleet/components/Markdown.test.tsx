import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { Markdown } from "./Markdown";

afterEach(cleanup);

const html = (src: string) => render(<Markdown source={src} />).container.innerHTML;
const dom = (src: string) => render(<Markdown source={src} />).container;

describe("Markdown", () => {
  it("renders headings", () => {
    const c = dom("# One\n\n## Two\n\n### Three");
    expect([...c.querySelectorAll("h1,h2,h3")].map((h) => [h.tagName, h.textContent])).toEqual([["H1", "One"], ["H2", "Two"], ["H3", "Three"]]);
  });

  it("renders unordered and ordered lists", () => {
    const c = dom("- a\n- b\n\n1. x\n2. y");
    expect([...c.querySelectorAll("ul > li")].map((l) => l.textContent)).toEqual(["a", "b"]);
    expect([...c.querySelectorAll("ol > li")].map((l) => l.textContent)).toEqual(["x", "y"]);
  });

  it("renders bold, italic and inline code", () => {
    const c = dom("a **bold** and *it* and _it2_ and `code` here");
    expect(c.querySelector("strong")!.textContent).toBe("bold");
    expect([...c.querySelectorAll("em")].map((e) => e.textContent)).toEqual(["it", "it2"]);
    expect(c.querySelector("code")!.textContent).toBe("code");
  });

  it("renders a fenced code block verbatim, markup inside left alone", () => {
    const c = dom("```ts\nconst a = **1**;\n  indented\n```");
    expect(c.querySelector("pre code")!.textContent).toBe("const a = **1**;\n  indented");
    expect(c.querySelector("strong")).toBeNull();
  });

  it("keeps a shorter fence inside a longer one as text (#274)", () => {
    const c = dom("````md\nbefore\n```ts\ncode\n```\nafter\n````\n\ntail");
    expect(c.querySelectorAll("pre")).toHaveLength(1);
    expect(c.querySelector("pre code")!.textContent).toBe("before\n```ts\ncode\n```\nafter");
    expect(c.querySelector("p")!.textContent).toBe("tail");
  });

  it("closes a fence on a longer fence, and not on a fence with an info string (#274)", () => {
    const c = dom("```\na\n```js\nb\n`````\n\ntail");
    expect(c.querySelector("pre code")!.textContent).toBe("a\n```js\nb");
    expect(c.querySelector("p")!.textContent).toBe("tail");
  });

  it("closes a fence the text never closes", () => {
    expect(dom("```\nunfinished").querySelector("pre code")!.textContent).toBe("unfinished");
  });

  it("renders block quotes", () => {
    const c = dom("> one\n> two\n\nafter");
    expect(c.querySelector("blockquote")!.textContent).toBe("one two");
    expect(c.querySelector("p")!.textContent).toBe("after");
  });

  it("links a URL with balanced parentheses in full (#274)", () => {
    const a = dom("see [wiki](https://en.wikipedia.org/wiki/A_(b)) now").querySelector("a")!;
    expect(a.getAttribute("href")).toBe("https://en.wikipedia.org/wiki/A_(b)");
    expect(a.textContent).toBe("wiki");
  });

  it("does not take a closing parenthesis after the link into the URL (#274)", () => {
    const c = dom("(see [x](https://example.com/p)) end");
    expect(c.querySelector("a")!.getAttribute("href")).toBe("https://example.com/p");
    expect(c.textContent).toBe("(see x) end");
  });

  it("opens links in a new tab without opener or referrer", () => {
    const a = dom("see [the docs](https://example.com/x?a=1)").querySelector("a")!;
    expect(a.getAttribute("href")).toBe("https://example.com/x?a=1");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    expect(a.textContent).toBe("the docs");
  });

  it("does not make a link of javascript:, data: or other schemes", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "vbscript:x", "JaVaScRiPt:alert(1)"]) {
      const c = dom(`[click](${bad})`);
      expect(c.querySelector("a")).toBeNull();
      expect(c.textContent).toContain("click");
    }
  });

  it("shows raw HTML as text, never as elements", () => {
    const c = dom('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n**<b>x</b>**');
    expect(c.querySelector("script")).toBeNull();
    expect(c.querySelector("img")).toBeNull();
    expect(c.querySelector("b")).toBeNull();
    expect(c.textContent).toContain("<script>alert(1)</script>");
    expect(c.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("shows HTML inside code and link text as text too", () => {
    const c = dom("`<img onerror=x>` and [<i>t</i>](https://e.com)");
    expect(c.querySelector("img")).toBeNull();
    expect(c.querySelector("i")).toBeNull();
    expect(c.textContent).toContain("<img onerror=x>");
  });

  it("keeps plain text, empty input and odd markup from throwing", () => {
    expect(html("")).toBe("");
    expect(dom("just text").querySelector("p")!.textContent).toBe("just text");
    expect(() => dom("**unclosed *x `y [z](")).not.toThrow();
    expect(() => dom("#\n-\n1.\n>")).not.toThrow();
  });

  // Golden output captured from the regex implementation before it was rewritten without backtracking
  // (#362); the rewrite must render every one of these exactly as before.
  it("renders a table of ordinary and odd inputs unchanged (#362)", () => {
    const cases = [
      "# H1\n###### H6\n####### seven\n#nospace\n#   spaced   ",
      "#\n##\n# \n#\t tab",
      "1. a\n2) b\n  10. c\n1.x\n1 .x\n 1. nbsp",
      "- a\n* b\n+ c\n  - d\n-x\n- \n-\n-\tt",
      "- a\n1. b\n- c\n\n> q\n- d",
      "`code` and ``two`` and `` and `a\nb` end",
      "**bold** __bold2__ ****  **a** **a* *a** ** a **",
      "*it* *a b* * a* *a *b* _it_ _a b_ _ a_ snake_case_name _a_b_ (_a_) x_a_",
      "***both*** **_mix_** *__mix__* _**mix**_",
      "[a](https://e.com) [a](https://e.com/p_(q)) [a](https://e.com/(a(b))) [a]() [](https://e.com) [a](mailto:x@y.z)",
      "[a](javascript:x) [a](https://e.com space) [a](https://e.com/(x y)) [[a]](https://e.com)",
      "**unclosed *x `y [z](",
      "[a](https://e.com **b** `c` *d*) and [**b** *i*](https://e.com)",
      "a **b `c** d` e *f `g* h`",
      "> quote *it*\n>no space\n>\n> - not a list",
      "para one\nstill one\n\npara two",
      "  - indented\n    1. nested\n\t* tabbed",
      "```\n- not a list\n# not a heading\n```\n# after",
      "é **über** _éa_ é_a_é 日本_語_",
      "* \n*\n** \n- *a*",
      "[a [b](https://e.com) [c](https://e.com/(x)y) [d](https://e.com/(x y)) [e](https://e.com/(x",
      "[a]](https://e.com) [[a](https://e.com) [a](https://e.com)) [a]((https://e.com) [a](()) [a](x) [a](ftp://x)",
      "[a](https://e.com/x]y) [a]([b](https://e.com)) **[a](https://e.com)** `[a](https://e.com)` [`a`](https://e.com)",
      "[a](" + "[b](c) ".repeat(3) + "[x](https://e.com/(a)(b)) end [y](https://e.com",
      "# t x\n- a b\n1. a b\n- a  \n#  ",
    ];
    const out: Record<string, string> = {};
    cases.forEach((c, i) => (out[`${i}: ${JSON.stringify(c)}`] = html(c)));
    expect(out).toMatchSnapshot();
  });

  // Hostile text reaches this renderer from sessions, so a long run of one marker must not stall the tab.
  describe("stays linear on pathological input (#362)", () => {
    // A quadratic renderer takes 16 times as long on 4n as on n, a linear one 4 times. The
    // test asserts the ratio, so a slow or busy runner (or coverage) cannot fail it; the
    // per-test timeout is the backstop for a real hang. N is kept small because the cases that
    // build a node per marker took about 4.5 s each at 50,000, which a loaded coverage runner
    // stretched to the old 20 s limit (#471); a quadratic renderer still fails at 15,000.
    const N = 15000;
    const REPS = 5;
    const MAX_RATIO = 10;
    const FLOOR_MS = 1;
    const best = (src: string): number => {
      let min = Infinity;
      for (let i = 0; i < REPS; i++) {
        const t0 = performance.now();
        dom(src);
        min = Math.min(min, performance.now() - t0);
        // Cleanup is outside the timed interval so samples measure rendering, not teardown.
        cleanup();
      }
      return min;
    };
    const ratio = (build: (n: number) => string): number => {
      const small = Math.max(best(build(N)), FLOOR_MS);
      const large = best(build(N * 4));
      return large / small;
    };
    const pathological: Record<string, (n: number) => string> = {
      "backticks": (n) => "`a".repeat(n),
      "bold opens": (n) => "**a".repeat(n),
      "underscore bold opens": (n) => "__a".repeat(n),
      "link opens": (n) => "[a](".repeat(n),
      "open brackets": (n) => "[".repeat(n * 2),
      "open brackets with text": (n) => "[a".repeat(n),
      "link text then a long url run": (n) => "[a](" + "[a]".repeat(n),
      "link text then groups": (n) => "[a](" + "[b](c)".repeat(n),
      "link text then closers": (n) => "[a](" + "x]".repeat(n),
      "link url parens": (n) => "[a](" + "(a".repeat(n),
      "link url nested parens": (n) => "[a](" + "(a)".repeat(n) + "(",
      "italic opens": (n) => "*a ".repeat(n),
      "underscore opens": (n) => "_a ".repeat(n),
      "a lone star then text": (n) => "*" + "a".repeat(n * 2),
      "a lone underscore then text": (n) => "_" + "a".repeat(n * 2),
      "a lone bracket then text": (n) => "[" + "a".repeat(n * 2),
      "bracket text then no paren": (n) => "[a]".repeat(n),
      "spaces then no marker": (n) => " ".repeat(n * 2),
      "spaces then dash": (n) => " ".repeat(n * 2) + "-",
      "spaces then digit": (n) => " ".repeat(n * 2) + "1",
      "spaces then digit dot": (n) => " ".repeat(n * 2) + "1.",
      "digits then no dot": (n) => "1".repeat(n * 2),
      "heading hashes": (n) => "#".repeat(n * 2),
      "heading hashes then spaces": (n) => "#" + " ".repeat(n * 2),
      "dash then spaces": (n) => "-" + " ".repeat(n * 2),
      "many dash lines": (n) => "-\n".repeat(n),
    };
    for (const [name, build] of Object.entries(pathological)) {
      it(name, () => {
        dom(build(N)); // warm-up
        cleanup();
        const first = ratio(build);
        // Shared CI runners can pause every sample of one size. Re-measure only when the
        // first ratio crosses the limit; a quadratic renderer stays near 16 on both attempts.
        const measured = first < MAX_RATIO ? first : Math.min(first, ratio(build));
        expect(measured).toBeLessThan(MAX_RATIO);
      }, 60000);
    }
  });

  it("handles a large text", () => {
    const big = Array.from({ length: 2000 }, (_, i) => `- item ${i} with **bold**`).join("\n");
    expect(dom(big).querySelectorAll("li")).toHaveLength(2000);
  });
});
