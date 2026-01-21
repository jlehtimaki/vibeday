import { z } from "zod";

// Environment variable for API key
const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;

// Google Places API (New) Place Details endpoint
const PLACE_DETAILS_URL = "https://places.googleapis.com/v1/places";

// Field masks for different detail levels
// Basic: ~$0.017 per call
const BASIC_FIELDS = [
  "id",
  "displayName",
  "formattedAddress",
  "location",
  "rating",
  "userRatingCount",
  "priceLevel",
  "types",
  "websiteUri",
];

// With hours: ~$0.025 per call (adds contact/atmosphere fields)
const HOURS_FIELDS = [
  ...BASIC_FIELDS,
  "currentOpeningHours",
  "regularOpeningHours",
];

// Input schema
export const PlaceDetailsInputSchema = z.object({
  placeId: z.string().min(1).describe("Google Place ID"),
  includeHours: z.boolean().optional().describe("Include opening hours (costs more)"),
});

export type PlaceDetailsInput = z.infer<typeof PlaceDetailsInputSchema>;

// Opening hours period
interface OpeningHoursPeriod {
  open: {
    day: number; // 0-6 (Sunday-Saturday)
    hour: number;
    minute: number;
  };
  close?: {
    day: number;
    hour: number;
    minute: number;
  };
}

// Google Place Details response
interface GooglePlaceDetailsResponse {
  id: string;
  displayName?: {
    text: string;
    languageCode: string;
  };
  formattedAddress?: string;
  location?: {
    latitude: number;
    longitude: number;
  };
  rating?: number;
  userRatingCount?: number;
  priceLevel?: string;
  types?: string[];
  websiteUri?: string;
  currentOpeningHours?: {
    openNow?: boolean;
    periods?: OpeningHoursPeriod[];
    weekdayDescriptions?: string[];
  };
  regularOpeningHours?: {
    openNow?: boolean;
    periods?: OpeningHoursPeriod[];
    weekdayDescriptions?: string[];
  };
}

// Our enriched venue details
export interface PlaceDetails {
  placeId: string;
  name: string;
  address: string;
  location: {
    lat: number;
    lng: number;
  };
  rating?: number;
  reviewCount?: number;
  priceLevel?: number;
  website?: string;
  openNow?: boolean;
  openingHours?: {
    periods: Array<{
      openDay: number;
      openTime: string; // HH:MM
      closeDay?: number;
      closeTime?: string;
    }>;
    weekdayDescriptions: string[];
  };
}

export interface PlaceDetailsResult {
  details?: PlaceDetails;
  error?: string;
}

// Convert price level string to number
function priceLevelToNumber(priceLevel?: string): number | undefined {
  if (!priceLevel) return undefined;
  const mapping: Record<string, number> = {
    PRICE_LEVEL_FREE: 0,
    PRICE_LEVEL_INEXPENSIVE: 1,
    PRICE_LEVEL_MODERATE: 2,
    PRICE_LEVEL_EXPENSIVE: 3,
    PRICE_LEVEL_VERY_EXPENSIVE: 4,
  };
  return mapping[priceLevel];
}

// Format time from hour/minute to HH:MM
function formatTime(hour: number, minute: number): string {
  return `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
}

// Transform Google response to our schema
function transformDetails(response: GooglePlaceDetailsResponse): PlaceDetails {
  const hours = response.currentOpeningHours ?? response.regularOpeningHours;

  // Build the details object, only including optional fields when they have values
  const details: PlaceDetails = {
    placeId: response.id,
    name: response.displayName?.text ?? "Unknown",
    address: response.formattedAddress ?? "",
    location: {
      lat: response.location?.latitude ?? 0,
      lng: response.location?.longitude ?? 0,
    },
  };

  // Add optional fields only when they have values (for exactOptionalPropertyTypes)
  if (response.rating !== undefined) {
    details.rating = response.rating;
  }
  if (response.userRatingCount !== undefined) {
    details.reviewCount = response.userRatingCount;
  }
  const priceLevel = priceLevelToNumber(response.priceLevel);
  if (priceLevel !== undefined) {
    details.priceLevel = priceLevel;
  }
  if (response.websiteUri !== undefined) {
    details.website = response.websiteUri;
  }
  if (hours?.openNow !== undefined) {
    details.openNow = hours.openNow;
  }

  if (hours?.periods || hours?.weekdayDescriptions) {
    const periods = hours.periods?.map((p) => {
      const period: {
        openDay: number;
        openTime: string;
        closeDay?: number;
        closeTime?: string;
      } = {
        openDay: p.open.day,
        openTime: formatTime(p.open.hour, p.open.minute),
      };
      if (p.close?.day !== undefined) {
        period.closeDay = p.close.day;
      }
      if (p.close) {
        period.closeTime = formatTime(p.close.hour, p.close.minute);
      }
      return period;
    }) ?? [];

    details.openingHours = {
      periods,
      weekdayDescriptions: hours.weekdayDescriptions ?? [],
    };
  }

  return details;
}

/**
 * Get detailed information about a specific place
 *
 * Cost: ~$0.017 per call (basic) to ~$0.025 (with hours)
 * Budget: Max 6 calls per request (enforced by call budget)
 */
export async function googlePlaceDetails(
  input: PlaceDetailsInput
): Promise<PlaceDetailsResult> {
  // Validate API key
  if (!GOOGLE_PLACES_API_KEY) {
    return {
      error: "GOOGLE_PLACES_API_KEY environment variable not set",
    };
  }

  // Validate input
  const parsed = PlaceDetailsInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      error: `Invalid input: ${parsed.error.message}`,
    };
  }

  const { placeId, includeHours } = parsed.data;

  // Select field mask based on whether hours are needed
  const fields = includeHours ? HOURS_FIELDS : BASIC_FIELDS;
  const fieldMask = fields.join(",");

  try {
    const url = `${PLACE_DETAILS_URL}/${placeId}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "X-Goog-Api-Key": GOOGLE_PLACES_API_KEY,
        "X-Goog-FieldMask": fieldMask,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        error: `Google Places API error (${response.status}): ${errorText}`,
      };
    }

    const data = (await response.json()) as GooglePlaceDetailsResponse;
    return {
      details: transformDetails(data),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return {
      error: `Failed to get place details: ${message}`,
    };
  }
}

/**
 * Check if a venue is open at a specific time
 *
 * @param openingHours - The opening hours from PlaceDetails
 * @param dayOfWeek - 0-6 (Sunday-Saturday)
 * @param time - Time in HH:MM format
 * @returns true if open, false if closed, undefined if unknown
 */
export function isOpenAt(
  openingHours: PlaceDetails["openingHours"],
  dayOfWeek: number,
  time: string
): boolean | undefined {
  if (!openingHours?.periods || openingHours.periods.length === 0) {
    return undefined;
  }

  const [hours, minutes] = time.split(":").map(Number);
  if (hours === undefined || minutes === undefined) {
    return undefined;
  }
  const timeMinutes = hours * 60 + minutes;

  // Find periods for this day
  for (const period of openingHours.periods) {
    if (period.openDay === dayOfWeek) {
      const [openH, openM] = period.openTime.split(":").map(Number);
      if (openH === undefined || openM === undefined) continue;
      const openMinutes = openH * 60 + openM;

      // If no close time, assume open 24 hours from open time
      if (!period.closeTime) {
        if (timeMinutes >= openMinutes) {
          return true;
        }
        continue;
      }

      const [closeH, closeM] = period.closeTime.split(":").map(Number);
      if (closeH === undefined || closeM === undefined) continue;
      let closeMinutes = closeH * 60 + closeM;

      // Handle overnight closing (e.g., closes at 2am)
      if (period.closeDay !== undefined && period.closeDay !== dayOfWeek) {
        // Closes the next day, so for today it's open until midnight
        closeMinutes = 24 * 60;
      }

      if (timeMinutes >= openMinutes && timeMinutes < closeMinutes) {
        return true;
      }
    }
  }

  return false;
}
