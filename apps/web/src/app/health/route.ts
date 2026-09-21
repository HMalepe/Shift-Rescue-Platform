import { NextResponse } from "next/server";

/** Railway / load-balancer probe. No auth, no API call. */
export function GET(): NextResponse {
  return NextResponse.json({ status: "ok" });
}
