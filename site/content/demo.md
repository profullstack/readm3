---
title: A tour of the renderer
status: draft
---

# readm3

A terminal markdown reader. The file browser is on the left, the rendered
document is on the right, and there is nothing else in the way.

## What you are looking at

Everything below was rendered by readm3 itself, at build time, by the same
`renderMarkdown` the reader calls. No screenshot, no reimplementation.

### Text

Ordinary text wraps at the measure. **Bold** and *italic* survive, `inline
code` is held out of the HTML folding so `Array<string>` arrives intact, and a
[link](https://github.com/profullstack/readm3) keeps its label rather than
trailing a bare URL.

### Lists

- README sorts first in the sidebar
- directories with no markdown under them are pruned
- `node_modules` and friends are never walked

1. scan the tree
2. parse the document
3. color the spans

- [x] tables with per-column alignment
- [x] task lists
- [ ] anything the terminal cannot draw

### Code

```ts
const lines = renderMarkdown("# Hello", 60);
console.log(toText(lines));
```

> A blockquote is dimmed rather than boxed, because a box costs two columns
> and says nothing the color has not already said.

### Tables

| Role | Color | Where it comes from |
|:-----|:------|--------------------:|
| h1 | title | the theme |
| code | accent | the theme |
| quote | secondary | the theme |

---

![A diagram that a terminal cannot draw](/diagram.png)
