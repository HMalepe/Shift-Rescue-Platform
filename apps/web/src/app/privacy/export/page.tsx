import Link from "next/link";
import { api } from "@/lib/api";
import { requireViewer } from "@/lib/guard";
import { Masthead } from "@/components/Masthead";

/**
 * The export itself.
 *
 * Rendered on the page rather than served as a download. An export file is a
 * copy of someone's most sensitive data that then lives in a downloads folder,
 * gets attached to an email, and outlives the minute they wanted to look at
 * it. Showing it behind an authenticated page keeps it where it belongs; the
 * browser's own "save as" is still there for anyone who genuinely wants a file.
 */
export default async function ExportPage() {
  const viewer = await requireViewer();
  const dump = await api.query<Record<string, unknown>>("privacy.exportMine");
  const notes = (dump["notes"] as string[]) ?? [];

  return (
    <>
      <Masthead role={viewer.role} />
      <main className="shell" style={{ maxWidth: "56rem" }}>
        <p className="dim" style={{ marginBottom: "0.5rem" }}>
          <Link href="/privacy">← Your data</Link>
        </p>
        <h1>Everything we hold about you</h1>

        <ul className="lede">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>

        <div className="scroll-x card">
          <pre className="mono" style={{ margin: 0, whiteSpace: "pre-wrap" }}>
            {JSON.stringify(dump, null, 2)}
          </pre>
        </div>
      </main>
    </>
  );
}
