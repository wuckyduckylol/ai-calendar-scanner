function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

export default {
  async fetch(request) {
    // Easy browser test
    if (request.method === "GET") {
      return json({
        ok: true,
        service: "AI Calendar Scanner",
      });
    }

    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    // Protect this endpoint so strangers cannot spend your API credits
    const scannerKey = request.headers.get("x-scanner-key");

    if (
      !process.env.SCANNER_SECRET ||
      scannerKey !== process.env.SCANNER_SECRET
    ) {
      return json({ error: "Unauthorized" }, 401);
    }

    let body;

    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    const text = body?.text;
    const timezone = body?.timezone || "America/New_York";

    if (typeof text !== "string" || !text.trim()) {
      return json({ error: "Missing text" }, 400);
    }

    // Prevent an accidentally enormous queue from creating a huge API call
    if (text.length > 120000) {
      return json(
        {
          error: "Input is too large",
          length: text.length,
        },
        413
      );
    }

    const instructions = `
You are a calendar-event extraction system.

Analyze communications belonging to the user.

The user's timezone is ${timezone}.

The input may contain multiple emails separated by:
----- EMAIL -----

Each email may contain:
SUBJECT
FROM
RECEIVED
BODY

IMPORTANT DATE RULES:
- RECEIVED timestamps may be UTC.
- Interpret relative phrases such as "today", "tomorrow",
  "next Tuesday", and "this Friday" relative to the RECEIVED
  timestamp of that specific communication.
- Convert dates appropriately for ${timezone}.
- Never invent a date.
- Never invent a time.
- Never invent a location.
- If an event has a definite date but the time is unknown,
  start_time may be null and needs_review must be true.
- Do not include an item if even the date is too ambiguous.

INCLUDE genuine future calendar events such as:
- meetings
- appointments
- classes or special class sessions
- exams
- interviews
- study sessions
- reservations
- practices
- social plans
- scheduled activities the user is expected to attend

DO NOT INCLUDE:
- advertisements
- promotional sale dates
- package delivery estimates
- newsletters
- random dates mentioned informationally
- past events
- vague suggestions with no actual plan
- things that are merely possible
- spam

For each event:
- Create a short useful title.
- Preserve a location when explicitly stated.
- Preserve the sender/source in source.
- confidence is an integer from 0 to 100.
- needs_review should be true whenever important information
  is ambiguous or missing.

Return only events that genuinely belong on a personal calendar.
`;

    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        events: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              title: {
                type: "string",
              },
              date: {
                type: "string",
                description: "Calendar date in YYYY-MM-DD format",
              },
              start_time: {
                type: ["string", "null"],
                description: "24-hour HH:mm format, or null",
              },
              end_time: {
                type: ["string", "null"],
                description: "24-hour HH:mm format, or null",
              },
              location: {
                type: ["string", "null"],
              },
              source: {
                type: "string",
              },
              confidence: {
                type: "integer",
                minimum: 0,
                maximum: 100,
              },
              needs_review: {
                type: "boolean",
              },
            },
            required: [
              "title",
              "date",
              "start_time",
              "end_time",
              "location",
              "source",
              "confidence",
              "needs_review",
            ],
          },
        },
      },
      required: ["events"],
    };

    try {
      const openAIResponse = await fetch(
        "https://api.openai.com/v1/responses",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-5.6-terra",

            input: [
              {
                role: "system",
                content: [
                  {
                    type: "input_text",
                    text: instructions,
                  },
                ],
              },
              {
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text,
                  },
                ],
              },
            ],

            text: {
              format: {
                type: "json_schema",
                name: "calendar_events",
                strict: true,
                schema,
              },
            },
          }),
        }
      );

      const data = await openAIResponse.json();

      if (!openAIResponse.ok) {
        console.error("OpenAI error:", data);

        return json(
          {
            error: "OpenAI request failed",
            status: openAIResponse.status,
          },
          500
        );
      }

      let outputText = null;

      for (const item of data.output || []) {
        for (const content of item.content || []) {
          if (content.type === "output_text") {
            outputText = content.text;
            break;
          }
        }

        if (outputText) break;
      }

      if (!outputText) {
        return json(
          {
            error: "No structured output returned",
          },
          500
        );
      }

      const result = JSON.parse(outputText);

      return json(result);
    } catch (error) {
      console.error(error);

      return json(
        {
          error: "Server error",
        },
        500
      );
    }
  },
};
