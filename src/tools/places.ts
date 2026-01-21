import { z } from "zod";
import type { Venue, Location } from "../types/index.js";

// Environment variable for API key
const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;

// Google Places API (New) endpoint
const PLACES_TEXT_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";

// Field mask for cost-efficient search (basic + location + rating)
// This balances cost with getting useful venue data
const SEARCH_FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.location",
  "places.types",
  "places.rating",
  "places.userRatingCount",
  "places.priceLevel",
].join(",");

// Input schema for the search function
export const PlacesSearchInputSchema = z.object({
  query: z.string().min(1).describe("Search query (e.g., 'romantic dinner restaurants')"),
  location: z
    .object({
      lat: z.number(),
      lng: z.number(),
    })
    .describe("Center point for the search"),
  radiusMeters: z.number().min(100).max(50000).optional().describe("Search radius in meters"),
  openNow: z.boolean().optional().describe("Only return places open now"),
  minRating: z.number().min(0).max(5).optional().describe("Minimum rating filter"),
  maxResults: z.number().min(1).max(20).optional().describe("Maximum results to return"),
});

export type PlacesSearchInput = z.infer<typeof PlacesSearchInputSchema>;

// Google Places API response types
interface GooglePlaceResponse {
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
  types?: string[];
  rating?: number;
  userRatingCount?: number;
  priceLevel?:
    | "PRICE_LEVEL_UNSPECIFIED"
    | "PRICE_LEVEL_FREE"
    | "PRICE_LEVEL_INEXPENSIVE"
    | "PRICE_LEVEL_MODERATE"
    | "PRICE_LEVEL_EXPENSIVE"
    | "PRICE_LEVEL_VERY_EXPENSIVE";
}

interface GoogleTextSearchResponse {
  places?: GooglePlaceResponse[];
}

// Convert Google price level to numeric (0-4)
function priceLevelToNumber(
  priceLevel?: string
): number | undefined {
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

// Construct Google Maps URL from place ID or coordinates
function buildMapsUrl(placeId: string, location?: Location): string {
  // Use place_id for more accurate linking
  return `https://www.google.com/maps/place/?q=place_id:${placeId}`;
}

// Infer category from Google place types
function inferCategory(types?: string[]): string {
  if (!types || types.length === 0) return "other";

  const categoryMap: Record<string, string> = {
    restaurant: "dinner",
    food: "dinner",
    bar: "drinks",
    night_club: "drinks",
    cafe: "drinks",
    bakery: "dessert",
    ice_cream_shop: "dessert",
    museum: "activity",
    art_gallery: "activity",
    movie_theater: "activity",
    bowling_alley: "activity",
    amusement_park: "activity",
    park: "scenic",
    viewpoint: "scenic",
    tourist_attraction: "activity",
  };

  for (const type of types) {
    if (categoryMap[type]) {
      return categoryMap[type];
    }
  }

  return "activity"; // Default to activity
}

// Transform Google Place response to our Venue schema
function transformToVenue(place: GooglePlaceResponse): Venue {
  const location: Location = {
    lat: place.location?.latitude ?? 0,
    lng: place.location?.longitude ?? 0,
  };

  return {
    name: place.displayName?.text ?? "Unknown",
    placeId: place.id,
    mapsUrl: buildMapsUrl(place.id, location),
    address: place.formattedAddress ?? "",
    location,
    priceLevel: priceLevelToNumber(place.priceLevel),
    rating: place.rating,
    reviewCount: place.userRatingCount,
    category: inferCategory(place.types),
  };
}

export interface PlacesSearchResult {
  venues: Venue[];
  error?: string;
}

/**
 * Search for places using Google Places API (New) Text Search
 *
 * Cost: ~$0.032 per call (with basic + location + rating fields)
 * Budget: Max 3 calls per request (enforced by call budget)
 */
export async function googlePlacesSearch(
  input: PlacesSearchInput
): Promise<PlacesSearchResult> {
  // Validate API key
  if (!GOOGLE_PLACES_API_KEY) {
    return {
      venues: [],
      error: "GOOGLE_PLACES_API_KEY environment variable not set",
    };
  }

  // Validate input
  const parsed = PlacesSearchInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      venues: [],
      error: `Invalid input: ${parsed.error.message}`,
    };
  }

  const { query, location, minRating } = parsed.data;
  // Apply defaults for optional fields
  const radiusMeters = parsed.data.radiusMeters ?? 5000;
  const openNow = parsed.data.openNow ?? false;
  const maxResults = parsed.data.maxResults ?? 10;

  // Build request body
  const requestBody: Record<string, unknown> = {
    textQuery: query,
    pageSize: maxResults,
    locationBias: {
      circle: {
        center: {
          latitude: location.lat,
          longitude: location.lng,
        },
        radius: radiusMeters,
      },
    },
  };

  // Add open now filter if requested
  if (openNow) {
    requestBody.openNow = true;
  }

  try {
    const response = await fetch(PLACES_TEXT_SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_PLACES_API_KEY,
        "X-Goog-FieldMask": SEARCH_FIELD_MASK,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        venues: [],
        error: `Google Places API error (${response.status}): ${errorText}`,
      };
    }

    const data = (await response.json()) as GoogleTextSearchResponse;

    if (!data.places || data.places.length === 0) {
      return {
        venues: [],
        error: "No places found for the given query",
      };
    }

    // Transform to our Venue schema
    let venues = data.places.map(transformToVenue);

    // Apply client-side minimum rating filter if specified
    if (minRating !== undefined) {
      venues = venues.filter((v) => (v.rating ?? 0) >= minRating);
    }

    return { venues };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return {
      venues: [],
      error: `Failed to search places: ${message}`,
    };
  }
}

// City center coordinates cache (expand as needed)
const CITY_CENTERS: Record<string, Location> = {
  barcelona: { lat: 41.3874, lng: 2.1686 },
  madrid: { lat: 40.4168, lng: -3.7038 },
  paris: { lat: 48.8566, lng: 2.3522 },
  london: { lat: 51.5074, lng: -0.1278 },
  rome: { lat: 41.9028, lng: 12.4964 },
  berlin: { lat: 52.52, lng: 13.405 },
  amsterdam: { lat: 52.3676, lng: 4.9041 },
  lisbon: { lat: 38.7223, lng: -9.1393 },
  vienna: { lat: 48.2082, lng: 16.3738 },
  prague: { lat: 50.0755, lng: 14.4378 },
  "new york": { lat: 40.7128, lng: -74.006 },
  "los angeles": { lat: 34.0522, lng: -118.2437 },
  tokyo: { lat: 35.6762, lng: 139.6503 },
  sydney: { lat: -33.8688, lng: 151.2093 },
  helsinki: { lat: 60.1699, lng: 24.9384 },
};

/**
 * Get city center coordinates
 * Returns undefined if city not found (should trigger geocoding or clarification)
 */
export function getCityCenter(city: string): Location | undefined {
  const normalized = city.toLowerCase().trim();
  return CITY_CENTERS[normalized];
}

/**
 * Build search queries for different venue types
 */
export function buildSearchQuery(
  category: "activity" | "dinner" | "finish",
  city: string,
  preferences: { vibe?: string[]; dietary?: string[]; likes?: string[]; alcoholOk?: boolean; familyFriendly?: boolean }
): string {
  const vibeTerms = preferences.vibe?.join(" ") ?? "";
  const dietaryTerms = preferences.dietary?.length
    ? preferences.dietary.join(" ")
    : "";
  const likesTerms = preferences.likes?.join(" ") ?? "";
  const isFamily = preferences.familyFriendly === true;

  switch (category) {
    case "activity":
      if (isFamily) {
        return `family friendly kid friendly ${vibeTerms} ${likesTerms} activities things to do in ${city}`.trim();
      }
      return `${vibeTerms} ${likesTerms} activities things to do in ${city}`.trim();
    case "dinner":
      if (isFamily) {
        return `family friendly ${vibeTerms} ${dietaryTerms} restaurant lunch dinner in ${city}`.trim();
      }
      return `${vibeTerms} ${dietaryTerms} restaurant dinner in ${city}`.trim();
    case "finish":
      // Family or no alcohol = cafes and dessert
      if (isFamily || preferences.alcoholOk === false) {
        return `family friendly ${vibeTerms} cafe dessert ice cream in ${city}`.trim();
      }
      return `${vibeTerms} bar cocktail lounge in ${city}`.trim();
  }
}
