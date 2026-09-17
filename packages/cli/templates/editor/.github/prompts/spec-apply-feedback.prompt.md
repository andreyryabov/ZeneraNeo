---
description: Fold the answers left in SPECIFICATION-FEEDBACK.md back into SPECIFICATION.md, and mark each answered question as answered.
---

`SPECIFICATION-FEEDBACK.md` is a questionnaire. Each question carries two to
four written-out answers, each with a `[ ]` box in its heading, and the reader
answers by **marking one box `[x]`, deleting the answers they do not want, or
both**. Your job is to take the answer they chose under each question, put its
text into `SPECIFICATION.md` where it says it goes, and mark the question
answered.

You change two files and no others: `SPECIFICATION.md` and
`SPECIFICATION-FEEDBACK.md`. You implement nothing - not a prompt, not a skill,
not `agents.yaml`. Making the project match the specification is
`/sync-with-spec`, which runs after this.

## 1. Read both files before editing either

Read `SPECIFICATION-FEEDBACK.md` end to end, then `SPECIFICATION.md` end to end,
and only then edit. The second read is what tells you whether an answer's text
still fits where it is going.

If there is no `SPECIFICATION-FEEDBACK.md`, say so in the chat and stop - there
is nothing to fold in.

## 2. Decide the state of every question

Go through the questions in order and sort each into one of these, by what is
left under it. Say in the chat how many fell into each before you edit anything.

**Answered** - apply it:

- exactly one answer has its box marked `[x]`, whatever else is still there
- exactly one `####` answer is left, box marked or not
- the reader wrote prose of their own in place of the answers, or edited the
  answer they kept - then apply what they wrote, word for word

**Open** - leave it exactly as it is:

- two or more answers are left and none is marked
- two or more boxes are marked `[x]` - that is not a choice, and the chat report
  is where you say so

**Rejected** - leave it, and ask in the chat:

- no answers at all are left under the question

**Done** - leave it alone:

- it is already under `✅`

A question with every answer deleted is the reader saying none of them fit.
**Do not invent a fifth.** Say in the chat which question it was and ask what
would fit; if they tell you, write their words in under the question as the
answer and apply it in this same pass.

A question with two or more answers still standing and no box marked is **not
answered**. Never choose between them, never pick the `_(built)_` one because it
is already true, and never break a tie by reading the implementation.

## 3. Put the text into `SPECIFICATION.md`

For each answered question, take the fenced block under its surviving answer and
put it where the line above the block says it goes.

- **The line number is a hint, not an address.** Every paste moves every line
  below it, and the reader has been editing too. Anchor on the text quoted under
  **Where it comes from**; if that text is gone, use the section it names. If
  neither is there any more, do not guess: leave the question open and report it
  as not applied, with what you looked for.
- **Paste it verbatim.** Do not reword it, do not improve it, do not reflow it
  to your own idea of the line width. The block was written in the
  specification's voice for exactly this.
- **A `<placeholder>` is filled in only with a value the reader supplied** - in
  the block, in prose next to it, or in the chat. An unfilled placeholder means
  the question is not answered yet; leave it open and say so.
- **Keep the document consistent around the paste.** Heading level, list style,
  tense and the words the specification already uses for things. If the new text
  makes a neighbouring sentence false, or contradicts another section, fix that
  too - and report each such edit on its own line, because it is a change no
  answer asked for.
- Work one question at a time, top to bottom, and re-read the file between
  edits rather than trusting the line numbers you read at the start.

Nothing outside `SPECIFICATION.md` changes here. If an answer's text implies an
agent, a tool grant, a script or a skill, that is the next `/sync-with-spec`
pass's work, and saying so is all you do about it.

## 4. Mark the question answered

Move the whole `###` block of each answered question to the end of the file,
under:

```markdown
## ✅ Answered - folded into the specification
```

Keep its number and its original emoji, so a link to it still resolves and the
number is never reused. Replace everything under the heading with, in this
order:

- **Answered** - the chosen answer's line, verbatim, without its `[ ]` box, or
  the reader's own words where they wrote their own.
- **In the specification** - a link to the line it now occupies,
  `[SPECIFICATION.md#L66](SPECIFICATION.md#L66)`, and the new text quoted as a
  blockquote.
- **Still to implement** - one line saying what has to change in the project for
  the specification to be true again, or `Nothing - the project already does
this.`

That last line is what the next `/sync-with-spec` works from, so write it as
work, not as a summary.

Then bring the top of the file back into step: the opening paragraph's count of
open questions, and the contents list - an answered line keeps its link and
shows the answer that won in place of what was built. Drop a heading that has no
questions left under it, and add no markdown tables to this file.

## 5. You are the typist, not the reader

Do not answer a question yourself, do not soften a chosen answer because you
would have chosen another, and do not add a requirement nobody asked for. An
answer you think is wrong is still the answer; say why in the chat and leave the
text alone.

Do not run `zen check`, `scripts/_setup.sh` or anything under `.spec-sync/`. The
baseline moves at the end of a `/sync-with-spec` pass and nowhere else -
committing it here would record a specification as applied that nothing has
implemented yet.

## 6. Report

In the chat:

- each question you answered, and which answer won
- every line of `SPECIFICATION.md` that changed, and what it says now
- every edit you made that no answer asked for, and what made it necessary
- what is still open, split into: more than one answer left, more than one box
  marked, every answer rejected, and could not be applied because the place it
  names is gone
- then, in one line: send `/sync-with-spec` to make the project match the
  specification you have just changed.
