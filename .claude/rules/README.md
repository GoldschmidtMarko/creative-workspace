# How to add rules here

Every `.md` file in this directory is loaded automatically by Claude Code at
the start of every session in this project — nothing else needs to
reference them.

- **One topic per file** — e.g. `commits.md`, `testing.md`, `tone.md`,
  rather than one giant file.
- **Plain markdown, no frontmatter required.** A file with no `paths:`
  frontmatter always loads, every session.
- **To scope a rule to specific files only**, add frontmatter like this at
  the very top of the file:

  ```
  ---
  paths:
    - "functions/**/*.py"
  ---
  ```

  That rule then only loads into context when Claude reads a file matching
  the pattern, instead of unconditionally every session — useful for rules
  that only make sense in one part of the repo (e.g. Python conventions that
  don't apply to the frontend).
- **Be concrete.** "Use 2-space indentation" is followed far more reliably
  than "format code nicely." These are read as context, not enforced
  config — vague rules get interpreted loosely.
- New files here take effect starting the *next* session — a rule added
  mid-conversation won't retroactively apply to the current one.

Delete or rewrite this file once you have real rules in place; it's just
here to document the convention.
