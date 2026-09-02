import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { readTokens } from "../../../lib/session";
import { refreshSession } from "../../../lib/api";

const API_URL = process.env["API_URL"] ?? "http://localhost:3000";

/**
 * Proxies a signed document link to the API, attaching the access token from
 * this app's own httpOnly cookie.
 *
 * `verification.documentUrl` / `myDocuments.download` mint a RELATIVE signed
 * URL (`/documents/:id?to=...&expires=...&sig=...`), and an `<a href>` to a
 * relative URL resolves against the page's own origin — this dashboard, not
 * the API. That is deliberate, not an oversight: the whole BFF design here is
 * that a browser never talks to the API directly (see
 * docs/GO_LIVE_CHECKLIST.md §7), and the recipient-binding check on the
 * signed URL needs to run against whoever is ACTUALLY signed in, which only
 * this app's session cookie — never a bare API domain — can answer.
 *
 * A route handler rather than a Server Action because a document needs to be
 * openable via a plain link click (`target="_blank"`), which a Server Action
 * cannot serve.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const { accessToken } = await readTokens();
  if (!accessToken) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const search = request.nextUrl.search;
  const fetchOnce = (token: string) =>
    fetch(`${API_URL}/documents/${encodeURIComponent(id)}${search}`, {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
    });

  let upstream = await fetchOnce(accessToken);

  if (upstream.status === 401) {
    const refreshed = await refreshSession();
    if (!refreshed) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    upstream = await fetchOnce(refreshed);
  }

  if (!upstream.ok || !upstream.body) {
    const message = await upstream.text().catch(() => "request failed");
    return NextResponse.json({ error: message }, { status: upstream.status || 502 });
  }

  return new NextResponse(upstream.body, {
    status: 200,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
      "content-disposition": upstream.headers.get("content-disposition") ?? "inline",
      "cache-control": "private, no-store",
    },
  });
}
