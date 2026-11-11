/** Placeholder for tabs that land in later slices. */
export function Soon({ title }: { title: string }) {
  return (
    <>
      <div className="nf status-spacer" />
      <div className="row nf screen-title">
        <span>{title}</span>
      </div>
      <main className="col f1 missing">
        <p className="missing-body">This tab is coming soon.</p>
      </main>
    </>
  );
}
