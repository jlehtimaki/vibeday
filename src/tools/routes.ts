import { z } from "zod";
import type { Location } from "../types/index.js";

// Environment variable for API key
const GOOGLE_ROUTES_API_KEY = process.env.GOOGLE_ROUTES_API_KEY ?? process.env.GOOGLE_PLACES_API_KEY;

// Google Routes API endpoint
const ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";

// Travel modes
export const TravelModeSchema = z.enum(["WALK", "DRIVE", "TRANSIT"]);
export type TravelMode = z.infer<typeof TravelModeSchema>;

// Waypoint schema
const WaypointSchema = z.object({
  lat: z.number(),
  lng: z.number(),
  placeId: z.string().optional(), // Optional place ID for more accurate routing
});

// Input schema
export const RoutesInputSchema = z.object({
  origin: WaypointSchema.describe("Starting point"),
  destination: WaypointSchema.describe("Ending point"),
  waypoints: z.array(WaypointSchema).optional().describe("Intermediate stops"),
  mode: TravelModeSchema.optional().describe("Travel mode (default: WALK)"),
  departureTime: z.string().optional().describe("ISO 8601 departure time for transit"),
});

export type RoutesInput = z.infer<typeof RoutesInputSchema>;

// Google Routes API response types
interface GoogleRouteLeg {
  distanceMeters: number;
  duration: string; // e.g., "300s"
  staticDuration: string;
  polyline?: {
    encodedPolyline: string;
  };
  startLocation?: {
    latLng: {
      latitude: number;
      longitude: number;
    };
  };
  endLocation?: {
    latLng: {
      latitude: number;
      longitude: number;
    };
  };
}

interface GoogleRoute {
  legs: GoogleRouteLeg[];
  distanceMeters: number;
  duration: string;
  staticDuration: string;
  polyline?: {
    encodedPolyline: string;
  };
}

interface GoogleRoutesResponse {
  routes?: GoogleRoute[];
}

// Our route result
export interface RouteLeg {
  distanceMeters: number;
  durationSeconds: number;
  durationMinutes: number;
}

export interface RouteResult {
  totalDistanceMeters: number;
  totalDurationSeconds: number;
  totalDurationMinutes: number;
  legs: RouteLeg[];
  mode: TravelMode;
}

export interface RoutesResult {
  route?: RouteResult;
  error?: string;
}

// Parse duration string (e.g., "300s") to seconds
function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)s$/);
  if (match?.[1]) {
    return parseInt(match[1], 10);
  }
  return 0;
}

// Build waypoint for request
function buildWaypoint(point: z.infer<typeof WaypointSchema>): Record<string, unknown> {
  if (point.placeId) {
    return {
      placeId: point.placeId,
    };
  }
  return {
    location: {
      latLng: {
        latitude: point.lat,
        longitude: point.lng,
      },
    },
  };
}

/**
 * Compute travel time and route between locations
 *
 * Cost: ~$0.005-0.01 per call
 * Budget: Max 2 calls per request (enforced by call budget)
 */
export async function googleRoutesCompute(
  input: RoutesInput
): Promise<RoutesResult> {
  // Validate API key
  if (!GOOGLE_ROUTES_API_KEY) {
    return {
      error: "GOOGLE_ROUTES_API_KEY environment variable not set",
    };
  }

  // Validate input
  const parsed = RoutesInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      error: `Invalid input: ${parsed.error.message}`,
    };
  }

  const { origin, destination, waypoints, departureTime } = parsed.data;
  const mode = parsed.data.mode ?? "WALK";

  // Build request body
  const requestBody: Record<string, unknown> = {
    origin: buildWaypoint(origin),
    destination: buildWaypoint(destination),
    travelMode: mode,
    computeAlternativeRoutes: false,
    languageCode: "en",
    units: "METRIC",
  };

  // Only set routingPreference for DRIVE mode (not allowed for WALK/TRANSIT)
  if (mode === "DRIVE") {
    requestBody.routingPreference = "TRAFFIC_AWARE";
  }

  // Add intermediate waypoints if provided
  if (waypoints && waypoints.length > 0) {
    requestBody.intermediates = waypoints.map((wp) => buildWaypoint(wp));
  }

  // Add departure time for transit
  if (departureTime && mode === "TRANSIT") {
    requestBody.departureTime = departureTime;
  }

  // Field mask for response
  const fieldMask = "routes.legs.distanceMeters,routes.legs.duration,routes.distanceMeters,routes.duration";

  try {
    const response = await fetch(ROUTES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_ROUTES_API_KEY,
        "X-Goog-FieldMask": fieldMask,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        error: `Google Routes API error (${response.status}): ${errorText}`,
      };
    }

    const data = (await response.json()) as GoogleRoutesResponse;

    if (!data.routes || data.routes.length === 0) {
      return {
        error: "No route found between the specified locations",
      };
    }

    const route = data.routes[0];
    if (!route) {
      return {
        error: "No route data returned",
      };
    }

    const totalDurationSeconds = parseDuration(route.duration);

    return {
      route: {
        totalDistanceMeters: route.distanceMeters,
        totalDurationSeconds,
        totalDurationMinutes: Math.ceil(totalDurationSeconds / 60),
        legs: route.legs.map((leg) => {
          const legDurationSeconds = parseDuration(leg.duration);
          return {
            distanceMeters: leg.distanceMeters,
            durationSeconds: legDurationSeconds,
            durationMinutes: Math.ceil(legDurationSeconds / 60),
          };
        }),
        mode,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return {
      error: `Failed to compute route: ${message}`,
    };
  }
}

/**
 * Compute routes for a multi-stop itinerary
 * This is a convenience function that computes a single route through all stops
 *
 * @param stops - Array of locations in order
 * @param mode - Travel mode
 * @returns Route with legs for each segment
 */
export async function computeItineraryRoute(
  stops: Location[],
  mode: TravelMode = "WALK"
): Promise<RoutesResult> {
  if (stops.length < 2) {
    return {
      error: "Need at least 2 stops to compute a route",
    };
  }

  const origin = stops[0];
  const destination = stops[stops.length - 1];
  const waypoints = stops.slice(1, -1);

  if (!origin || !destination) {
    return {
      error: "Invalid stops array",
    };
  }

  return googleRoutesCompute({
    origin,
    destination,
    waypoints: waypoints.length > 0 ? waypoints : undefined,
    mode,
  });
}

/**
 * Suggest travel mode based on distance
 * - Walk for < 1.5km
 * - Transit for >= 1.5km
 */
export function suggestTravelMode(distanceMeters: number): TravelMode {
  if (distanceMeters < 1500) {
    return "WALK";
  }
  return "TRANSIT";
}

/**
 * Check if travel time between stops is acceptable
 * PRD specifies max 20 minutes between stops
 */
export function isTravelTimeAcceptable(
  durationMinutes: number,
  maxMinutes: number = 20
): boolean {
  return durationMinutes <= maxMinutes;
}
