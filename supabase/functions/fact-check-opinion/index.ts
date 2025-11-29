import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface RequestBody {
  opinionText: string;
  topicTitle: string;
  topicDescription?: string;
}

interface FactCheckResult {
  verdict: "true" | "false" | "mixed" | "unverifiable";
  explanation: string;
  sources?: string[];
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    const { opinionText, topicTitle, topicDescription }: RequestBody = await req.json();

    if (!opinionText || !topicTitle) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    console.log("========== NEW FACT CHECK REQUEST ==========");
    console.log("Topic:", topicTitle);
    console.log("Opinion:", opinionText);

    const geminiApiKey = Deno.env.get("GEMINI_API_KEY");
    if (!geminiApiKey) {
      console.error("GEMINI_API_KEY not found in environment variables");
      return new Response(
        JSON.stringify({ error: "API key not configured" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const prompt = `You are a professional fact-checker. Analyze the following opinion about a debate topic and fact-check the claims made.

Topic: ${topicTitle}
${topicDescription ? `Description: ${topicDescription}` : ""}

Opinion to fact-check: ${opinionText}

Provide a thorough fact-check analysis in JSON format with the following structure:
{
  "verdict": "true" | "false" | "mixed" | "unverifiable",
  "explanation": "A detailed explanation of the fact-check findings, addressing specific claims",
  "sources": ["List of relevant sources or references that support the fact-check"]
}

Be objective, balanced, and cite why claims are accurate, inaccurate, partially true, or cannot be verified.`;

    console.log("Calling Gemini API for fact-checking...");

    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: prompt
            }]
          }]
        }),
      }
    );

    if (!geminiResponse.ok) {
      const errorText = await geminiResponse.text();
      console.error("Gemini API error:", geminiResponse.status, errorText);
      return new Response(
        JSON.stringify({ error: "Fact-check AI failed" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const geminiData = await geminiResponse.json();
    console.log("Gemini response:", JSON.stringify(geminiData, null, 2));

    if (!geminiData.candidates?.[0]?.content?.parts?.[0]?.text) {
      console.error("Unexpected Gemini response format");
      return new Response(
        JSON.stringify({ error: "Invalid AI response" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const aiResponse = geminiData.candidates[0].content.parts[0].text;
    console.log("AI response text:", aiResponse);

    let factCheckResult: FactCheckResult;

    try {
      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        factCheckResult = JSON.parse(jsonMatch[0]);
      } else {
        factCheckResult = {
          verdict: "unverifiable",
          explanation: aiResponse,
          sources: []
        };
      }
    } catch (parseError) {
      console.error("Error parsing AI response as JSON:", parseError);
      factCheckResult = {
        verdict: "unverifiable",
        explanation: aiResponse,
        sources: []
      };
    }

    console.log("✓ Fact Check Complete:", factCheckResult.verdict.toUpperCase());
    console.log("==========================================");

    return new Response(
      JSON.stringify(factCheckResult),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Error in fact-check-opinion:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});