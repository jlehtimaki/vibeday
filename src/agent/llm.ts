import { ChatOpenAI } from "@langchain/openai";
import OpenAI from "openai";
import { z } from "zod";

// Simple LLM interface for xAI that doesn't send unsupported parameters
class XaiLLM {
  private client: OpenAI;
  private model: string;
  private temperature: number;

  constructor(apiKey: string, model: string, temperature: number) {
    this.client = new OpenAI({
      apiKey,
      baseURL: "https://api.x.ai/v1",
    });
    this.model = model;
    this.temperature = temperature;
  }

  async invoke(messages: Array<{ role: string; content: string }>) {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: messages.map((m) => ({
        role: m.role as "system" | "user" | "assistant",
        content: m.content,
      })),
      temperature: this.temperature,
    });

    return {
      content: response.choices[0]?.message?.content ?? "",
    };
  }
}

// Initialize the LLM - uses xAI (Grok) by default, falls back to OpenAI
export function createLLM() {
  const xaiKey = process.env.XAI_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (xaiKey) {
    // Use xAI (Grok) with custom wrapper to avoid unsupported parameters
    return new XaiLLM(xaiKey, "grok-4-1-fast-reasoning", 0.3);
  }

  if (openaiKey) {
    // Fallback to OpenAI
    return new ChatOpenAI({
      modelName: "gpt-4o",
      temperature: 0.3,
    });
  }

  throw new Error("No API key found. Set XAI_API_KEY or OPENAI_API_KEY.");
}

// Schema for parsed request - extracts ALL information from user's natural language
export const ParsedRequestSchema = z.object({
  // Core extracted fields
  city: z
    .string()
    .describe("City name extracted from query (e.g., 'Helsinki', 'Barcelona', 'Paris'). REQUIRED."),
  budgetAmount: z
    .number()
    .describe("Budget amount extracted (e.g., 100 from '$100' or '100 euros'). Default to 100 if not specified."),
  budgetCurrency: z
    .string()
    .describe("Currency code: 'EUR' for euros/€, 'USD' for dollars/$, 'GBP' for pounds/£. Default to 'EUR'."),

  // Date/time parsing
  dateResolved: z
    .string()
    .describe("Resolved date in YYYY-MM-DD format"),
  timeWindowStart: z
    .string()
    .describe("Start time in HH:MM format (24-hour)"),
  timeWindowEnd: z
    .string()
    .describe("End time in HH:MM format (24-hour)"),

  // SPECIFIC REQUESTED ACTIVITIES - what the user explicitly wants to do
  requestedActivities: z
    .array(z.string())
    .describe("SPECIFIC activities the user explicitly wants to do. E.g., 'play golf', 'visit museum', 'go to beach', 'have dinner', 'get drinks'. Extract the EXACT activities mentioned, not generic interests."),

  // Extracted preferences
  vibes: z
    .array(z.string())
    .describe("Vibes/moods extracted (romantic, adventurous, relaxed, fancy, playful, cozy, etc.)"),
  likes: z
    .array(z.string())
    .describe("General interests mentioned (museums, wine, views, live music, etc.)"),
  dietary: z
    .array(z.string())
    .describe("Dietary restrictions mentioned (vegetarian, vegan, gluten-free, etc.)"),

  // Inferred settings
  partySize: z
    .number()
    .describe("Party size: 2 for date/couple, 3-4 for family, or as mentioned. Default 2."),
  familyFriendly: z
    .boolean()
    .describe("True if family/kids/children mentioned"),
  alcoholOk: z
    .boolean()
    .describe("FALSE if: 'no drinks', 'don't drink', 'no alcohol', 'sober', or family/kids. TRUE otherwise."),
  indoorsPreferred: z
    .boolean()
    .describe("Whether indoor venues are preferred (rain/cold mentioned)"),
  walkingTolerance: z
    .enum(["low", "medium", "high"])
    .describe("low if kids/elderly, high if active/hiking, medium otherwise"),
});

export type ParsedRequest = z.infer<typeof ParsedRequestSchema>;

// System prompt for parsing - extracts ALL info from user's natural language
export const PARSE_SYSTEM_PROMPT = `You are an outing/itinerary planning assistant. Extract ALL structured information from the user's request.

Today's date is: {{TODAY_DATE}}

**MOST IMPORTANT - requestedActivities:**
Extract the SPECIFIC activities the user explicitly wants to do, in order. Examples:
- "play golf and have dinner" → ["golf", "dinner"]
- "visit a museum, then lunch, then shopping" → ["museum", "lunch", "shopping"]
- "beach day with dinner after" → ["beach", "dinner"]
- "romantic evening with drinks and dinner" → ["drinks", "dinner"]
- "take kids to zoo and then ice cream" → ["zoo", "ice cream"]

Do NOT add activities the user didn't ask for. Only extract what they explicitly mention.

**REQUIRED:**
- city: The city name (Helsinki, Barcelona, Paris, etc.)
- budgetAmount: Number (e.g., 100 from "$100" or "100 euros"). Default: 100
- budgetCurrency: "EUR", "USD", or "GBP". Default: "EUR"
- dateResolved: YYYY-MM-DD format. Convert "next Saturday", "tomorrow", etc.
- timeWindowStart: HH:MM (24h). Evening=18:00, afternoon=12:00, morning=10:00
- timeWindowEnd: HH:MM (24h). Evening=23:30, afternoon=18:00, morning=14:00

**PREFERENCES:**
- vibes: Array of moods (romantic, adventurous, relaxed, fancy, playful, cozy)
- likes: Array of general interests
- dietary: Array of restrictions (vegetarian, vegan, gluten-free)
- partySize: Number. Default 2 for dates, 3-4 for family
- familyFriendly: true if family/kids/children mentioned
- walkingTolerance: "low" (kids/elderly), "medium" (default), "high" (active)
- indoorsPreferred: true if rain/cold mentioned

**CRITICAL - alcoholOk:**
Set to FALSE if: "don't drink", "no drinks", "no alcohol", "sober", or family/kids.
Set to TRUE otherwise.

Respond with valid JSON only. No explanation needed.`;

// Format the system prompt with current date and timezone
export function formatParsePrompt(timezone: string): string {
  const today = new Date().toISOString().split("T")[0];
  return PARSE_SYSTEM_PROMPT
    .replace("{{TODAY_DATE}}", today ?? "unknown")
    .replace("{{TIMEZONE}}", timezone);
}

// Simple user prompt - just pass the raw message
export function formatUserPrompt(userMessage: string): string {
  return userMessage;
}
