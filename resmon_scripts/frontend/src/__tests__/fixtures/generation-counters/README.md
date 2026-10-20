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

## Blinding a rule on purpose: two ways to get a wrong answer

Exercising this guard means breaking a rule deliberately and checking that
its fixture case goes red. Both failure modes below happened on the same day,
to two people doing the technique properly, and each one alone is half the
hazard.

**A mutation that fails to compile scores as a catch.** Blinding a rule with
`if (false && ...)` made the suite report "Test suite failed to run" — red,
but red because ts-jest refused the file, which says nothing about whether
the rule still works. Use an edit that compiles: rename the thing a rule
matches on (`effectName === 'useEffectRenamed'`), or move a threshold
(`suspensionPoints(fn).length > 1000`), rather than disabling a branch.

**A mutation that fails to apply scores as a pass.** An attempt to patch
`suspends` searched for `function suspends(` when it is an arrow const. The
substitution matched nothing, the file was never changed, and the suite
reported 9 passed — which reads exactly like the guard surviving the
mutation.

The defense against the second is the same as the defense against the first:
**assert the edit landed before reading what the suite says about it.** Count
the substitution, or diff the file, and only then run. A green suite after a
mutation you did not actually make is the most expensive kind of evidence
here, because it is evidence for the conclusion you were hoping for.
