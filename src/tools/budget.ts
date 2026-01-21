import { CALL_BUDGET_LIMITS, type CallBudget } from "../types/index.js";

export type CallType = "placesSearch" | "placeDetails" | "routes";

export interface BudgetCheckResult {
  allowed: boolean;
  reason?: string;
  currentCount: number;
  limit: number;
}

/**
 * Check if a call type is within budget
 */
export function canMakeCall(
  budget: CallBudget,
  callType: CallType
): BudgetCheckResult {
  const currentCount = budget[callType];
  const limit = CALL_BUDGET_LIMITS[callType];

  if (currentCount >= limit) {
    return {
      allowed: false,
      reason: `${callType} budget exhausted: ${currentCount}/${limit} calls used`,
      currentCount,
      limit,
    };
  }

  return {
    allowed: true,
    currentCount,
    limit,
  };
}

/**
 * Increment call count and return updated budget
 * Throws if budget would be exceeded
 */
export function incrementCallBudget(
  budget: CallBudget,
  callType: CallType
): CallBudget {
  const check = canMakeCall(budget, callType);

  if (!check.allowed) {
    throw new Error(check.reason);
  }

  return {
    ...budget,
    [callType]: budget[callType] + 1,
  };
}

/**
 * Get remaining calls for each type
 */
export function getRemainingBudget(budget: CallBudget): Record<CallType, number> {
  return {
    placesSearch: CALL_BUDGET_LIMITS.placesSearch - budget.placesSearch,
    placeDetails: CALL_BUDGET_LIMITS.placeDetails - budget.placeDetails,
    routes: CALL_BUDGET_LIMITS.routes - budget.routes,
  };
}

/**
 * Check if any budget is exhausted
 */
export function isBudgetExhausted(budget: CallBudget): boolean {
  return (
    budget.placesSearch >= CALL_BUDGET_LIMITS.placesSearch &&
    budget.placeDetails >= CALL_BUDGET_LIMITS.placeDetails &&
    budget.routes >= CALL_BUDGET_LIMITS.routes
  );
}

/**
 * Format budget for logging/output
 */
export function formatBudgetUsage(budget: CallBudget): string {
  return [
    `Places Search: ${budget.placesSearch}/${CALL_BUDGET_LIMITS.placesSearch}`,
    `Place Details: ${budget.placeDetails}/${CALL_BUDGET_LIMITS.placeDetails}`,
    `Routes: ${budget.routes}/${CALL_BUDGET_LIMITS.routes}`,
  ].join(", ");
}
