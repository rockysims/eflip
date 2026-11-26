# The root URL is a page of links, not a redirect

- Situation: the pre-rework root page fetched hundreds of Jita books from ESI on load and was retired; the root URL then redirected to the export page.
- Proposed: keep the redirect to `export.html`, the README's main page.
- Chosen: a static landing page at `/` (`public/index.html`): the four pages as links with one line each on what the page is for, no script, nothing fetched from ESI.
- Why: "how about making the index page a list of links to the other pages?" (owner, 2026-11-26).
- Pattern: none
- Status: ruling
