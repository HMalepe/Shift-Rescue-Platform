import { NextResponse, type NextRequest } from "next/server";
import { clearTokens } from "@/lib/session";

/**
 * Cookie writes are illegal in a Server Component render. A dead session
 * therefore lands here (a Route Handler) to drop lp_at/lp_rt, then login.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  await clearTokens();
  return NextResponse.redirect(new URL("/login", request.url));
}
