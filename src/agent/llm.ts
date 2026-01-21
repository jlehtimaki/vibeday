import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

// Initialize the LLM
export function createLLM() {
  return new ChatOpenAI({
    modelName: "gpt-4o",
    temperature: 0.3, // Lower temperature for more consistent parsing
  });
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

  // Extracted preferences
  vibes: z
    .array(z.string())
    .describe("Vibes/moods extracted (romantic, adventurous, relaxed, fancy, playful, cozy, etc.)"),
  likes: z
    .array(z.string())
    .describe("Activities/interests mentioned (museums, wine, views, live music, etc.)"),
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

Extract these fields from the user's message:

**REQUIRED:**
- city: The city name (Helsinki, Barcelona, Paris, etc.)
- budgetAmount: Number (e.g., 100 from "$100" or "100 euros"). Default: 100
- budgetCurrency: "EUR", "USD", or "GBP". Default: "EUR"
- dateResolved: YYYY-MM-DD format. Convert "next Saturday", "tomorrow", etc.
- timeWindowStart: HH:MM (24h). Evening=18:00, afternoon=12:00, morning=10:00
- timeWindowEnd: HH:MM (24h). Evening=23:30, afternoon=18:00, morning=14:00

**PREFERENCES:**
- vibes: Array of moods (romantic, adventurous, relaxed, fancy, playful, cozy)
- likes: Array of interests (museums, wine, views, live music, food)
- dietary: Array of restrictions (vegetarian, vegan, gluten-free)
- partySize: Number. Default 2 for dates, 3-4 for family
- familyFriendly: true if family/kids/children mentioned
- walkingTolerance: "low" (kids/elderly), "medium" (default), "high" (active)
- indoorsPreferred: true if rain/cold mentioned

**CRITICAL - alcoholOk:**
Set to FALSE if ANY of these appear:
- "don't drink", "I don't drink"
- "no drinks", "no alcohol", "no drinking"
- "alcohol-free", "sober", "dry"
- familyFriendly is true

Set to TRUE only if user does NOT mention avoiding alcohol.

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
