# Message formatting

What a person types into the chat and what the assistant answers are both kept
as text, and both are shown as they were written. This document covers the path
from the composer to the stored turn, and the renderer that draws it.

## What the pipeline used to lose

The formatting was not a CSS problem, and adding `white-space` alone would have
hidden half of it:

| Where                           | What happened                                                                                       |
| ------------------------------- | --------------------------------------------------------------------------------------------------- |
| `useChatSession` then `useChat` | `String.prototype.trim()` ran twice, so the indentation of the first line went with the blank edges |
| `ChatComposer`                  | the draft was compared with a trimmed copy, so a draft of only spaces looked typed                  |
| `.v-chat__bubble`               | no `white-space`, so every line break and blank line collapsed                                      |
| `POST /api/reasoning` (schema)  | `maxLength: 8000` refused a long pasted brief with a validation error                               |
| `reasoning/core` engine         | `MAX_TASK_CHARS = 4000` refused anything longer                                                     |
| run history                     | the conversation block and each earlier turn were cut at 4,000 characters from the front            |
| final answer prompts            | "plain text, no code fences, no preamble" removed the structure the answer needed                   |
| `ChatThread`                    | the answer was a `<p>` with `{message.text}`, so Markdown reached the screen as raw symbols         |

## The rule now

Trimming removes **only** whitespace that is not the person's words: whole blank
lines at the top and bottom, and trailing space at the very end. Everything
inside is untouched. That lives in `apps/web/src/pages/chat/messageText.ts`:

- `normalizeNewlines` unifies `\r\n` and `\r` to `\n` and changes nothing else.
- `trimBlankEdges` then drops the blank edge lines, keeps a first line's
  indentation, and removes a NUL byte, which no text column can store anyway.
- `hasContent` is what the composer asks before it treats the box as typed.
- `clipForHistory` cuts an earlier turn on a line boundary and says so, rather
  than slicing mid-word.

The same `trimBlankEdges` runs on the server in `reasoning/core/src/text.ts`, so
the task the engine stores is the task the model reads.

**No length ceiling on a task.** A brief with headings, lists and code is as
valid as a one-line question, so the route and the engine both accept any
length. What bounds the request is the transport's body limit; what bounds the
model is its own context window, which fails loudly through the provider rather
than being cut in silence.

The answer has a visible ceiling of 100,000 characters. `clipAnswer` marks the
cut in the text itself, so a person who asked for a long document is told where
it stopped instead of receiving a shorter answer that reads as complete.

## The renderer

`apps/web/src/pages/chat/markdown/` is a small two-stage renderer, not a
regular-expression pile and not a library that accepts raw HTML:

1. `parse.ts` turns the text into a typed tree of blocks (paragraph, heading,
   code, quote, rule, list with nesting and task items, table with alignment)
   and inlines (bold, italic, strikethrough, code, link, plain text). It is pure
   and takes no DOM.
2. `Markdown.tsx` draws that tree as React elements. There is no HTML injection
   path anywhere in it, so a script tag or an `onerror` attribute in a message
   is text on the screen, and `javascript:` in a link stays inert.

`UserText.tsx` draws the person's own message. It keeps the text literal, with
only two exceptions: a fenced block is drawn as a code block, and a bare URL
becomes a link. Italics and bold markers in your own words are left as typed,
because rewriting what someone sent is worse than showing it exactly.

An arriving answer is handled while it is still incomplete: a fence that has not
closed renders as a code block instead of spilling its contents, and a trailing
half-written marker stays literal until the rest arrives.

## Layout

Measured on the built page at 360, 390, 768 and 1280:

| Element              | Value                                    |
| -------------------- | ---------------------------------------- |
| Paragraph gap        | 14px (0.85em)                            |
| Gap before a heading | 24-27px (1.4em), heading to its text 6px |
| Nested list indent   | 24px per level                           |
| Quote                | 3px left border                          |
| Bubble               | `pre-wrap`, `max-width: min(85%, 520px)` |

Two cascading rules make that work, and both fail silently when they regress:

- `.v-chat__answer` needs `min-width: 0`. It is a flex item beside the turn, and
  without it one wide table row or long code line sets the minimum width of the
  whole column and runs off the page.
- Every block margin reset carries `:where()`, so it has no specificity. A plain
  `.v-md p { margin: 0 }` out-specifies `.v-md > * + *` and flattens every gap
  to zero, which is exactly what happened before it was measured.

A code block and a table each scroll inside their own frame, so a wide table
stays usable at 360dp and the page itself never moves sideways.

`apps/web/src/pages/chat/chat-styles.test.ts` reads the stylesheet and asserts
those rules, because jsdom does no layout and a silent regression there is
invisible to every other test.

## Response style

`reasoning/core/src/response-style.ts` is shared by both answer steps, so the
style is not a property of one prompt:

- Structure when it helps (headings, lists, steps, tables for comparisons, code
  in fences), plain sentences when it does not.
- Length follows the request: a direct answer to a simple question, a structured
  report for engineering work.
- No repetitive opening, no preamble about being an AI, no joining unrelated
  ideas into one paragraph.
- Say plainly what was not done, and never claim something succeeded before it
  was verified.

## Known gaps

- No syntax highlighting in a code block. The block scrolls, keeps its
  indentation and names its language; the tokens are not coloured.
- A message cannot carry an attachment through to a run yet: the run API takes
  text only.
- Answers arrive as a whole body of text. The renderer already copes with
  partial Markdown, but the transport does not stream it token by token.
- Enter sends and Shift+Enter starts a new line. A composing Enter (Japanese,
  Chinese, Android suggestion bars) now waits instead of sending a half-typed
  message.
