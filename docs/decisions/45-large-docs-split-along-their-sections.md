---
title: "45. Large docs split along their sections into folders, with a README as the index (#697)"
description: "The spec, decisions, gotchas, architecture and user guide are folders of small pages, one per section or entry, each folder indexed by a generated README."
group: "Project internals"
number: 45
date: "2026-10-25"
status: "accepted"
order: 45
---

# 45. Large docs split along their sections into folders, with a README as the index (#697)

*Context.* Five pages had grown to between 700 and 6,000 lines: the spec, the architecture notes, the user guide, the decisions and
the gotchas. A page that long is hard to read, hard to link into and slow to review, and on the docs site it is one search hit and
one table of contents. The decisions and gotchas gain an entry with nearly every change, so every change edited the same file.

*Decision.*

- A page splits along its sections when its sections are topics a reader looks up or links to on their own, or when it is a log that
  gains an entry with every change. A page that is one task read from start to finish stays whole. Line count is a hint, not the
  rule. A section that is itself a set of subsections, and long, splits again.
- Each split topic is a folder under `docs/` (`spec`, `decisions`, `gotchas`, `architecture`, `user-guide`) with a `README.md` and one
  page per section, entry or subsection. The spec's sections 5 to 8 and two sections of the architecture notes and the user guide
  are subfolders. 227 pages in all carry `title`, `description`, `group` and `order` in frontmatter.
- `README.md` is the index, because GitHub shows a folder's `README.md` under its file list and the docs site uses it as the
  folder's first page. Its list of pages, and a previous / up / next footer on each page, are generated from the frontmatter by
  `scripts/build-doc-indexes.mjs`, and a test fails when they are out of date. A new decision or gotcha is one new file.
- Section and entry numbers do not change. A spec page carries `section` ("7.7") and a decision carries `number`, so "SPEC 7.7" and
  "DECISIONS 37" each name one page. `scripts/check-doc-refs.mjs` fails `npm test` on a citation no page answers to and on a
  reference to the old single-file paths, which remain as short stubs for links from outside the repository.
- The site menu follows the folders: a group for each topic, its overview first, then the pages in `order`, a subfolder as a group of
  its own. Older tagged versions still build, with the single file as one page.
- The text was moved by script and a second script compared old and new: nothing was reworded or lost. Only headings, frontmatter,
  links and the generated parts changed, plus five one-sentence openings where a page started with a table, a list or a code block.

*Why.* Small pages link, search and review well, and a folder with an index keeps the whole topic one click away on GitHub and on
the site. Splitting on sections, not on a line count, keeps each page a topic a reader can name. Generating the index from
frontmatter means two people adding entries never edit the same lines.

*Alternatives.* A line-count rule (split at about 500 lines) was rejected because it cuts a procedure in half and leaves a short
log as one file. Keeping the single files and adding a search index was rejected because it does not help the contributor who
edits them. One file per spec subsection everywhere was rejected: sections 1 to 4 and 9 to 12 are short and read best whole.
A hand-written index was rejected because it goes stale.

*Cost.* There are 227 files where there were fifteen, and a rename or a reorder means running the index script. A page's address
changed, so a link that points at an anchor inside an old single file has to be rewritten: the stubs keep the old paths alive but
cannot keep the anchors. The longest spec subsection is still about 1,500 lines, because the spec numbers its subsections and
a number must name one page.

<!-- nav:start -->
---

Previous: [44. The docs live at podium.engelking.dev, a CNAME to GitHub Pages (#689)](44-the-docs-live-at-podium-engelking-dev-a-cname.md) · Up: [Decisions](README.md) · Next: [46. A context names one reporter config file, in ~/.podium/contexts.json (#606)](46-a-context-names-one-reporter-config-file-in-podium-contexts-json.md)
<!-- nav:end -->
