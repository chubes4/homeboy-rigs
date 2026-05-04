Build an importable mixed-source documentation site for SignalForge, a developer tool that monitors API reliability for small platform teams.

This benchmark is specifically for the Static Site Importer mixed-source capability. Create a source tree that the importer can consume directly, with an HTML shell for shared chrome and plain Markdown content files for individual pages. Do not build an Astro project, do not generate MDX, and do not collapse the content into one generated HTML file.

Required source shape:

```text
site/
  index.html
  styles.css
  content/
    about.md
    docs/getting-started.md
    docs/incident-workflows.md
    docs/api-reference.md
    changelog/launch-notes.markdown
```

Use `index.html` for the visual system, navigation, footer, homepage sections, and links into the Markdown pages. Use `styles.css` for all site styling. Give every Markdown file frontmatter with `title` and `slug`, and include internal links between the homepage and nested content pages.

The Markdown pages should exercise rich GFM content: headings, ordered and unordered lists, tables, blockquotes, fenced code examples, task lists, and at least one image or downloadable-file link placeholder where the importer supports it.

Import the source tree into this Studio site using the mixed HTML shell plus Markdown content importer path: {{sitePath}}
