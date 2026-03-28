import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface RequestBody {
  debateTitle: string;
  debateDescription: string;
  supportingLabel: string;
  opposingLabel: string;
  supportingArgs: string[];
  opposingArgs: string[];
}

interface SummaryResult {
  supportingPoints: string[];
  opposingPoints: string[];
  assessment: string;
  dominantSide: "supporting" | "opposing" | "tied";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const { debateTitle, debateDescription, supportingLabel, opposingLabel, supportingArgs, opposingArgs }: RequestBody = await req.json();

    if (!debateTitle || (!supportingArgs?.length && !opposingArgs?.length)) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const geminiApiKey = Deno.env.get("GEMINI_API_KEY");
    if (!geminiApiKey) {
      return new Response(
        JSON.stringify({ error: "API key not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const prompt = `You are an expert debate analyst. Analyze the following debate and provide a structured summary.

Debate Topic: ${debateTitle}
${debateDescription ? `Description: ${debateDescription}` : ""}

${supportingLabel} arguments (${supportingArgs.length}):
${supportingArgs.map((a, i) => `${i + 1}. ${a}`).join("\n") || "None yet"}

${opposingLabel} arguments (${opposingArgs.length}):
${opposingArgs.map((a, i) => `${i + 1}. ${a}`).join("\n") || "None yet"}

Analyze these arguments and respond with JSON in exactly this format:
{
  "supportingPoints": ["key point 1", "key point 2", "key point 3"],
  "opposingPoints": ["key point 1", "key point 2", "key point 3"],
  "assessment": "A 2-3 sentence balanced assessment of the overall debate quality, which side makes stronger arguments, and why.",
  "dominantSide": "supporting" | "opposing" | "tied"
}

Rules:
- Extract 2-4 of the strongest/most distinct key points per side (not just quotes, synthesize them)
- Keep each key point under 15 words
- assessment should be objective and balanced
- dominantSide should reflect which side has stronger, better-supported arguments overall
- If both sides are roughly equal, use "tied"
- Respond ONLY with valid JSON, no extra text`;

    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 800 },
        }),
      }
    );

    if (!geminiResponse.ok) {
      const errorText = await geminiResponse.text();
      console.error("Gemini API error:", errorText);
      return new Response(
        JSON.stringify({ error: "AI summarization failed" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const geminiData = await geminiResponse.json();
    const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "";

    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error("No JSON found in response:", rawText);
      return new Response(
        JSON.stringify({ error: "Invalid AI response format" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const result: SummaryResult = JSON.parse(jsonMatch[0]);

    return new Response(
      JSON.stringify(result),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Summarize debate error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
