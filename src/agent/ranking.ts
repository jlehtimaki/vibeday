import type { Venue, Preferences, Location } from "../types/index.js";

// Scoring weights
const WEIGHTS = {
  rating: 0.30,      // Quality matters most
  proximity: 0.25,   // Keep venues close together
  priceMatch: 0.20,  // Match budget expectations
  preferenceMatch: 0.15, // Match user preferences
  reviewCount: 0.10, // More reviews = more reliable
};

// Price level to EUR per person mapping (approximate)
const PRICE_LEVEL_EUR: Record<number, [number, number]> = {
  0: [0, 10],      // Free
  1: [10, 25],     // Inexpensive
  2: [25, 50],     // Moderate
  3: [50, 100],    // Expensive
  4: [100, 200],   // Very expensive
};

/**
 * Calculate distance between two locations (Haversine formula)
 * Returns distance in meters
 */
function calculateDistance(loc1: Location, loc2: Location): number {
  const R = 6371000; // Earth's radius in meters
  const lat1 = (loc1.lat * Math.PI) / 180;
  const lat2 = (loc2.lat * Math.PI) / 180;
  const dLat = ((loc2.lat - loc1.lat) * Math.PI) / 180;
  const dLng = ((loc2.lng - loc1.lng) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

/**
 * Calculate centroid of a set of venues
 */
function calculateCentroid(venues: Venue[]): Location {
  if (venues.length === 0) {
    return { lat: 0, lng: 0 };
  }

  const sum = venues.reduce(
    (acc, v) => ({
      lat: acc.lat + v.location.lat,
      lng: acc.lng + v.location.lng,
    }),
    { lat: 0, lng: 0 }
  );

  return {
    lat: sum.lat / venues.length,
    lng: sum.lng / venues.length,
  };
}

/**
 * Score a venue's rating (0-1 scale)
 */
function scoreRating(venue: Venue): number {
  if (!venue.rating) return 0.5; // Neutral if no rating
  // Normalize: 4.0 = 0.5, 5.0 = 1.0, 3.0 = 0.0
  return Math.max(0, Math.min(1, (venue.rating - 3) / 2));
}

/**
 * Score proximity to a reference point (0-1 scale)
 * Closer is better, with 500m = 1.0, 2000m = 0.5, 5000m = 0.0
 */
function scoreProximity(venue: Venue, reference: Location): number {
  const distance = calculateDistance(venue.location, reference);
  if (distance <= 500) return 1.0;
  if (distance >= 5000) return 0.0;
  return 1 - (distance - 500) / 4500;
}

/**
 * Score price match (0-1 scale)
 * Perfect match = 1.0, within range = 0.7, outside = 0.3
 */
function scorePriceMatch(venue: Venue, targetBudgetPerPerson: number): number {
  if (venue.priceLevel === undefined) return 0.5; // Neutral if unknown

  const range = PRICE_LEVEL_EUR[venue.priceLevel];
  if (!range) return 0.5;

  const [min, max] = range;
  if (targetBudgetPerPerson >= min && targetBudgetPerPerson <= max) {
    return 1.0; // Perfect match
  }
  if (targetBudgetPerPerson < min) {
    // Over budget
    const overBy = min - targetBudgetPerPerson;
    return Math.max(0.1, 0.7 - overBy / 50);
  }
  // Under budget (venue cheaper than target - that's okay)
  return 0.8;
}

/**
 * Score preference match (0-1 scale)
 * Based on venue category matching user's vibe/likes
 */
function scorePreferenceMatch(venue: Venue, preferences: Preferences): number {
  let score = 0.5; // Base score

  // Check if category aligns with likes
  const likes = preferences.likes.map((l) => l.toLowerCase());
  const vibes = preferences.vibe.map((v) => v.toLowerCase());
  const venueName = venue.name.toLowerCase();
  const venueCategory = venue.category.toLowerCase();

  // Boost for matching likes
  for (const like of likes) {
    if (venueName.includes(like) || venueCategory.includes(like)) {
      score += 0.15;
    }
  }

  // Boost for matching vibes (if venue name suggests it)
  const vibeKeywords: Record<string, string[]> = {
    romantic: ["intimate", "candlelit", "cozy", "wine", "french", "italian"],
    adventurous: ["escape", "adventure", "tour", "climb", "explore"],
    relaxed: ["lounge", "cafe", "garden", "terrace", "spa"],
    fancy: ["michelin", "fine dining", "premium", "gourmet", "luxur"],
    playful: ["game", "bowling", "arcade", "karaoke", "comedy"],
  };

  for (const vibe of vibes) {
    const keywords = vibeKeywords[vibe] ?? [];
    for (const keyword of keywords) {
      if (venueName.includes(keyword)) {
        score += 0.1;
      }
    }
  }

  return Math.min(1.0, score);
}

/**
 * Score review count (0-1 scale)
 * More reviews = more reliable data
 */
function scoreReviewCount(venue: Venue): number {
  if (!venue.reviewCount) return 0.3; // Low confidence if no reviews
  if (venue.reviewCount >= 500) return 1.0;
  if (venue.reviewCount >= 100) return 0.8;
  if (venue.reviewCount >= 50) return 0.6;
  if (venue.reviewCount >= 20) return 0.4;
  return 0.3;
}

export interface ScoredVenue {
  venue: Venue;
  score: number;
  scores: {
    rating: number;
    proximity: number;
    priceMatch: number;
    preferenceMatch: number;
    reviewCount: number;
  };
}

/**
 * Score and rank a list of venues
 */
export function rankVenues(
  venues: Venue[],
  preferences: Preferences,
  targetBudgetPerPerson: number,
  referenceLocation?: Location
): ScoredVenue[] {
  // Use centroid as reference if not provided
  const reference = referenceLocation ?? calculateCentroid(venues);

  const scored = venues.map((venue) => {
    const scores = {
      rating: scoreRating(venue),
      proximity: scoreProximity(venue, reference),
      priceMatch: scorePriceMatch(venue, targetBudgetPerPerson),
      preferenceMatch: scorePreferenceMatch(venue, preferences),
      reviewCount: scoreReviewCount(venue),
    };

    const totalScore =
      scores.rating * WEIGHTS.rating +
      scores.proximity * WEIGHTS.proximity +
      scores.priceMatch * WEIGHTS.priceMatch +
      scores.preferenceMatch * WEIGHTS.preferenceMatch +
      scores.reviewCount * WEIGHTS.reviewCount;

    return {
      venue,
      score: totalScore,
      scores,
    };
  });

  // Sort by score descending
  return scored.sort((a, b) => b.score - a.score);
}

/**
 * Cluster venues by proximity
 * Returns venues grouped into clusters that are within maxDistance of each other
 */
export function clusterByProximity(
  venues: Venue[],
  maxDistanceMeters: number = 1500
): Venue[][] {
  if (venues.length === 0) return [];

  const clusters: Venue[][] = [];
  const assigned = new Set<string>();

  for (const venue of venues) {
    if (assigned.has(venue.placeId)) continue;

    // Start new cluster
    const cluster: Venue[] = [venue];
    assigned.add(venue.placeId);

    // Find nearby venues
    for (const other of venues) {
      if (assigned.has(other.placeId)) continue;

      const distance = calculateDistance(venue.location, other.location);
      if (distance <= maxDistanceMeters) {
        cluster.push(other);
        assigned.add(other.placeId);
      }
    }

    clusters.push(cluster);
  }

  // Sort clusters by size (largest first)
  return clusters.sort((a, b) => b.length - a.length);
}

/**
 * Select the best venues for an itinerary
 * Prioritizes quality and proximity clustering
 */
export function selectBestVenues(
  pools: {
    activity: Venue[];
    dinner: Venue[];
    finish: Venue[];
  },
  preferences: Preferences,
  budgetPerCategory: {
    activity: number;
    dinner: number;
    finish: number;
  }
): {
  selected: Record<string, Venue>;
  backups: Record<string, Venue[]>;
} {
  // Rank each pool
  const rankedActivity = rankVenues(
    pools.activity,
    preferences,
    budgetPerCategory.activity
  );
  const rankedDinner = rankVenues(
    pools.dinner,
    preferences,
    budgetPerCategory.dinner
  );
  const rankedFinish = rankVenues(
    pools.finish,
    preferences,
    budgetPerCategory.finish
  );

  // Select top venue from each category
  const selected: Record<string, Venue> = {};
  const backups: Record<string, Venue[]> = {
    activity: [],
    dinner: [],
    finish: [],
  };

  if (rankedActivity.length > 0 && rankedActivity[0]) {
    selected["activity"] = rankedActivity[0].venue;
    backups["activity"] = rankedActivity.slice(1, 3).map((s) => s.venue);
  }

  if (rankedDinner.length > 0 && rankedDinner[0]) {
    selected["dinner"] = rankedDinner[0].venue;
    // PRD requires 2 dinner backups
    backups["dinner"] = rankedDinner.slice(1, 4).map((s) => s.venue);
  }

  if (rankedFinish.length > 0 && rankedFinish[0]) {
    selected["finish"] = rankedFinish[0].venue;
    backups["finish"] = rankedFinish.slice(1, 3).map((s) => s.venue);
  }

  // Re-rank based on proximity to selected dinner (most important stop)
  if (selected["dinner"]) {
    const dinnerLocation = selected["dinner"].location;

    // Re-evaluate activity selection for proximity to dinner
    if (rankedActivity.length > 1) {
      const rerankedActivity = rankVenues(
        pools.activity,
        preferences,
        budgetPerCategory.activity,
        dinnerLocation
      );
      if (rerankedActivity[0]) {
        selected["activity"] = rerankedActivity[0].venue;
        backups["activity"] = rerankedActivity.slice(1, 3).map((s) => s.venue);
      }
    }

    // Re-evaluate finish selection for proximity to dinner
    if (rankedFinish.length > 1) {
      const rerankedFinish = rankVenues(
        pools.finish,
        preferences,
        budgetPerCategory.finish,
        dinnerLocation
      );
      if (rerankedFinish[0]) {
        selected["finish"] = rerankedFinish[0].venue;
        backups["finish"] = rerankedFinish.slice(1, 3).map((s) => s.venue);
      }
    }
  }

  return { selected, backups };
}

/**
 * Calculate total distance of an itinerary
 */
export function calculateItineraryDistance(venues: Venue[]): number {
  let total = 0;
  for (let i = 0; i < venues.length - 1; i++) {
    const from = venues[i];
    const to = venues[i + 1];
    if (from && to) {
      total += calculateDistance(from.location, to.location);
    }
  }
  return total;
}
