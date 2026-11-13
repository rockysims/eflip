# UI decisions

Rulings the owner has made about this project's interface, one file each, named `<date>--<area>--<rule>.md`. These override the shared ui-patterns library. Agents: list this directory before changing UI, open the files whose names match, and write a new file when the owner overrides a choice.

Standing rules:
- Dense desktop tables at 13px (export.html); hit targets inside table rows may be under 44px.
- Vanilla HTML/JS, no framework, no build step; styles live in each page's `<style>` block.
