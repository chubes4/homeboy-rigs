Build an importable mixed-source resource library for Civic Signal, a nonprofit publishing toolkits for neighborhood organizers.

This benchmark should depend on Static Site Importer mixed-source support: one HTML shell plus multiple plain Markdown resources. Generate a source tree that can be imported as-is. Do not use MDX, front-end framework build output, or a single flattened HTML export.

Required source shape:

```text
site/
  index.html
  styles.css
  content/
    about.md
    resources/outreach-checklist.md
    resources/meeting-agenda-template.markdown
    resources/grant-readiness.md
    case-studies/park-cleanup.md
```

Use `index.html` for the shared design system, homepage, resource index, topic filters or groupings, calls to action, and footer. Use `styles.css` for all responsive layout and visual styling. The homepage must link to the Markdown resources, and the resources should link back to the index and to at least one related resource.

Every Markdown or `.markdown` file must include frontmatter with `title` and `slug`. Use rich Markdown/GFM content: headings, numbered steps, unordered checklists, data tables, blockquotes, fenced code or plain-text templates, and image/file link placeholders where supported by the importer.

Import the resulting HTML shell plus Markdown content tree into this Studio site: {{sitePath}}
