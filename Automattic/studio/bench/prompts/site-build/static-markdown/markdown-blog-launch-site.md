Build an importable mixed-source launch site for Northstar Pantry, a new subscription meal-planning service for busy families.

This prompt is intended to validate Static Site Importer support for a handoff where the marketing shell is HTML/CSS and the article content is Markdown. Produce a source tree for import with plain Markdown article files.

Required source shape:

```text
site/
  index.html
  styles.css
  content/
    about.md
    blog/launch-story.md
    blog/weekly-menu-preview.markdown
    blog/founder-note.md
    guides/pantry-staples.markdown
```

Use `index.html` as the homepage and shared shell: distinctive hero, product promise, pricing teaser, article cards, newsletter call to action, and footer navigation. Use `styles.css` for a polished responsive visual direction. Link homepage article cards to the Markdown files and include cross-links between articles.

Every Markdown file needs frontmatter with `title` and `slug`. Include rich Markdown/GFM content across the files: nested headings, lists, comparison tables, blockquotes, fenced recipe or config-style code blocks, and image/file link placeholders where supported.

Import this mixed HTML/CSS/Markdown source tree into the Studio site through the importer capability: {{sitePath}}
