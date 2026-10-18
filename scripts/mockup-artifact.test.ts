import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inlineCss, toArtifact } from "./mockup-artifact.mjs";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "mockup-artifact-"));
  mkdirSync(join(dir, "css"));
  writeFileSync(join(dir, "css", "a.css"), '@import "./b.css";\n.a { color: var(--ink); }\n');
  writeFileSync(join(dir, "css", "b.css"), ".b { color: var(--bg); }\n");
  return dir;
}

describe("mockup-artifact", () => {
  it("pastes a stylesheet's relative imports into it, once, and keeps a remote import", () => {
    const dir = fixture();
    writeFileSync(join(dir, "css", "c.css"), '@import "https://x.test/f.css";\n@import "./b.css";\n@import "./b.css";\n.c {}\n');
    expect(inlineCss(join(dir, "css", "a.css"))).toBe(".b { color: var(--bg); }\n\n.a { color: var(--ink); }\n");
    const c = inlineCss(join(dir, "css", "c.css"));
    expect(c).toContain('@import "https://x.test/f.css";');
    expect(c.match(/\.b \{/g)).toHaveLength(1);
  });

  it("drops the page wrapper and the viewport meta, inlines local stylesheets and leaves remote ones", () => {
    const dir = fixture();
    const html = '<!doctype html>\n<html lang="en">\n<head>\n<meta name="viewport" content="width=device-width">\n<title>T</title>\n<link rel="stylesheet" href="css/a.css">\n<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=X">\n</head>\n<body class="x">\n<p>hi</p>\n</body>\n</html>\n';
    const out = toArtifact(html, dir);
    expect(out).not.toMatch(/<!doctype|<html|<head|<body|<\/body|viewport/i);
    expect(out).toContain("<style>\n.b { color: var(--bg); }");
    expect(out).toContain('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=X">');
    expect(out).toContain("<title>T</title>");
    expect(out).toContain("<p>hi</p>");
  });
});
