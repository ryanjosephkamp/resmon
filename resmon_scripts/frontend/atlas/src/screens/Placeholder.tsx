/** A section of the top bar whose screen this renderer does not have yet. */
export function Placeholder({ title }: { title: string }) {
  return (
    <section className="page page-narrow" aria-labelledby="page-title">
      <h1 id="page-title" className="page-title">{title}</h1>
      <p className="page-lede">Not built in this interface yet. The classic interface still has it.</p>
    </section>
  );
}
