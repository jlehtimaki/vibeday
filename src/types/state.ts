import { z } from "zod";

// Budget schema
export const BudgetSchema = z.object({
  amount: z.number().positive(),
  currency: z.string().length(3), // ISO currency code
});
export type Budget = z.infer<typeof BudgetSchema>;

// Preferences schema
export const PreferencesSchema = z.object({
  vibe: z.array(z.string()).default([]),
  dietary: z.array(z.string()).default([]),
  alcoholOk: z.boolean().default(true),
  walking: z.enum(["low", "medium", "high"]).default("medium"),
  indoorsPreferred: z.boolean().default(false),
  likes: z.array(z.string()).default([]),
  familyFriendly: z.boolean().default(false),
});
export type Preferences = z.infer<typeof PreferencesSchema>;

// Location schema
export const LocationSchema = z.object({
  lat: z.number(),
  lng: z.number(),
});
export type Location = z.infer<typeof LocationSchema>;

// Venue schema (from Google Places)
export const VenueSchema = z.object({
  name: z.string(),
  placeId: z.string(),
  mapsUrl: z.string().url(),
  address: z.string(),
  location: LocationSchema,
  priceLevel: z.number().min(0).max(4).optional(),
  rating: z.number().min(0).max(5).optional(),
  reviewCount: z.number().optional(),
  openingHours: z.record(z.string()).optional(),
  category: z.string(),
});
export type Venue = z.infer<typeof VenueSchema>;

// Stop schema (a stop in the itinerary)
export const StopSchema = z.object({
  time: z.string(), // HH:MM format
  label: z.string(), // e.g., "Arrival drink", "Main activity", "Dinner"
  venue: VenueSchema,
  estimatedCostRange: z.tuple([z.number(), z.number()]), // [min, max] per person
  whyItFits: z.string(),
  travelFromPrevMins: z.number(),
  openCheck: z.string(), // "Standard (confirm in Maps)" or "Verified: Open at [time]"
});
export type Stop = z.infer<typeof StopSchema>;

// Backup venue schema
export const BackupSchema = z.object({
  label: z.string(), // e.g., "Dinner backup", "Activity backup"
  name: z.string(),
  mapsUrl: z.string().url(),
  whyBackup: z.string(),
});
export type Backup = z.infer<typeof BackupSchema>;

// Plan schema
export const PlanSchema = z.object({
  id: z.enum(["A", "B", "C"]),
  title: z.string(),
  stops: z.array(StopSchema),
  backups: z.array(BackupSchema),
});
export type Plan = z.infer<typeof PlanSchema>;

// Call budget tracking
export const CallBudgetSchema = z.object({
  placesSearch: z.number().default(0),
  placeDetails: z.number().default(0),
  routes: z.number().default(0),
});
export type CallBudget = z.infer<typeof CallBudgetSchema>;

// Call budget limits (from PRD)
export const CALL_BUDGET_LIMITS = {
  placesSearch: 3,
  placeDetails: 6,
  routes: 2,
} as const;

// Swap menu item
export const SwapMenuItemSchema = z.object({
  swap: z.string(), // e.g., "rain_mode", "budget_lower", "no_alcohol", "more_walkable"
  instruction: z.string(),
});
export type SwapMenuItem = z.infer<typeof SwapMenuItemSchema>;

// Budget breakdown
export const BudgetBreakdownSchema = z.object({
  planATotal: z.tuple([z.number(), z.number()]), // [min, max]
  byCategory: z.record(z.tuple([z.number(), z.number()])),
});
export type BudgetBreakdown = z.infer<typeof BudgetBreakdownSchema>;

// Booking checklist item
export const BookingChecklistItemSchema = z.object({
  venue: z.string(),
  priority: z.enum(["high", "medium", "low"]),
  note: z.string(),
});
export type BookingChecklistItem = z.infer<typeof BookingChecklistItemSchema>;

// Itinerary skeleton slot
export const SkeletonSlotSchema = z.object({
  label: z.string(),
  type: z.enum(["drinks", "activity", "dinner", "dessert", "scenic"]),
  budgetPercent: z.number().min(0).max(100),
  timeStart: z.string().optional(), // HH:MM
  durationMins: z.number().optional(),
});
export type SkeletonSlot = z.infer<typeof SkeletonSlotSchema>;

// Full itinerary skeleton
export const SkeletonSchema = z.object({
  slots: z.array(SkeletonSlotSchema),
  totalBudget: z.number(),
  timeWindow: z.object({
    start: z.string(), // HH:MM
    end: z.string(),
  }),
});
export type Skeleton = z.infer<typeof SkeletonSchema>;

// Candidate pools (venues grouped by category)
export const CandidatePoolsSchema = z.object({
  activity: z.array(VenueSchema).default([]),
  dinner: z.array(VenueSchema).default([]),
  finish: z.array(VenueSchema).default([]),
});
export type CandidatePools = z.infer<typeof CandidatePoolsSchema>;

// Agent mode
export const ModeSchema = z.enum(["standard", "verified"]);
export type Mode = z.infer<typeof ModeSchema>;

// Main agent state
export interface AgentState {
  // Messages output (for LangGraph Cloud compatibility)
  messages: unknown[]; // BaseMessage[] but keeping as unknown to avoid import

  // Input
  query: string;
  city: string;
  dateContext: string;
  dateResolved?: string; // YYYY-MM-DD
  timeWindow?: string; // HH:MM-HH:MM
  budget: Budget;
  partySize: number;
  preferences: Preferences;
  mode: Mode;
  timezone: string;
  paid: boolean;

  // User's specific requested activities (e.g., ["golf", "dinner"])
  requestedActivities: string[];

  // Processing
  skeleton?: Skeleton;
  candidatePools: CandidatePools;
  selectedVenues: Record<string, Venue>;
  travelTimes: Record<string, number>; // "placeId1->placeId2": minutes

  // Output
  plans: Plan[];
  budgetBreakdown?: BudgetBreakdown;
  bookingChecklist: BookingChecklistItem[];
  swapMenu: SwapMenuItem[];
  callBudget: CallBudget;

  // Control flow
  error?: string;
}

// Input request schema (for API validation)
export const AgentInputSchema = z.object({
  query: z.string().min(1),
  city: z.string().min(1),
  dateContext: z.string().min(1),
  budget: BudgetSchema,
  partySize: z.number().int().positive().default(2),
  preferences: PreferencesSchema.optional().default({}),
  mode: ModeSchema.optional().default("standard"),
  timezone: z.string().default("UTC"),
  paid: z.boolean(),
});
export type AgentInput = z.infer<typeof AgentInputSchema>;

// Create initial state from input
export function createInitialState(input: AgentInput): AgentState {
  return {
    // Messages output (for LangGraph Cloud compatibility)
    messages: [],

    // Input
    query: input.query,
    city: input.city,
    dateContext: input.dateContext,
    budget: input.budget,
    partySize: input.partySize,
    preferences: input.preferences ?? {
      vibe: [],
      dietary: [],
      alcoholOk: true,
      walking: "medium",
      indoorsPreferred: false,
      likes: [],
      familyFriendly: false,
    },
    mode: input.mode ?? "standard",
    timezone: input.timezone,
    paid: input.paid,

    // User's specific requested activities - will be populated by agent
    requestedActivities: [],

    // Processing - initialized empty
    candidatePools: {
      activity: [],
      dinner: [],
      finish: [],
    },
    selectedVenues: {},
    travelTimes: {},

    // Output - initialized empty
    plans: [],
    bookingChecklist: [],
    swapMenu: [],
    callBudget: {
      placesSearch: 0,
      placeDetails: 0,
      routes: 0,
    },
  };
}
