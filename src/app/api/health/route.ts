import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({
    ok: true,
    service: "arbitrai-frontend",
    timestamp: new Date().toISOString()
  });
}
