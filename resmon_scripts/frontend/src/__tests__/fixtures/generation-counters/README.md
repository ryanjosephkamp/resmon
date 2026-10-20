One known-bad file per rule in `../../generationCounterShape.test.ts`.

The guard's five original cases all assert the renderer is *clean*. None of
them asserted that a rule still fires, so two of the three could be blinded
with the suite staying green — including the one whose `LibraryDetail`
demonstration is the whole argument for the guard existing. A check that can
stop working without anything going red cannot support the claim that it will
catch the next instance, which is the same mistake the guard was written to
name, one level up.

These files are deliberately wrong. They are skipped by the scan of the
renderer, because everything under `__tests__` is, and are scanned only by the
cases that pin each rule. They are real TSX and are typechecked, so they
cannot rot into something that no longer expresses the shape.
