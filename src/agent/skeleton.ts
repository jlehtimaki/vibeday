import type { Skeleton, SkeletonSlot, Budget } from "../types/index.js";

// Default budget allocation percentages from PRD
// drinks → activity → dinner → end
const DEFAULT_TEMPLATE: SkeletonSlot[] = [
  { label: "Arrival drink", type: "drinks", budgetPercent: 15, durationMins: 45 },
  { label: "Main activity", type: "activity", budgetPercent: 25, durationMins: 90 },
  { label: "Dinner", type: "dinner", budgetPercent: 50, durationMins: 90 },
  { label: "Nightcap / Dessert", type: "dessert", budgetPercent: 10, durationMins: 45 },
];

// Late start template (after 20:00) - skip first drink
const LATE_START_TEMPLATE: SkeletonSlot[] = [
  { label: "Dinner", type: "dinner", budgetPercent: 55, durationMins: 100 },
  { label: "Activity / Walk", type: "activity", budgetPercent: 25, durationMins: 60 },
  { label: "Nightcap", type: "drinks", budgetPercent: 20, durationMins: 45 },
];

// Afternoon template (14:00-18:00)
const AFTERNOON_TEMPLATE: SkeletonSlot[] = [
  { label: "Coffee / Light bite", type: "drinks", budgetPercent: 15, durationMins: 30 },
  { label: "Main activity", type: "activity", budgetPercent: 50, durationMins: 120 },
  { label: "Late lunch / Early dinner", type: "dinner", budgetPercent: 35, durationMins: 75 },
];

// Budget-conscious template (< 80 EUR)
const BUDGET_TEMPLATE: SkeletonSlot[] = [
  { label: "Scenic walk / Free activity", type: "scenic", budgetPercent: 5, durationMins: 45 },
  { label: "Main activity", type: "activity", budgetPercent: 30, durationMins: 90 },
  { label: "Dinner", type: "dinner", budgetPercent: 55, durationMins: 75 },
  { label: "Dessert / Walk", type: "dessert", budgetPercent: 10, durationMins: 30 },
];

// Fancy template (> 250 EUR)
const FANCY_TEMPLATE: SkeletonSlot[] = [
  { label: "Champagne / Aperitif", type: "drinks", budgetPercent: 12, durationMins: 45 },
  { label: "Premium activity", type: "activity", budgetPercent: 28, durationMins: 90 },
  { label: "Fine dining", type: "dinner", budgetPercent: 50, durationMins: 120 },
  { label: "Cocktails / Nightcap", type: "drinks", budgetPercent: 10, durationMins: 45 },
];

// Parse time string (HH:MM) to minutes since midnight
function parseTime(time: string): number {
  const parts = time.split(":");
  const hours = parseInt(parts[0] ?? "0", 10);
  const minutes = parseInt(parts[1] ?? "0", 10);
  return hours * 60 + minutes;
}

// Format minutes since midnight to HH:MM
function formatTime(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}

// Select the appropriate template based on context
function selectTemplate(
  budget: Budget,
  startTime: string,
  endTime: string
): SkeletonSlot[] {
  const startMins = parseTime(startTime);
  const endMins = parseTime(endTime);
  const durationMins = endMins > startMins ? endMins - startMins : (24 * 60 - startMins) + endMins;

  // Budget-based selection
  if (budget.amount < 80) {
    return BUDGET_TEMPLATE;
  }
  if (budget.amount > 250) {
    return FANCY_TEMPLATE;
  }

  // Time-based selection
  if (startMins >= 20 * 60) {
    // Late start (after 8pm)
    return LATE_START_TEMPLATE;
  }
  if (startMins >= 14 * 60 && endMins <= 18 * 60) {
    // Afternoon window
    return AFTERNOON_TEMPLATE;
  }

  // Short duration (< 3 hours) - simplified
  if (durationMins < 180) {
    return [
      { label: "Activity", type: "activity", budgetPercent: 40, durationMins: Math.floor(durationMins * 0.4) },
      { label: "Dinner / Drinks", type: "dinner", budgetPercent: 60, durationMins: Math.floor(durationMins * 0.6) },
    ];
  }

  return DEFAULT_TEMPLATE;
}

// Adjust template durations to fit the time window
function adjustDurations(
  slots: SkeletonSlot[],
  startTime: string,
  endTime: string
): SkeletonSlot[] {
  const startMins = parseTime(startTime);
  const endMins = parseTime(endTime);
  const availableMins = endMins > startMins ? endMins - startMins : (24 * 60 - startMins) + endMins;

  // Calculate total template duration
  const totalTemplateMins = slots.reduce((sum, s) => sum + (s.durationMins ?? 0), 0);

  // Scale if needed
  const scale = totalTemplateMins > 0 ? availableMins / totalTemplateMins : 1;

  return slots.map((slot) => ({
    ...slot,
    durationMins: Math.round((slot.durationMins ?? 60) * scale),
  }));
}

// Assign start times to each slot
function assignTimes(
  slots: SkeletonSlot[],
  startTime: string
): SkeletonSlot[] {
  let currentMins = parseTime(startTime);

  return slots.map((slot) => {
    const slotWithTime = {
      ...slot,
      timeStart: formatTime(currentMins),
    };
    currentMins += slot.durationMins ?? 60;
    // Add buffer for travel (10 mins between stops)
    currentMins += 10;
    return slotWithTime;
  });
}

/**
 * Build an itinerary skeleton with budget allocation and time slots
 *
 * @param budget - Total budget
 * @param startTime - Start time (HH:MM)
 * @param endTime - End time (HH:MM)
 * @returns Skeleton with slots, budget allocation, and time window
 */
export function buildSkeleton(
  budget: Budget,
  startTime: string,
  endTime: string
): Skeleton {
  // Select appropriate template
  let slots = selectTemplate(budget, startTime, endTime);

  // Adjust durations to fit time window
  slots = adjustDurations(slots, startTime, endTime);

  // Assign start times
  slots = assignTimes(slots, startTime);

  return {
    slots,
    totalBudget: budget.amount,
    timeWindow: {
      start: startTime,
      end: endTime,
    },
  };
}

/**
 * Get budget allocation for a specific slot type
 */
export function getBudgetForSlot(
  skeleton: Skeleton,
  slotType: string
): number {
  const slot = skeleton.slots.find((s) => s.type === slotType);
  if (!slot) return 0;
  return Math.round((skeleton.totalBudget * slot.budgetPercent) / 100);
}

/**
 * Get all slot types in the skeleton
 */
export function getSlotTypes(skeleton: Skeleton): string[] {
  return skeleton.slots.map((s) => s.type);
}

/**
 * Validate skeleton budget adds up to ~100%
 */
export function validateSkeleton(skeleton: Skeleton): boolean {
  const totalPercent = skeleton.slots.reduce((sum, s) => sum + s.budgetPercent, 0);
  return totalPercent >= 95 && totalPercent <= 105; // Allow 5% tolerance
}
