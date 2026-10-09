Epic E1 "String utilities" — add three small utilities to textkit, each exported from src/index.js.

T1 slugify: add slugify(text) in src/slugify.js.
  Checklist:
  1. Lowercases, strips accents (é→e), turns runs of non-alphanumerics into one hyphen, trims leading/trailing hyphens
  2. Exported from src/index.js
  3. Tests in test/slugify.test.js pass with npm test

T2 truncate: add truncate(text, max, ellipsis = '…') in src/truncate.js.
  Checklist:
  1. Returns text unchanged when it fits in max characters
  2. Otherwise cuts at the last word boundary so the result including the ellipsis is at most max characters (hard cut if there is no boundary)
  3. Exported from src/index.js, with tests in test/truncate.test.js passing

T3 CLI: add bin/textkit.js (blocked by T1 and T2).
  Checklist:
  1. `node bin/textkit.js slugify <text>` and `node bin/textkit.js truncate <max> <text>` print the result; unknown command prints usage and exits 1
  2. package.json has a "bin" entry for textkit
  3. Tests in test/cli.test.js run the CLI via child_process and pass
  4. README.md has a Usage section
