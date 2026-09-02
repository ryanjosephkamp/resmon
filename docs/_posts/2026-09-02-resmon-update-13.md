---
layout: post
title: "resmon Update 13 — September 2, 2026"
date: 2026-09-02 18:00:00 -0400
categories: [updates]
---

# Update 13 — What the First Real Use Found

## Metadata

- **Update number:** 13
- **Version:** 1.8.2 → 1.8.3
- **Theme:** fixing what a person found by actually using it

## The short version

Someone sat down with v1.8.2 and worked through it properly for the first time. Everything in
this release comes from that.

The headline is a little embarrassing and worth stating plainly: **two of the seventeen tools
resmon exposes to AI assistants had never worked.** Not "worked badly" — never returned anything
for any input, since the day they shipped. If you asked your assistant *"what did my last run
find?"*, it could not tell you.

They work now. So does back and forward navigation, which turns out never to have existed either.

## The tools that never worked

`get_execution_results` — the one behind "what did my last run find" — asked resmon for its
papers in a format resmon does not produce. Every call failed. The obvious fallback, exporting
references for a run, was broken in a different way and failed too. Both routes from *a run* to
*its papers* were severed.

Fixing it added something worth having on its own: **references now export as JSON**, alongside
BibTeX, RIS and CSV. That is for programs rather than reference managers — the same fields as the
CSV export, with a missing value as `null` rather than an empty string, so a script can tell
"nothing here" from "blank". It is available through the API and to AI assistants. It is not in
the interface yet, because the interface joins several runs into one file and two JSON lists do
not join into a valid one.

### Why the tests did not catch it

This is the part worth reading, because it is the part that stops it happening again.

The tests used a stand-in for resmon rather than the real thing, and **the stand-in threw away the
exact detail the bug lived in**. It could not have failed the way the real program failed. The
tests passed, sincerely, while the feature was broken for everyone.

And the check that was described as testing the whole tool surface had actually tried six tools of
seventeen. The two broken ones were among the eleven never tried.

There is now a test that runs **every** tool against a real, running copy of resmon, and it is
written so that adding a new tool without testing it is not possible. Reverting either bug fails
it immediately.

## Talking to the wrong resmon

If you had an older resmon running in the background — a daemon from an earlier version, say —
your AI assistant could quietly connect to *that* instead of the app you had open, and answer
every question perfectly truthfully about a completely different library.

resmon now checks. If it finds a version it was not built to speak for, it says so and stops,
rather than reporting someone else's papers as yours.

## The window no longer flashes

resmon flashed white when it opened and again when it closed. The window was never told what
colour it was before its contents loaded, so the system filled it with white. It is now told.

## Back and forward

**Browser-style navigation never worked, and it turns out it was never connected.** resmon has
kept a page history the whole time; nothing was ever wired to it, because the app used the
default menu, which has no Back or Forward.

There is now a **History** menu, the keyboard shortcuts you would expect (`⌘[` and `⌘]`, or `⌘←`
and `⌘→`), and the two-finger swipe on a trackpad — if you have that gesture switched on in System
Settings, which resmon has no way of knowing, which is why the menu is there too.

## Links behave the same way everywhere

On the **Repositories** page, some links opened in a small window inside resmon and others threw
you out to your browser — on the same page, for the same kind of link.

They all open in the small window now. It shows the full address in its title bar, where the page
cannot overwrite it, and right-clicking offers **Copy Link**, **Open in Browser**, plus back,
forward and reload. And the attribution links at the top of that page are no longer a barely-legible
dark blue.

## Two sources that looked broken

Open Library and NDL Search had returned nothing on every attempt, and it was reasonable to wonder
whether they worked at all. Running them properly separated three different things.

**NDL was never broken.** It handles short date windows fine. The empty results were the searches
— "LLM" genuinely matches nothing in the slice of the Japanese national bibliography resmon is
permitted to use, while "test" and "history" return plenty.

**Open Library works as designed, and the design will surprise you.** It can only filter by
publication *year*, so resmon only asks it about whole calendar years that fit inside your date
range. A three-month window contains no whole year, so it matches nothing — by construction, not
by fault. That is written in its entry on the Repositories page.

**But one real bug came out of looking.** When NDL has no matches, it does not return an empty
list — it returns a short notice saying "no records". resmon read that as a broken response and
logged that the source had returned malformed data. The count you saw was right; what resmon said
about it was not. It now reports a legitimate zero as a zero, while a genuinely broken response is
still reported as broken.

## Also

- **American English throughout**, in the app and the documentation. Two things were deliberately
  left alone: the word "cancelled", which is a value stored in your database and cannot change
  without a migration, and any text quoting another organisation's terms word for word — changing
  a quotation would misrepresent it.

## Verification

- 882 automated tests, 41 of them against real scholarly APIs, 139 in the interface.
- Green on Python 3.10, 3.11 and 3.12.
- No new dependencies. No database change.
- The window and menu changes are in a part of the app that automated tests do not reach; they
  were checked by building and running it.
