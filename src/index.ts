import { graph, type GraphStateType } from "./agent/index.js";
import { createInitialState, AgentInputSchema } from "./types/index.js";

async function main() {
  // Example input matching PRD spec
  const rawInput = {
    query: "Plan a date next Saturday in Barcelona, budget 200 euros",
    city: "Barcelona",
    dateContext: "next Saturday evening",
    budget: {
      amount: 200,
      currency: "EUR",
    },
    partySize: 2,
    preferences: {
      vibe: ["romantic", "cozy"],
      dietary: [],
      alcoholOk: true,
      walking: "medium" as const,
      indoorsPreferred: false,
      likes: ["good food", "nice views"],
    },
    mode: "standard" as const,
    timezone: "Europe/Madrid",
    paid: true,
  };

  // Validate input
  const validatedInput = AgentInputSchema.parse(rawInput);
  console.log("Validated input:", JSON.stringify(validatedInput, null, 2));

  // Create initial state
  const initialState = createInitialState(validatedInput);
  console.log("\nInitial state created");

  // Run the graph
  console.log("\n--- Running graph ---\n");
  const result = await graph.invoke(initialState as GraphStateType);

  console.log("\n--- Graph completed ---\n");

  // Handle errors
  if (result.error) {
    console.error("Error:", result.error);
    return;
  }


  // Build the user-facing output (matching PRD API contract)
  const output = {
    summary: {
      city: result.city,
      date: result.dateResolved,
      time_window: result.timeWindow,
      budget_target: result.budget,
      estimated_total_range: result.plans?.[0]?.stops?.reduce<[number, number]>(
        (acc, stop) => [
          acc[0] + (stop.estimatedCostRange?.[0] ?? 0),
          acc[1] + (stop.estimatedCostRange?.[1] ?? 0),
        ],
        [0, 0]
      ),
    },
    plans: result.plans?.map((plan) => ({
      id: plan.id,
      title: plan.title,
      stops: plan.stops?.map((stop) => ({
        time: stop.time,
        label: stop.label,
        name: stop.venue?.name,
        type: stop.venue?.category,
        maps_url: stop.venue?.mapsUrl,
        estimated_cost_range: stop.estimatedCostRange,
        why_it_fits: stop.whyItFits,
        travel_from_prev_mins: stop.travelFromPrevMins,
        rating: stop.venue?.rating,
        review_count: stop.venue?.reviewCount,
        open_check: stop.openCheck,
      })),
      backups: plan.backups?.map((b) => ({
        label: b.label,
        name: b.name,
        maps_url: b.mapsUrl,
        why_backup: b.whyBackup,
      })),
    })),
    swap_menu: result.swapMenu,
    call_budget_used: result.callBudget,
  };

  console.log("=".repeat(60));
  console.log("USER OUTPUT (what the Warden App would display)");
  console.log("=".repeat(60));
  console.log(JSON.stringify(output, null, 2));

  // Calculate and display API costs
  const COSTS = {
    placesSearch: 0.032,    // $0.032 per Text Search call
    placeDetails: 0.025,    // $0.025 per Place Details call (with hours)
    routes: 0.01,           // $0.01 per Routes call
  };

  const callCounts = result.callBudget ?? { placesSearch: 0, placeDetails: 0, routes: 0 };
  const costs = {
    placesSearch: (callCounts.placesSearch ?? 0) * COSTS.placesSearch,
    placeDetails: (callCounts.placeDetails ?? 0) * COSTS.placeDetails,
    routes: (callCounts.routes ?? 0) * COSTS.routes,
  };
  const totalCost = costs.placesSearch + costs.placeDetails + costs.routes;

  console.log("\n" + "=".repeat(60));
  console.log("API COST BREAKDOWN");
  console.log("=".repeat(60));
  console.log(`Places Search:  ${callCounts.placesSearch ?? 0} calls × $0.032 = $${costs.placesSearch.toFixed(3)}`);
  console.log(`Place Details:  ${callCounts.placeDetails ?? 0} calls × $0.025 = $${costs.placeDetails.toFixed(3)}`);
  console.log(`Routes:         ${callCounts.routes ?? 0} calls × $0.010 = $${costs.routes.toFixed(3)}`);
  console.log("-".repeat(40));
  console.log(`TOTAL GOOGLE API COST: $${totalCost.toFixed(3)} (€${(totalCost * 0.92).toFixed(3)})`);
  console.log(`Target per PRD: < €0.20`);
  console.log(totalCost * 0.92 < 0.20 ? "✓ Within budget" : "⚠ Over budget!");
}

main().catch(console.error);
