import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const audioUrl = request.nextUrl.searchParams.get("url");

  if (!audioUrl) {
    return NextResponse.json({ error: "Missing 'url' parameter" }, { status: 400 });
  }

  if (!audioUrl.startsWith("https://storage.googleapis.com/")) {
    return NextResponse.json({ error: "Invalid audio URL domain" }, { status: 400 });
  }

  try {
    const response = await fetch(audioUrl, { method: "GET", cache: "no-store" });
    if (!response.ok) {
      return NextResponse.json(
        { error: `Failed to fetch audio: ${response.statusText}` },
        { status: response.status }
      );
    }

    const audioBuffer = await response.arrayBuffer();
    return new NextResponse(audioBuffer, {
      status: 200,
      headers: {
        "Content-Type": response.headers.get("Content-Type") || "audio/wav",
        "Content-Length": audioBuffer.byteLength.toString(),
        "Cache-Control": "public, max-age=300",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to proxy audio";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
