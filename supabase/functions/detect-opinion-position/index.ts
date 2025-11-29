import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface RequestBody {
  topicTitle: string;
  topicDescription: string;
  opinionText: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    const { topicTitle, topicDescription, opinionText }: RequestBody = await req.json();

    if (!topicTitle || !opinionText) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    console.log("========== NEW CLASSIFICATION REQUEST ==========");
    console.log("Topic:", topicTitle);
    console.log("Description:", topicDescription);
    console.log("Opinion:", opinionText);

    const geminiApiKey = Deno.env.get("GEMINI_API_KEY");
    if (!geminiApiKey) {
      console.error("GEMINI_API_KEY not found in environment variables");
      return new Response(
        JSON.stringify({ error: "API key not configured", position: "supporting" }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const prompt = `You are analyzing an opinion about a debate topic to determine if the person is supporting or opposing the topic.

Topic: ${topicTitle}
${topicDescription ? `Description: ${topicDescription}` : ""}

Opinion: ${opinionText}

Analyze this opinion carefully and determine if the person is:
- "supporting" the topic (agreeing with it, in favor of it, seeing it positively)
- "opposing" the topic (disagreeing with it, against it, seeing it negatively)

Respond with ONLY one word: either "supporting" or "opposing".`;

    console.log("Calling Gemini API...");

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
        JSON.stringify({ error: "AI classification failed", position: "supporting" }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const geminiData = await geminiResponse.json();
    console.log("Gemini response:", JSON.stringify(geminiData, null, 2));

    let position: "supporting" | "opposing" = "supporting";

    if (geminiData.candidates && geminiData.candidates[0]?.content?.parts?.[0]?.text) {
      const aiResponse = geminiData.candidates[0].content.parts[0].text.toLowerCase().trim();
      console.log("AI response text:", aiResponse);

      if (aiResponse.includes("opposing")) {
        position = "opposing";
      } else if (aiResponse.includes("supporting")) {
        position = "supporting";
      }
    }

    console.log("✓ Final Classification:", position.toUpperCase());
    console.log("========================================");

    return new Response(
      JSON.stringify({ position }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Error in detect-opinion-position:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error", position: "supporting" }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});