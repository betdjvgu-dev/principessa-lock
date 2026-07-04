export default function HomePage() {
  return (
    <main style={{ fontFamily: "sans-serif", margin: "3rem auto", maxWidth: 760, lineHeight: 1.6, padding: "0 1rem" }}>
      <h1>Principessa Lock Backend</h1>
      <p>Phase 0 and Phase 1 are implemented in this repository.</p>
      <p>
        Start with <code>docs/architecture.md</code>, apply <code>supabase/schema.sql</code>, then use the API routes
        documented in <code>docs/manual-testing.md</code>.
      </p>
    </main>
  );
}
