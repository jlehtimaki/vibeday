import {
  StateGraph,
  END,
  START,
  messagesStateReducer,
} from "@langchain/langgraph";
import { Annotation } from "@langchain/langgraph";
import { AIMessage, BaseMessage } from "@langchain/core/messages";
import type {
  Budget,
  Preferences,
  CallBudget,
  CandidatePools,
  Plan,
  SwapMenuItem,
  BookingChecklistItem,
  BudgetBreakdown,
  Skeleton,
  Venue,
  Mode,
} from "../types/index.js";
import {
  googlePlacesSearch,
  getCityCenter,
  buildSearchQuery,
  googlePlaceDetails,
  computeItineraryRoute,
  isTravelTimeAcceptable,
} from "../tools/index.js";
import {
  createLLM,
  formatParsePrompt,
  formatUserPrompt,
  ParsedRequestSchema,
} from "./llm.js";
import {
  buildSkeleton as createSkeleton,
  getBudgetForSlot,
} from "./skeleton.js";
import { rankVenues, selectBestVenues } from "./ranking.js";

// Default values for state initialization
const DEFAULT_CALL_BUDGET: CallBudget = {
  placesSearch: 0,
  placeDetails: 0,
  routes: 0,
};
const DEFAULT_CANDIDATE_POOLS: CandidatePools = {
  activity: [],
  dinner: [],
  finish: [],
};
const DEFAULT_PREFERENCES: Preferences = {
  vibe: [],
  dietary: [],
  alcoholOk: true,
  walking: "medium",
  indoorsPreferred: false,
  likes: [],
  familyFriendly: false,
};

// Define the state annotation for LangGraph
// This uses LangGraph's annotation system for proper state management
export const GraphState = Annotation.Root({
  // Messages output (for LangGraph Cloud compatibility)
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),

  // Input fields
  query: Annotation<string>(),
  city: Annotation<string>(),
  dateContext: Annotation<string>(),
  dateResolved: Annotation<string | undefined>(),
  timeWindow: Annotation<string | undefined>(),
  budget: Annotation<Budget>(),
  partySize: Annotation<number>(),
  preferences: Annotation<Preferences>(),
  mode: Annotation<Mode>(),
  timezone: Annotation<string>(),
  paid: Annotation<boolean>(),

  // Processing fields
  skeleton: Annotation<Skeleton | undefined>(),
  candidatePools: Annotation<CandidatePools>(),
  selectedVenues: Annotation<Record<string, Venue>>(),
  travelTimes: Annotation<Record<string, number>>(),

  // Output fields
  plans: Annotation<Plan[]>(),
  budgetBreakdown: Annotation<BudgetBreakdown | undefined>(),
  bookingChecklist: Annotation<BookingChecklistItem[]>(),
  swapMenu: Annotation<SwapMenuItem[]>(),
  callBudget: Annotation<CallBudget>(),

  // Control flow
  error: Annotation<string | undefined>(),
});

export type GraphStateType = typeof GraphState.State;

// Node implementations

// Helper to extract user message from various input formats
function extractUserMessage(state: GraphStateType): string {
  const stateAny = state as Record<string, unknown>;

  // 1. Check messages array (LangGraph Cloud standard pattern)
  // Get the LAST human message, not the first (important for continued threads)
  if (Array.isArray(state.messages) && state.messages.length > 0) {
    // Iterate backwards to find the most recent human message
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const msg = state.messages[i];
      const msgAny = msg as unknown as Record<string, unknown>;

      // Check if this is a HumanMessage (not AIMessage)
      const msgType =
        msgAny.type || (msgAny.constructor as { name?: string })?.name;
      const isHuman =
        msgType === "human" ||
        msgType === "HumanMessage" ||
        msgAny.role === "user" ||
        msgAny.role === "human";

      // Also check lc_id for LangChain message types
      const lcId = msgAny.lc_id as string[] | undefined;
      const isHumanLc = lcId?.includes("HumanMessage");

      if (isHuman || isHumanLc) {
        const content =
          msgAny.content || (msgAny.kwargs as Record<string, unknown>)?.content;
        if (typeof content === "string" && content.length > 0) {
          console.log(
            "[extractUserMessage] Found human message at index",
            i,
            ":",
            content.substring(0, 100),
          );
          return content;
        }
      }
    }

    // Fallback: if no human message found, get the last message with content
    const lastMsg = state.messages[
      state.messages.length - 1
    ] as unknown as Record<string, unknown>;
    if (lastMsg) {
      const content =
        lastMsg.content || (lastMsg.kwargs as Record<string, unknown>)?.content;
      if (typeof content === "string" && content.length > 0) {
        console.log(
          "[extractUserMessage] Fallback to last message:",
          content.substring(0, 100),
        );
        return content;
      }
    }
  }

  // 2. Check common field names
  const candidates = [
    state.query,
    stateAny.message,
    stateAny.text,
    stateAny.input,
    stateAny.prompt,
    stateAny.content,
    stateAny.user_message,
    stateAny.userMessage,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }

  return "";
}

// Initialize state - find user message and set defaults
async function initializeState(
  state: GraphStateType,
): Promise<Partial<GraphStateType>> {
  console.log("[initializeState] === STARTING ===");
  console.log("[initializeState] RAW STATE KEYS:", Object.keys(state));

  // Extract user message from whatever format it comes in
  const userMessage = extractUserMessage(state);
  console.log("[initializeState] Extracted user message:", userMessage);

  // Store the user message in query field for intakeParse to use
  return {
    query: userMessage,
    // Set minimal defaults - intakeParse will extract everything from the message
    city: "",
    dateContext: "",
    budget: { amount: 100, currency: "EUR" },
    partySize: 2,
    mode: state.mode ?? "standard",
    paid: state.paid ?? true,
    preferences: DEFAULT_PREFERENCES,
    timezone: "UTC",

    // Reset processing fields
    callBudget: { placesSearch: 0, placeDetails: 0, routes: 0 },
    candidatePools: { activity: [], dinner: [], finish: [] },
    selectedVenues: {},
    travelTimes: {},
    plans: [],
    swapMenu: [],
    bookingChecklist: [],
    messages: [],
    error: undefined,
  };
}

async function intakeParse(
  state: GraphStateType,
): Promise<Partial<GraphStateType>> {
  const userMessage = state.query ?? "";

  console.log("[intakeParse] === PARSING USER MESSAGE ===");
  console.log("[intakeParse] User message:", userMessage);

  if (!userMessage) {
    console.log("[intakeParse] ERROR: No user message found");
    return { error: "No user message provided" };
  }

  // Check if we have OpenAI API key
  if (!process.env.OPENAI_API_KEY) {
    console.log("[intakeParse] No OPENAI_API_KEY, cannot parse");
    return { error: "OpenAI API key not configured" };
  }

  try {
    const llm = createLLM();
    const systemPrompt = formatParsePrompt("UTC");

    console.log("[intakeParse] Sending to OpenAI:", userMessage);

    const response = await llm.invoke([
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ]);

    // Extract JSON from response
    const content =
      typeof response.content === "string" ? response.content : "";
    console.log("[intakeParse] OpenAI response:", content);

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.log("[intakeParse] No JSON in response");
      return { error: "Failed to parse request - no JSON returned" };
    }

    const parsed = ParsedRequestSchema.safeParse(JSON.parse(jsonMatch[0]));
    if (!parsed.success) {
      console.log(
        "[intakeParse] Schema validation failed:",
        parsed.error.message,
      );
      return { error: `Failed to parse request: ${parsed.error.message}` };
    }

    const result = parsed.data;

    console.log("[intakeParse] === EXTRACTED DATA ===");
    console.log("[intakeParse] City:", result.city);
    console.log(
      "[intakeParse] Budget:",
      result.budgetAmount,
      result.budgetCurrency,
    );
    console.log("[intakeParse] Date:", result.dateResolved);
    console.log(
      "[intakeParse] Time:",
      result.timeWindowStart,
      "-",
      result.timeWindowEnd,
    );
    console.log("[intakeParse] Alcohol OK:", result.alcoholOk);
    console.log("[intakeParse] Family friendly:", result.familyFriendly);
    console.log("[intakeParse] Party size:", result.partySize);

    // Build preferences from extracted data
    const preferences: Preferences = {
      vibe: result.vibes,
      dietary: result.dietary,
      likes: result.likes,
      alcoholOk: result.alcoholOk,
      walking: result.walkingTolerance,
      indoorsPreferred: result.indoorsPreferred,
      familyFriendly: result.familyFriendly,
    };

    return {
      city: result.city,
      budget: { amount: result.budgetAmount, currency: result.budgetCurrency },
      dateResolved: result.dateResolved,
      timeWindow: `${result.timeWindowStart}-${result.timeWindowEnd}`,
      partySize: result.partySize,
      preferences,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.log("[intakeParse] Error:", message);
    return { error: `Failed to parse request: ${message}` };
  }
}

async function buildSkeletonNode(
  state: GraphStateType,
): Promise<Partial<GraphStateType>> {
  // Ensure budget exists with fallback
  const budget = state.budget ?? { amount: 100, currency: "EUR" };
  console.log("[buildSkeleton] Building skeleton for budget:", budget);

  // Parse time window or use defaults
  let startTime = "18:00";
  let endTime = "23:30";

  if (state.timeWindow) {
    const parts = state.timeWindow.split("-");
    if (parts[0]) startTime = parts[0];
    if (parts[1]) endTime = parts[1];
  }

  console.log("[buildSkeleton] Time window:", startTime, "-", endTime);

  // Build the skeleton
  const skeleton = createSkeleton(budget, startTime, endTime);

  console.log(
    "[buildSkeleton] Created skeleton with",
    skeleton.slots.length,
    "slots:",
  );
  for (const slot of skeleton.slots) {
    const budgetAlloc = Math.round((budget.amount * slot.budgetPercent) / 100);
    console.log(
      `  - ${slot.label} (${slot.type}): ${slot.timeStart}, ${slot.durationMins}min, ~${budgetAlloc} ${budget.currency}`,
    );
  }

  return {
    skeleton,
  };
}

async function searchActivity(
  state: GraphStateType,
): Promise<Partial<GraphStateType>> {
  const city = state.city ?? "Barcelona";
  const callBudget = state.callBudget ?? DEFAULT_CALL_BUDGET;
  const preferences = state.preferences ?? DEFAULT_PREFERENCES;

  console.log("[searchActivity] Searching activities in:", city);

  // Get city center coordinates
  const cityCenter = getCityCenter(city);
  if (!cityCenter) {
    return {
      error: `City "${city}" not found in supported cities. Please use a major European city.`,
    };
  }

  // Build search query based on preferences
  const query = buildSearchQuery("activity", city, {
    vibe: preferences.vibe,
    likes: preferences.likes,
    familyFriendly: preferences.familyFriendly,
  });

  console.log("[searchActivity] Query:", query);
  console.log("[searchActivity] Family friendly:", preferences.familyFriendly);

  // Execute search
  const result = await googlePlacesSearch({
    query,
    location: cityCenter,
    radiusMeters: 5000,
    maxResults: 10,
    minRating: 4.0,
  });

  if (result.error) {
    console.log("[searchActivity] Error:", result.error);
  }

  console.log("[searchActivity] Found", result.venues.length, "venues");

  // Update state with results (track calls for cost reporting)
  const pools = state.candidatePools ?? DEFAULT_CANDIDATE_POOLS;
  return {
    candidatePools: {
      ...pools,
      activity: result.venues,
    },
    callBudget: {
      ...callBudget,
      placesSearch: (callBudget.placesSearch ?? 0) + 1,
    },
  };
}

async function searchDinner(
  state: GraphStateType,
): Promise<Partial<GraphStateType>> {
  const city = state.city ?? "Barcelona";
  const callBudget = state.callBudget ?? DEFAULT_CALL_BUDGET;
  const preferences = state.preferences ?? DEFAULT_PREFERENCES;

  console.log("[searchDinner] Searching dinner in:", city);

  // Get city center coordinates
  const cityCenter = getCityCenter(city);
  if (!cityCenter) {
    return {};
  }

  // Build search query based on preferences
  const query = buildSearchQuery("dinner", city, {
    vibe: preferences.vibe,
    dietary: preferences.dietary,
    familyFriendly: preferences.familyFriendly,
  });

  console.log("[searchDinner] Query:", query);

  // Execute search
  const result = await googlePlacesSearch({
    query,
    location: cityCenter,
    radiusMeters: 5000,
    maxResults: 10,
    minRating: 4.0,
  });

  if (result.error) {
    console.log("[searchDinner] Error:", result.error);
  }

  console.log("[searchDinner] Found", result.venues.length, "venues");

  // Update state with results (track calls for cost reporting)
  const pools = state.candidatePools ?? DEFAULT_CANDIDATE_POOLS;
  return {
    candidatePools: {
      ...pools,
      dinner: result.venues,
    },
    callBudget: {
      ...callBudget,
      placesSearch: (callBudget.placesSearch ?? 0) + 1,
    },
  };
}

async function searchFinish(
  state: GraphStateType,
): Promise<Partial<GraphStateType>> {
  const city = state.city ?? "Barcelona";
  const callBudget = state.callBudget ?? DEFAULT_CALL_BUDGET;
  const preferences = state.preferences ?? DEFAULT_PREFERENCES;
  const candidatePools = state.candidatePools ?? DEFAULT_CANDIDATE_POOLS;

  console.log("[searchFinish] Searching finish venues in:", city);

  // Get city center coordinates
  const cityCenter = getCityCenter(city);
  if (!cityCenter) {
    return {};
  }

  // Build search query based on preferences (include alcoholOk and familyFriendly for finish venues)
  const query = buildSearchQuery("finish", city, {
    vibe: preferences.vibe,
    alcoholOk: preferences.alcoholOk,
    familyFriendly: preferences.familyFriendly,
  });

  console.log("[searchFinish] Query:", query);
  console.log("[searchFinish] alcoholOk:", preferences.alcoholOk);
  console.log("[searchFinish] familyFriendly:", preferences.familyFriendly);

  // Execute search
  const result = await googlePlacesSearch({
    query,
    location: cityCenter,
    radiusMeters: 5000,
    maxResults: 10,
    minRating: 4.0,
  });

  if (result.error) {
    console.log("[searchFinish] Error:", result.error);
  }

  // Filter out bars/drinks venues if alcohol is not OK
  let venues = result.venues;
  if (preferences.alcoholOk === false || preferences.familyFriendly === true) {
    venues = venues
      .filter((v) => v.category !== "drinks")
      .map((v) => ({
        ...v,
        // Re-categorize to dessert for finish venues when no alcohol
        category: v.category === "drinks" ? "dessert" : v.category,
      }));
    console.log(
      "[searchFinish] Filtered to non-alcohol venues:",
      venues.length,
    );
  }

  console.log("[searchFinish] Found", venues.length, "venues");

  // Update state with results (track calls for cost reporting)
  return {
    candidatePools: {
      ...candidatePools,
      finish: venues,
    },
    callBudget: {
      ...callBudget,
      placesSearch: (callBudget.placesSearch ?? 0) + 1,
    },
  };
}

async function rankCluster(
  state: GraphStateType,
): Promise<Partial<GraphStateType>> {
  console.log("[rankCluster] Ranking and clustering candidates");

  const pools = state.candidatePools ?? DEFAULT_CANDIDATE_POOLS;
  const budget = state.budget ?? { amount: 100, currency: "EUR" };
  const partySize = state.partySize ?? 2;
  const preferences = state.preferences ?? DEFAULT_PREFERENCES;
  const totalCandidates =
    pools.activity.length + pools.dinner.length + pools.finish.length;

  if (totalCandidates === 0) {
    console.log("[rankCluster] No candidates to rank");
    return {};
  }

  // Calculate budget per category from skeleton
  const skeleton = state.skeleton;
  const budgetPerCategory = {
    activity: skeleton
      ? getBudgetForSlot(skeleton, "activity")
      : budget.amount * 0.25,
    dinner: skeleton
      ? getBudgetForSlot(skeleton, "dinner")
      : budget.amount * 0.5,
    finish: skeleton
      ? getBudgetForSlot(skeleton, "drinks") +
        getBudgetForSlot(skeleton, "dessert")
      : budget.amount * 0.15,
  };

  // Per-person budget (divide by party size)
  const perPersonBudget = {
    activity: budgetPerCategory.activity / partySize,
    dinner: budgetPerCategory.dinner / partySize,
    finish: budgetPerCategory.finish / partySize,
  };

  console.log("[rankCluster] Budget per person:", perPersonBudget);

  // Rank each pool
  const rankedActivity = rankVenues(
    pools.activity,
    preferences,
    perPersonBudget.activity,
  );
  const rankedDinner = rankVenues(
    pools.dinner,
    preferences,
    perPersonBudget.dinner,
  );
  const rankedFinish = rankVenues(
    pools.finish,
    preferences,
    perPersonBudget.finish,
  );

  console.log(`[rankCluster] Ranked ${rankedActivity.length} activities`);
  console.log(`[rankCluster] Ranked ${rankedDinner.length} dinner options`);
  console.log(`[rankCluster] Ranked ${rankedFinish.length} finish venues`);

  // Log top picks
  if (rankedActivity[0]) {
    console.log(
      `[rankCluster] Top activity: ${rankedActivity[0].venue.name} (score: ${rankedActivity[0].score.toFixed(2)})`,
    );
  }
  if (rankedDinner[0]) {
    console.log(
      `[rankCluster] Top dinner: ${rankedDinner[0].venue.name} (score: ${rankedDinner[0].score.toFixed(2)})`,
    );
  }
  if (rankedFinish[0]) {
    console.log(
      `[rankCluster] Top finish: ${rankedFinish[0].venue.name} (score: ${rankedFinish[0].score.toFixed(2)})`,
    );
  }

  // Store ranked venues back in pools (sorted order)
  return {
    candidatePools: {
      activity: rankedActivity.map((r) => r.venue),
      dinner: rankedDinner.map((r) => r.venue),
      finish: rankedFinish.map((r) => r.venue),
    },
  };
}

async function selectFinalists(
  state: GraphStateType,
): Promise<Partial<GraphStateType>> {
  console.log("[selectFinalists] Selecting finalists from ranked candidates");

  const pools = state.candidatePools ?? DEFAULT_CANDIDATE_POOLS;
  const budget = state.budget ?? { amount: 100, currency: "EUR" };
  const partySize = state.partySize ?? 2;
  const preferences = state.preferences ?? DEFAULT_PREFERENCES;

  // Calculate budget per category
  const skeleton = state.skeleton;
  const budgetPerCategory = {
    activity: skeleton
      ? getBudgetForSlot(skeleton, "activity")
      : budget.amount * 0.25,
    dinner: skeleton
      ? getBudgetForSlot(skeleton, "dinner")
      : budget.amount * 0.5,
    finish: skeleton
      ? getBudgetForSlot(skeleton, "drinks") +
        getBudgetForSlot(skeleton, "dessert")
      : budget.amount * 0.15,
  };

  // Per-person budget
  const perPersonBudget = {
    activity: budgetPerCategory.activity / partySize,
    dinner: budgetPerCategory.dinner / partySize,
    finish: budgetPerCategory.finish / partySize,
  };

  // Use the selectBestVenues function which handles proximity re-ranking
  const { selected, backups } = selectBestVenues(
    pools,
    preferences,
    perPersonBudget,
  );

  console.log("[selectFinalists] Selected venues:");
  for (const [category, venue] of Object.entries(selected)) {
    console.log(`  - ${category}: ${venue.name}`);
  }

  console.log("[selectFinalists] Backups:");
  for (const [category, venues] of Object.entries(backups)) {
    console.log(
      `  - ${category}: ${venues.map((v) => v.name).join(", ") || "none"}`,
    );
  }

  // Store backups in a format we can use later (flatten into candidatePools for now)
  // The actual backup extraction will happen in plan generation
  return {
    selectedVenues: selected,
  };
}

async function getDetails(
  state: GraphStateType,
): Promise<Partial<GraphStateType>> {
  console.log("[getDetails] Fetching place details for selected venues");

  // Get venues that need details (from selectedVenues or top candidates from pools)
  const venuesToEnrich: Venue[] = [];

  // If selectedVenues is populated, use those; otherwise use top candidates from pools
  if (Object.keys(state.selectedVenues).length > 0) {
    venuesToEnrich.push(...Object.values(state.selectedVenues));
  } else {
    // Take top 2 from each pool as finalists (will be refined later)
    const pools = state.candidatePools;
    if (pools.activity.length > 0)
      venuesToEnrich.push(...pools.activity.slice(0, 2));
    if (pools.dinner.length > 0)
      venuesToEnrich.push(...pools.dinner.slice(0, 2));
    if (pools.finish.length > 0)
      venuesToEnrich.push(...pools.finish.slice(0, 2));
  }

  console.log(`[getDetails] Need to enrich ${venuesToEnrich.length} venues`);

  let detailsCalls = state.callBudget?.placeDetails ?? 0;
  const enrichedVenues: Record<string, Venue> = {};
  const includeHours = (state.mode ?? "standard") === "verified";

  // Fetch details for each venue
  for (const venue of venuesToEnrich) {
    console.log(`[getDetails] Fetching details for: ${venue.name}`);

    const result = await googlePlaceDetails({
      placeId: venue.placeId,
      includeHours,
    });
    detailsCalls++;

    if (result.error) {
      console.log(`[getDetails] Error for ${venue.name}:`, result.error);
      enrichedVenues[venue.placeId] = venue;
    } else if (result.details) {
      let openingHours = venue.openingHours;
      if (result.details.openingHours?.weekdayDescriptions) {
        openingHours = {};
        result.details.openingHours.weekdayDescriptions.forEach((desc, i) => {
          if (openingHours) {
            openingHours[`day_${i}`] = desc;
          }
        });
      }

      enrichedVenues[venue.placeId] = {
        ...venue,
        rating: result.details.rating ?? venue.rating,
        reviewCount: result.details.reviewCount ?? venue.reviewCount,
        priceLevel: result.details.priceLevel ?? venue.priceLevel,
        openingHours,
      };
    }
  }

  console.log(
    `[getDetails] Enriched ${Object.keys(enrichedVenues).length} venues`,
  );

  return {
    selectedVenues: enrichedVenues,
    callBudget: {
      ...(state.callBudget ?? DEFAULT_CALL_BUDGET),
      placeDetails: detailsCalls,
    },
  };
}

async function validateHours(
  state: GraphStateType,
): Promise<Partial<GraphStateType>> {
  // TODO: Validate opening hours against planned arrival (verified mode)
  console.log("[validateHours] Validating hours");
  return {};
}

async function computeRoutes(
  state: GraphStateType,
): Promise<Partial<GraphStateType>> {
  console.log("[computeRoutes] Computing travel times between venues");

  const callBudget = state.callBudget ?? DEFAULT_CALL_BUDGET;

  // Get the selected venues in order (activity -> dinner -> finish)
  const selectedVenues = state.selectedVenues ?? {};
  const venues = Object.values(selectedVenues);
  if (venues.length < 2) {
    console.log("[computeRoutes] Not enough venues to compute routes");
    return {};
  }

  // Sort venues by category to establish route order
  const categoryOrder = [
    "activity",
    "dinner",
    "drinks",
    "dessert",
    "finish",
    "scenic",
  ];
  const sortedVenues = [...venues].sort((a, b) => {
    const aIndex = categoryOrder.indexOf(a.category);
    const bIndex = categoryOrder.indexOf(b.category);
    return (aIndex === -1 ? 999 : aIndex) - (bIndex === -1 ? 999 : bIndex);
  });

  // Extract locations for route computation
  const stops = sortedVenues.map((v) => v.location);

  console.log(`[computeRoutes] Computing route through ${stops.length} stops`);

  // Compute the itinerary route
  const result = await computeItineraryRoute(stops, "WALK");

  if (result.error) {
    console.log("[computeRoutes] Error:", result.error);
    return {
      callBudget: {
        ...callBudget,
        routes: (callBudget.routes ?? 0) + 1,
      },
    };
  }

  if (!result.route) {
    console.log("[computeRoutes] No route returned");
    return {
      callBudget: {
        ...callBudget,
        routes: (callBudget.routes ?? 0) + 1,
      },
    };
  }

  // Build travel times map (placeId1->placeId2: minutes)
  const travelTimes: Record<string, number> = {};
  for (let i = 0; i < sortedVenues.length - 1; i++) {
    const from = sortedVenues[i];
    const to = sortedVenues[i + 1];
    const leg = result.route.legs[i];

    if (from && to && leg) {
      const key = `${from.placeId}->${to.placeId}`;
      travelTimes[key] = leg.durationMinutes;

      if (!isTravelTimeAcceptable(leg.durationMinutes)) {
        console.log(
          `[computeRoutes] Warning: ${from.name} -> ${to.name} takes ${leg.durationMinutes} min (exceeds 20 min threshold)`,
        );
      }
    }
  }

  console.log("[computeRoutes] Travel times:", travelTimes);
  console.log(
    `[computeRoutes] Total route: ${result.route.totalDurationMinutes} min, ${Math.round((result.route.totalDistanceMeters / 1000) * 10) / 10} km`,
  );

  return {
    travelTimes,
    callBudget: {
      ...callBudget,
      routes: (callBudget.routes ?? 0) + 1,
    },
  };
}

async function adjustTimeline(
  state: GraphStateType,
): Promise<Partial<GraphStateType>> {
  // TODO: Adjust timeline based on travel times
  console.log("[adjustTimeline] Adjusting timeline");
  return {};
}

// Helper to add minutes to time string
function addMinutes(time: string, mins: number): string {
  const [h, m] = time.split(":").map(Number);
  const totalMins = (h ?? 0) * 60 + (m ?? 0) + mins;
  const newH = Math.floor(totalMins / 60) % 24;
  const newM = totalMins % 60;
  return `${newH.toString().padStart(2, "0")}:${newM.toString().padStart(2, "0")}`;
}

// Helper to convert Venue to Backup format
function venueToBackup(venue: Venue): Plan["backups"][0] {
  const label =
    venue.category === "dinner" ? "Dinner backup" : "Activity backup";
  return {
    label,
    name: venue.name,
    mapsUrl: venue.mapsUrl,
    whyBackup: `Alternative ${venue.category} with ${venue.rating ?? "good"} rating`,
  };
}

// Helper to build a plan from selected venues
// Each venue gets a unique label based on order, not category
function buildPlanFromVenues(
  id: "A" | "B" | "C",
  title: string,
  venues: Venue[],
  backupVenues: Venue[],
  startTime: string,
  travelTimes: Record<string, number>,
  mode: Mode,
  familyFriendly: boolean = false,
  budget: number = 100,
  partySize: number = 2,
): Plan {
  // Deduplicate venues by placeId
  const seen = new Set<string>();
  const uniqueVenues = venues.filter((v) => {
    if (seen.has(v.placeId)) return false;
    seen.add(v.placeId);
    return true;
  });

  // Sort by category preference but don't rely on exact category names
  const categoryOrder = familyFriendly
    ? ["activity", "dinner", "dessert", "scenic", "finish", "drinks"]
    : ["drinks", "activity", "dinner", "dessert", "finish", "scenic"];

  const sortedVenues = [...uniqueVenues].sort((a, b) => {
    const aIndex = categoryOrder.indexOf(a.category);
    const bIndex = categoryOrder.indexOf(b.category);
    return (aIndex === -1 ? 999 : aIndex) - (bIndex === -1 ? 999 : bIndex);
  });

  // Calculate budget allocation per category (per person)
  const numStops = sortedVenues.length || 3;
  const perPersonBudget = budget / partySize;

  // Budget distribution: dinner gets ~45%, activity ~30%, drinks/dessert ~25%
  const categoryBudgets: Record<string, number> = {
    dinner: perPersonBudget * 0.45,
    activity: perPersonBudget * 0.30,
    drinks: perPersonBudget * 0.15,
    dessert: perPersonBudget * 0.10,
    finish: perPersonBudget * 0.15,
    scenic: perPersonBudget * 0.05,
  };

  const stops: Plan["stops"] = [];
  let currentTime = startTime;
  let prevVenueId: string | undefined;

  // Track labels used to avoid duplicates like "Dinner", "Dinner"
  const labelCounts: Record<string, number> = {};

  for (const venue of sortedVenues) {
    // Get travel time from previous venue
    let travelFromPrev = 0;
    if (prevVenueId) {
      const key = `${prevVenueId}->${venue.placeId}`;
      travelFromPrev = travelTimes[key] ?? 10;
    }

    if (prevVenueId) {
      currentTime = addMinutes(currentTime, travelFromPrev);
    }

    // Estimate cost based on budget allocation and price level
    const categoryBudget = categoryBudgets[venue.category] ?? (perPersonBudget / numStops);
    const priceLevel = venue.priceLevel ?? 2;

    // Adjust based on price level: 0=cheap, 2=moderate, 4=expensive
    const priceMultiplier = [0.5, 0.75, 1.0, 1.3, 1.6][priceLevel] ?? 1.0;
    const baseCost = categoryBudget * priceMultiplier;

    const estimatedCostRange: [number, number] = [
      Math.round(baseCost * 0.8),
      Math.round(baseCost * 1.2),
    ];

    // Create unique label - if we've used this category before, add number
    const baseLabel =
      venue.category.charAt(0).toUpperCase() + venue.category.slice(1);
    labelCounts[baseLabel] = (labelCounts[baseLabel] ?? 0) + 1;
    const label =
      labelCounts[baseLabel] > 1
        ? `${baseLabel} ${labelCounts[baseLabel]}`
        : baseLabel;

    stops.push({
      time: currentTime,
      label,
      venue,
      estimatedCostRange,
      whyItFits: `Great option with ${venue.rating ?? "good"} rating`,
      travelFromPrevMins: travelFromPrev,
      openCheck:
        mode === "verified"
          ? "Verified: Check hours in Maps"
          : "Standard (confirm hours in Maps)",
    });

    // Add duration at venue
    const durations: Record<string, number> = {
      drinks: 45,
      activity: 90,
      dinner: 90,
      dessert: 30,
      finish: 60,
      scenic: 30,
    };
    currentTime = addMinutes(currentTime, durations[venue.category] ?? 60);
    prevVenueId = venue.placeId;
  }

  // Convert venue backups to Backup format
  const backups = backupVenues.map(venueToBackup);

  return { id, title, stops, backups };
}

async function generateVariants(
  state: GraphStateType,
): Promise<Partial<GraphStateType>> {
  console.log("[generateVariants] Generating Plan A, B, and C variants");

  const pools = state.candidatePools ?? DEFAULT_CANDIDATE_POOLS;
  const city = state.city ?? "Barcelona";
  const travelTimes = state.travelTimes ?? {};
  const mode = state.mode ?? "standard";
  const preferences = state.preferences ?? DEFAULT_PREFERENCES;
  const selectedVenues = Object.values(state.selectedVenues ?? {});
  const isFamily = preferences.familyFriendly === true;
  const budget = state.budget?.amount ?? 100;
  const partySize = state.partySize ?? 2;

  console.log("[generateVariants] Family friendly:", isFamily);
  console.log("[generateVariants] City:", city);
  console.log("[generateVariants] Budget:", budget, "Party size:", partySize);

  if (selectedVenues.length === 0) {
    console.log("[generateVariants] No selected venues");
    return { error: "No venues selected for plans" };
  }

  // Parse time window and calculate duration
  let startTime = isFamily ? "11:00" : "18:00";
  let endTime = isFamily ? "18:00" : "23:30";
  if (state.timeWindow) {
    const parts = state.timeWindow.split("-");
    if (parts[0]) startTime = parts[0];
    if (parts[1]) endTime = parts[1];
  }

  // Calculate available hours
  const [startH, startM] = startTime.split(":").map(Number);
  const [endH, endM] = endTime.split(":").map(Number);
  const availableMinutes = ((endH ?? 18) * 60 + (endM ?? 0)) - ((startH ?? 11) * 60 + (startM ?? 0));
  const availableHours = availableMinutes / 60;

  console.log("[generateVariants] Available hours:", availableHours);

  // Determine number of activities based on time (more time = more stops)
  // ~1.5 hours per stop average (including travel)
  const numActivities = Math.max(1, Math.min(3, Math.floor(availableHours / 2)));
  console.log("[generateVariants] Target activities:", numActivities);

  // Build extended venue list with multiple activities if time allows
  const extendedVenues: Venue[] = [...selectedVenues];
  const extendedIds = new Set(selectedVenues.map(v => v.placeId));

  // Add more activities if we have time
  if (numActivities > 1 && pools.activity.length > 1) {
    for (let i = 0; i < numActivities - 1 && i < pools.activity.length; i++) {
      const extra = pools.activity.find(v => !extendedIds.has(v.placeId));
      if (extra) {
        extendedVenues.push(extra);
        extendedIds.add(extra.placeId);
      }
    }
  }

  // Get IDs of venues used in Plan A
  const planAIds = new Set(extendedVenues.map((v) => v.placeId));

  // --- Plan A: Best overall fit (uses selected venues + extras) ---
  const planABackups = [
    ...pools.dinner.filter((v) => !planAIds.has(v.placeId)).slice(0, 2),
    ...pools.activity.filter((v) => !planAIds.has(v.placeId)).slice(0, 1),
  ];

  // Different title for family vs date
  const planATitle = isFamily
    ? "Family Day in " + city
    : "Romantic Evening in " + city;

  const planA = buildPlanFromVenues(
    "A",
    planATitle,
    extendedVenues,
    planABackups,
    startTime,
    travelTimes,
    mode,
    isFamily,
    budget,
    partySize,
  );

  // --- Plan B: "Playful & Memorable" - pick alternative venues emphasizing fun ---
  // Use 2nd-ranked venues from each pool (or 3rd if 2nd is used in Plan A)
  const planBVenues: Venue[] = [];
  const planBIds = new Set<string>();

  for (const category of ["activity", "dinner", "finish"] as const) {
    const pool = pools[category];
    // Find first venue not in Plan A
    const alt = pool.find((v) => !planAIds.has(v.placeId));
    if (alt) {
      planBVenues.push(alt);
      planBIds.add(alt.placeId);
    } else if (pool[0]) {
      // Fallback to first if all are used
      planBVenues.push(pool[0]);
      planBIds.add(pool[0].placeId);
    }
  }

  const planBBackups = [
    ...pools.dinner
      .filter((v) => !planAIds.has(v.placeId) && !planBIds.has(v.placeId))
      .slice(0, 2),
    ...pools.activity
      .filter((v) => !planAIds.has(v.placeId) && !planBIds.has(v.placeId))
      .slice(0, 1),
  ];

  const planBTitle = isFamily ? "Fun for Everyone" : "Playful & Memorable";
  const planB = buildPlanFromVenues(
    "B",
    planBTitle,
    planBVenues,
    planBBackups,
    startTime,
    travelTimes,
    mode,
    isFamily,
    budget,
    partySize,
  );

  // --- Plan C: "Budget-Friendly Adventure" - pick lower price level venues ---
  const planCVenues: Venue[] = [];
  const usedIds = new Set([...planAIds, ...planBIds]);

  for (const category of ["activity", "dinner", "finish"] as const) {
    const pool = pools[category];
    // Sort by price level (ascending) and pick cheapest unused
    const sortedByPrice = [...pool].sort(
      (a, b) => (a.priceLevel ?? 2) - (b.priceLevel ?? 2),
    );
    const cheap = sortedByPrice.find((v) => !usedIds.has(v.placeId));
    if (cheap) {
      planCVenues.push(cheap);
      usedIds.add(cheap.placeId);
    } else if (sortedByPrice[0]) {
      planCVenues.push(sortedByPrice[0]);
    }
  }

  const planCBackups = pools.dinner
    .filter((v) => !usedIds.has(v.placeId))
    .slice(0, 2);

  const planCTitle = isFamily
    ? "Budget Family Fun"
    : "Budget-Friendly Adventure";
  const planC = buildPlanFromVenues(
    "C",
    planCTitle,
    planCVenues,
    planCBackups,
    startTime,
    travelTimes,
    mode,
    isFamily,
    budget * 0.7, // Budget-friendly plan uses 70% of budget
    partySize,
  );

  console.log(`[generateVariants] Plan A: ${planA.stops.length} stops`);
  console.log(`[generateVariants] Plan B: ${planB.stops.length} stops`);
  console.log(`[generateVariants] Plan C: ${planC.stops.length} stops`);

  return {
    plans: [planA, planB, planC],
  };
}

async function buildSwapMenu(
  state: GraphStateType,
): Promise<Partial<GraphStateType>> {
  console.log("[buildSwapMenu] Building swap menu");

  const pools = state.candidatePools;
  const swapMenu: SwapMenuItem[] = [];

  // --- Rain Mode: Suggest indoor alternatives ---
  const indoorActivities = pools.activity.filter(
    (v) =>
      v.name.toLowerCase().includes("museum") ||
      v.name.toLowerCase().includes("gallery") ||
      v.name.toLowerCase().includes("cinema") ||
      v.name.toLowerCase().includes("theater") ||
      v.name.toLowerCase().includes("escape") ||
      v.name.toLowerCase().includes("bowling") ||
      v.name.toLowerCase().includes("spa"),
  );

  const indoorFinish = pools.finish.filter(
    (v) =>
      v.name.toLowerCase().includes("bar") ||
      v.name.toLowerCase().includes("lounge") ||
      v.name.toLowerCase().includes("club") ||
      v.name.toLowerCase().includes("jazz") ||
      v.name.toLowerCase().includes("cocktail"),
  );

  let rainInstruction = "If weather turns bad: ";
  if (indoorActivities.length > 0) {
    rainInstruction += `swap activity to ${indoorActivities[0]?.name}`;
    if (indoorActivities[0]?.mapsUrl) {
      rainInstruction += ` (${indoorActivities[0].mapsUrl})`;
    }
  } else {
    rainInstruction += "move directly to dinner (skip outdoor activity)";
  }
  if (indoorFinish.length > 0) {
    rainInstruction += `. For drinks, try ${indoorFinish[0]?.name}`;
  }
  rainInstruction += ". All restaurants in the plan are indoors.";

  swapMenu.push({
    swap: "rain_mode",
    instruction: rainInstruction,
  });

  // --- Budget Lower: Find cheaper alternatives ---
  const cheaperDinner = [...pools.dinner]
    .sort((a, b) => (a.priceLevel ?? 2) - (b.priceLevel ?? 2))
    .find((v) => (v.priceLevel ?? 2) <= 1);

  const cheaperActivity = [...pools.activity]
    .sort((a, b) => (a.priceLevel ?? 2) - (b.priceLevel ?? 2))
    .find((v) => (v.priceLevel ?? 2) <= 1);

  let budgetInstruction = "To reduce spend: ";
  const budgetTips: string[] = [];

  if (cheaperDinner) {
    budgetTips.push(`swap dinner to ${cheaperDinner.name} (€€ or less)`);
  } else {
    budgetTips.push("share dishes at dinner");
  }

  if (cheaperActivity) {
    budgetTips.push(`try ${cheaperActivity.name} for activity`);
  } else {
    budgetTips.push("opt for a free walking activity like a scenic stroll");
  }

  budgetTips.push("skip dessert/after-dinner drinks");
  budgetInstruction += budgetTips.join("; ") + ".";

  swapMenu.push({
    swap: "budget_lower",
    instruction: budgetInstruction,
  });

  // --- No Alcohol: Suggest alcohol-free venues ---
  const nonBarFinish = pools.finish.filter(
    (v) =>
      v.name.toLowerCase().includes("cafe") ||
      v.name.toLowerCase().includes("coffee") ||
      v.name.toLowerCase().includes("tea") ||
      v.name.toLowerCase().includes("dessert") ||
      v.name.toLowerCase().includes("ice cream") ||
      v.name.toLowerCase().includes("gelato") ||
      v.name.toLowerCase().includes("bakery"),
  );

  let noAlcoholInstruction = "For an alcohol-free evening: ";
  if (nonBarFinish.length > 0) {
    noAlcoholInstruction += `replace bar stops with ${nonBarFinish[0]?.name}`;
    if (nonBarFinish.length > 1) {
      noAlcoholInstruction += ` or ${nonBarFinish[1]?.name}`;
    }
  } else {
    noAlcoholInstruction +=
      "ask for mocktails at bar venues, or swap to a dessert cafe";
  }
  noAlcoholInstruction +=
    ". Most restaurants offer non-alcoholic pairings on request.";

  swapMenu.push({
    swap: "no_alcohol",
    instruction: noAlcoholInstruction,
  });

  // --- More Walkable: Reduce walking distance ---
  // Find venues that are closer together (use travel times if available)
  const planA = state.plans?.[0];
  const avgTravelTime =
    planA?.stops?.reduce((sum, s) => sum + s.travelFromPrevMins, 0) ?? 0;
  const stopCount = planA?.stops?.length ?? 1;
  const avgPerLeg = Math.round(avgTravelTime / Math.max(stopCount - 1, 1));

  let walkableInstruction = "To reduce walking: ";
  if (avgPerLeg > 15) {
    walkableInstruction +=
      "consider using transit between stops (check Google Maps for metro/bus). ";
  }
  walkableInstruction += "Keep all venues in the same neighborhood. ";
  walkableInstruction +=
    "Ask restaurant for nearby bar recommendations to minimize final walk.";

  swapMenu.push({
    swap: "more_walkable",
    instruction: walkableInstruction,
  });

  console.log(`[buildSwapMenu] Created ${swapMenu.length} swap options`);

  return {
    swapMenu,
  };
}

async function formatOutput(
  state: GraphStateType,
): Promise<Partial<GraphStateType>> {
  console.log("[formatOutput] Validating output");

  // Plans should already be created by generateVariants
  if (!state.plans || state.plans.length === 0) {
    console.log("[formatOutput] No plans generated");
    return {
      error: "No plans were generated",
    };
  }

  console.log(
    `[formatOutput] Output validated: ${state.plans.length} plans ready`,
  );
  for (const plan of state.plans) {
    console.log(
      `  - Plan ${plan.id}: "${plan.title}" with ${plan.stops.length} stops, ${plan.backups.length} backups`,
    );
  }

  return {};
}

async function policyGate(
  state: GraphStateType,
): Promise<Partial<GraphStateType>> {
  console.log("[policyGate] Building final output message");

  // Build the final output structure
  const city = state.city ?? "Barcelona";
  const budget = state.budget ?? { amount: 100, currency: "EUR" };
  const plans = state.plans ?? [];

  // Check for errors - return nothing so Warden App triggers refund
  if (state.error) {
    console.log(
      "[policyGate] ERROR - No response will be sent (triggers refund)",
    );
    console.log("[policyGate] Error details:", state.error);
    return {}; // Empty response = refund
  }

  // Check if we have plans - return nothing so Warden App triggers refund
  if (plans.length === 0) {
    console.log("[policyGate] ERROR - No plans generated (triggers refund)");
    console.log("[policyGate] City:", city);
    return {}; // Empty response = refund
  }

  // Helper to generate short description based on category
  const getDescription = (category: string, name: string): string => {
    const nameLower = name.toLowerCase();

    if (category === "dinner" || nameLower.includes("restaurant")) {
      if (nameLower.includes("italian") || nameLower.includes("pizza") || nameLower.includes("pasta")) return "Italian cuisine with authentic flavors";
      if (nameLower.includes("asian") || nameLower.includes("sushi") || nameLower.includes("japanese")) return "Fresh Asian cuisine and flavors";
      if (nameLower.includes("tapas") || nameLower.includes("spanish")) return "Traditional Spanish tapas and dishes";
      if (nameLower.includes("french") || nameLower.includes("bistro")) return "Classic French dining experience";
      return "Local dining spot with great reviews";
    }
    if (category === "activity") {
      if (nameLower.includes("museum")) return "Explore fascinating exhibits and collections";
      if (nameLower.includes("park") || nameLower.includes("garden")) return "Beautiful outdoor space to enjoy";
      if (nameLower.includes("tour")) return "Guided experience of local highlights";
      if (nameLower.includes("zoo") || nameLower.includes("aquarium")) return "Fun for the whole family";
      return "Popular local attraction";
    }
    if (category === "drinks" || nameLower.includes("bar") || nameLower.includes("cocktail")) {
      return "Great spot for drinks and atmosphere";
    }
    if (category === "dessert" || nameLower.includes("cafe") || nameLower.includes("coffee")) {
      return "Perfect for a sweet treat or coffee";
    }
    return "Highly rated local spot";
  };

  // Build markdown response for Warden App
  const planText = plans
    .map((plan) => {
      // Build Google Maps route URL for this plan
      const routeStops = plan.stops
        ?.map((stop) => {
          const loc = stop.venue?.location;
          return loc ? `${loc.lat},${loc.lng}` : "";
        })
        .filter(Boolean)
        .join("/");
      const routeUrl = `https://www.google.com/maps/dir/${routeStops}`;

      const stopsText = plan.stops
        ?.map((stop, i) => {
          const rating = stop.venue?.rating ? `⭐ ${stop.venue.rating}` : "";
          const cost = stop.estimatedCostRange
            ? `€${stop.estimatedCostRange[0]}-${stop.estimatedCostRange[1]}/person`
            : "";
          const walk =
            i > 0 && stop.travelFromPrevMins > 0
              ? `🚶 ${stop.travelFromPrevMins} min`
              : "";

          const description = getDescription(stop.venue?.category ?? "", stop.venue?.name ?? "");

          // Markdown block for each stop
          return `### ${stop.time} ${stop.label}

**${stop.venue?.name}**

_${description}_

${stop.venue?.address}

${[rating, cost, walk].filter(Boolean).join(" · ")}

[Open in Maps](${stop.venue?.mapsUrl})`;
        })
        .join("\n\n");

      const backups = plan.backups?.length
        ? `\n\n**Alternatives:** ${plan.backups.map((b) => b.name).join(", ")}`
        : "";

      return `## ${plan.title}

${stopsText}${backups}

🗺️ [View Full Route in Google Maps](${routeUrl})`;
    })
    .join("\n\n---\n\n");

  // Calculate totals (per-person costs * party size = total)
  const partySize = state.partySize ?? 2;
  const perPersonTotal = plans[0]?.stops?.reduce<[number, number]>(
    (acc, stop) => [
      acc[0] + (stop.estimatedCostRange?.[0] ?? 0),
      acc[1] + (stop.estimatedCostRange?.[1] ?? 0),
    ],
    [0, 0],
  ) ?? [0, 0];

  // Total for the whole party
  const estimatedTotal: [number, number] = [
    perPersonTotal[0] * partySize,
    perPersonTotal[1] * partySize,
  ];

  // Build the full markdown response
  const outputContent = `# 📍 Your Plan for ${city}

**Date:** ${state.dateResolved ?? "TBD"}

**Time:** ${state.timeWindow ?? "Evening"}

**Budget:** €${budget.amount} · **Estimated Total:** €${estimatedTotal[0]}-${estimatedTotal[1]} (${partySize} people)

${planText}`;

  console.log(`[policyGate] Output: ${plans.length} plans`);
  console.log("[policyGate] Content:\n", outputContent);

  return { messages: [new AIMessage({ content: outputContent })] };
}

// Conditional edge functions
function shouldValidateHours(
  state: GraphStateType,
): "validate_hours" | "compute_routes" {
  return state.mode === "verified" ? "validate_hours" : "compute_routes";
}

// Check if we should continue or handle error
function checkError(nextNode: string) {
  return (state: GraphStateType): string => {
    if (state.error) {
      console.log(
        `[checkError] Error detected, routing to policy_gate: ${state.error}`,
      );
      return "policy_gate";
    }
    return nextNode;
  };
}

// Build the graph
export function createGraph() {
  const workflow = new StateGraph(GraphState)
    // Add all nodes
    .addNode("initialize", initializeState)
    .addNode("intake_parse", intakeParse)
    .addNode("build_skeleton", buildSkeletonNode)
    .addNode("search_activity", searchActivity)
    .addNode("search_dinner", searchDinner)
    .addNode("search_finish", searchFinish)
    .addNode("rank_cluster", rankCluster)
    .addNode("select_finalists", selectFinalists)
    .addNode("get_details", getDetails)
    .addNode("validate_hours", validateHours)
    .addNode("compute_routes", computeRoutes)
    .addNode("adjust_timeline", adjustTimeline)
    .addNode("generate_variants", generateVariants)
    .addNode("build_swap_menu", buildSwapMenu)
    .addNode("format_output", formatOutput)
    .addNode("policy_gate", policyGate)

    // Add edges - check for error after searchActivity (city validation)
    .addEdge(START, "initialize")
    .addEdge("initialize", "intake_parse")
    .addEdge("intake_parse", "build_skeleton")
    .addEdge("build_skeleton", "search_activity")
    .addConditionalEdges("search_activity", checkError("search_dinner"), {
      search_dinner: "search_dinner",
      policy_gate: "policy_gate",
    })
    .addEdge("search_dinner", "search_finish")
    .addEdge("search_finish", "rank_cluster")
    .addEdge("rank_cluster", "select_finalists")
    .addEdge("select_finalists", "get_details")
    .addConditionalEdges(
      "get_details",
      (state) => {
        return state.mode === "verified" ? "validate_hours" : "compute_routes";
      },
      {
        validate_hours: "validate_hours",
        compute_routes: "compute_routes",
      },
    )
    .addEdge("validate_hours", "compute_routes")
    .addEdge("compute_routes", "adjust_timeline")
    .addEdge("adjust_timeline", "generate_variants")
    .addEdge("generate_variants", "build_swap_menu")
    .addEdge("build_swap_menu", "format_output")
    .addEdge("format_output", "policy_gate")
    .addEdge("policy_gate", END);

  return workflow.compile();
}

// Export compiled graph
export const graph = createGraph();
