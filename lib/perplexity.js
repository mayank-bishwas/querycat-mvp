// lib/perplexity.js
// V1.1 — Core analysis logic for Perplexity Search API
//
// The Perplexity Chef: Always searches, never guesses.
// Unlike ChatGPT/Gemini, Perplexity is a search engine first.
//
// V1.1: REMOVED MAX_RESULTS limit - let API return what it wants
//       Fanout count is now dynamic via helpers.js
//
// Exports:
//   analyzeQuery(query, apiKey) → result object or throws error
//
// Contract: Returns the SAME shape as chatgpt.js and gemini.js
// so the API layer can treat all LLMs uniformly.

import { cleanFanoutQueries } from './helpers.js';

/* =========================
   CONFIGURATION
========================= */

const CONFIG = {
  MIN_QUERY_LENGTH: 4,
  MAX_QUERY_LENGTH: 100,
  // REMOVED: MAX_RESULTS - let Perplexity return all results
  // REMOVED: MAX_FANOUTS - now dynamic via helpers.js
};

// CCP penalties by category (same as chatgpt.js)
const CATEGORY_CCP_PENALTIES = {
  "Local/Maps": 25,
  "Social/UGC": 20,
  "Stock Images": 15,
  "Video": 10,
  "Forums": 5,
  "Official Docs": 0,
  "Institutions": 0,
  "News": 0,
  "Blogs": 0,
  "Reviews": 0,
  "eCommerce": 0,
  "Docs/PDFs": 0,
  "Brands": 0,
  "Local/Dining": 5,
};

/* =========================
   LANGUAGE DETECTION
========================= */

function detectQueryLanguage(query) {
  const scripts = {
    hindi: /[\u0900-\u097F]/g,
    arabic: /[\u0600-\u06FF]/g,
    chinese: /[\u4E00-\u9FFF]/g,
    japanese: /[\u3040-\u30FF]/g,
    korean: /[\uAC00-\uD7AF]/g,
    cyrillic: /[\u0400-\u04FF]/g,
    spanish: /[áéíóúüñ¿¡]/gi,
    french: /[àâäéèêëïîôùûüÿç]/gi,
    german: /[äöüß]/gi,
  };

  for (const [lang, regex] of Object.entries(scripts)) {
    const matches = query.match(regex);
    if (matches && matches.length >= 2) {
      return lang;
    }
  }

  return "english";
}

/* =========================
   URL HELPERS
========================= */

function stripQueryParams(url) {
  try {
    const u = new URL(url);
    
    // List of tracking/noise params to remove
    const paramsToRemove = [
      "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
      "ref", "source", "fbclid", "gclid", "msclkid", "mc_cid", "mc_eid",
      "si", "feature", "pp"  // YouTube-specific noise params
    ];
    
    paramsToRemove.forEach((param) => u.searchParams.delete(param));
    
    // Return full URL with remaining query params
    const search = u.searchParams.toString();
    return `${u.origin}${u.pathname}${search ? '?' + search : ''}`;
  } catch {
    return url;
  }
}

function extractDomain(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/* =========================
   SOURCE CLASSIFICATION
========================= */

function classifySource(url, title = "") {
  const u = url.toLowerCase();
  const t = (title || "").toLowerCase();

  if (u.endsWith(".pdf")) return "Docs/PDFs";

  if (
    u.includes("/maps") ||
    u.includes("maps.google") ||
    u.includes("openstreetmap") ||
    u.includes("yelp.com") ||
    u.includes("tripadvisor")
  ) {
    return "Local/Maps";
  }

  if (
    u.includes("youtube.com") ||
    u.includes("youtu.be") ||
    u.includes("vimeo.com") ||
    u.includes("dailymotion.com") ||
    u.includes("tiktok.com") ||
    u.includes("/video/") ||
    u.includes("/watch")
  ) {
    return "Video";
  }

  if (
    u.includes("facebook.com") ||
    u.includes("instagram.com") ||
    u.includes("twitter.com") ||
    u.includes("x.com/") ||
    u.includes("pinterest.com") ||
    u.includes("linkedin.com/pulse") ||
    u.includes("medium.com/@")
  ) {
    return "Social/UGC";
  }

  if (
    u.includes("reddit.com") ||
    u.includes("quora.com") ||
    u.includes("stackexchange.com") ||
    u.includes("stackoverflow.com") ||
    u.includes("/forum") ||
    u.includes("/community") ||
    u.includes("/discuss")
  ) {
    return "Forums";
  }

  if (
    u.includes(".gov") ||
    u.includes(".edu") ||
    u.includes(".org") ||
    u.includes(".ac.") ||
    u.includes("oecd.org") ||
    u.includes("who.int") ||
    u.includes("unesco")
  ) {
    return "Institutions";
  }

  if (
    u.includes("/docs/") ||
    u.includes("/help/") ||
    u.includes("/support/") ||
    u.includes("help.") ||
    u.includes("docs.") ||
    u.includes("support.") ||
    u.includes("/academy/") ||
    u.includes("status.")
  ) {
    return "Official Docs";
  }

  if (
    u.includes("stock.adobe") ||
    u.includes("shutterstock") ||
    u.includes("gettyimages") ||
    u.includes("istockphoto") ||
    u.includes("unsplash.com") ||
    u.includes("pexels.com")
  ) {
    return "Stock Images";
  }

  if (
    u.includes("g2.com") ||
    u.includes("capterra.com") ||
    u.includes("trustpilot") ||
    u.includes("trustradius") ||
    u.includes("/review") ||
    u.includes("/compare") ||
    u.includes("/vs/")
  ) {
    return "Reviews";
  }

  if (
    u.includes("amazon.") ||
    u.includes("flipkart.") ||
    u.includes("ebay.") ||
    u.includes("walmart.") ||
    u.includes("/product/") ||
    u.includes("/buy/") ||
    u.includes("/shop/") ||
    u.includes("/cart") ||
    u.includes("/checkout")
  ) {
    return "eCommerce";
  }

  if (
    u.includes("/news/") ||
    u.includes("/article/") ||
    u.includes("/story/") ||
    u.includes("news.") ||
    u.includes("bbc.com") ||
    u.includes("cnn.com") ||
    u.includes("reuters.com") ||
    u.includes("techcrunch.com") ||
    u.includes("theverge.com") ||
    u.includes("wired.com")
  ) {
    return "News";
  }

  if (
    u.includes("/blog/") ||
    u.includes("/blog.") ||
    u.includes("blog.") ||
    u.includes("/guide/") ||
    u.includes("/how-to/") ||
    u.includes("/tutorial/") ||
    t.includes("guide") ||
    t.includes("how to") ||
    t.includes("tutorial")
  ) {
    return "Blogs";
  }

  // Catch-all for likely brand pages
  if (
    !u.includes("/") ||
    u.split("/").length <= 4
  ) {
    return "Brands";
  }

  return "Blogs"; // Default
}

/* =========================
   CCP CALCULATION
========================= */

function analyzeQuerySignals(query) {
  const q = query.toLowerCase();
  
  return {
    hasYear: /\b20[0-9]{2}\b/.test(q),
    hasRecency: /\b(latest|new|recent|current|update|today|now)\b/.test(q),
    hasCommercial: /\b(best|top|buy|price|cost|cheap|review|vs|compare)\b/.test(q),
    hasLocation: /\b(near|in|at|from)\s+[A-Z]/.test(query) || /\b(india|usa|uk|london|sydney|delhi)\b/i.test(q),
    hasMediaType: /\b(pdf|video|image|photo|infographic|tutorial)\b/.test(q),
    hasQuestion: /^(who|what|where|when|why|how|is|are|can|do|does)\b/.test(q),
    isAmbiguous: query.trim().split(/\s+/).length <= 2,
  };
}

function calculateCategoryDominance(sourceDiversity, totalSources) {
  if (sourceDiversity.length === 0 || totalSources === 0) {
    return { topCategory: null, dominanceRatio: 0 };
  }
  
  const topCategory = sourceDiversity[0];
  const dominanceRatio = topCategory.count / totalSources;
  
  return {
    topCategory: topCategory.category,
    topCategoryCount: topCategory.count,
    dominanceRatio: Math.round(dominanceRatio * 100) / 100
  };
}

function calculateCCP(uniqueUrls, sourceDiversity, querySignals) {
  // Perplexity always searches, so we calculate CCP based on results quality
  const U = Math.min(uniqueUrls.length, 8);
  const D = Math.min(sourceDiversity.length, 8);
  const totalSources = uniqueUrls.length;

  // Base formula (same as chatgpt.js)
  let base = 0.4 + 0.30 * Math.log(1 + U) + 0.20 * (D / 8);

  // Query signal bonuses
  if (querySignals.hasYear) base += 0.08;
  if (querySignals.hasRecency) base += 0.10;
  if (querySignals.hasCommercial) base += 0.08;
  if (querySignals.hasLocation) base += 0.05;
  if (querySignals.hasMediaType) base += 0.05;

  // Category dominance penalties
  const dominance = calculateCategoryDominance(sourceDiversity, totalSources);
  let ccpPenalty = 0;
  let softCap = 100;

  if (dominance.dominanceRatio > 0.7) {
    softCap = 70;
  } else if (dominance.dominanceRatio > 0.5) {
    softCap = 80;
  }

  if (dominance.dominanceRatio > 0.5 && dominance.topCategory) {
    ccpPenalty = CATEGORY_CCP_PENALTIES[dominance.topCategory] || 0;
  }

  // Edge case: search happened but no results
  if (U === 0) {
    base = Math.min(base, 0.50);
  }

  let ccp = Math.round(Math.min(1, Math.max(0, base)) * 100);
  
  ccp = Math.min(ccp, softCap);
  
  ccp = Math.max(0, ccp - ccpPenalty);

  return {
    ccp,
    dominance,
    ccpPenalty: ccpPenalty > 0 ? ccpPenalty : undefined,
    softCap: softCap < 100 ? softCap : undefined
  };
}

/* =========================
   MAIN EXPORT: analyzeQuery
========================= */

/**
 * Analyze a single query using Perplexity Search API
 * 
 * @param {string} query - The user's query
 * @param {string} apiKey - Perplexity API key
 * @returns {Promise<object>} Analysis result
 * @throws {Error} On API failure, rate limit, timeout, etc.
 */
export async function analyzeQuery(query, apiKey) {
  // Validate query length
  const cleanedQuery = typeof query === "string" ? query.trim() : "";

  if (cleanedQuery.length < CONFIG.MIN_QUERY_LENGTH) {
    const error = new Error(`Query must be at least ${CONFIG.MIN_QUERY_LENGTH} characters`);
    error.type = "QUERY_TOO_SHORT";
    throw error;
  }

  if (cleanedQuery.length > CONFIG.MAX_QUERY_LENGTH) {
    const error = new Error(`Query must be under ${CONFIG.MAX_QUERY_LENGTH} characters`);
    error.type = "QUERY_TOO_LONG";
    throw error;
  }

  const queryLanguage = detectQueryLanguage(cleanedQuery);
  const querySignals = analyzeQuerySignals(cleanedQuery);

  // Call Perplexity Search API - NO max_results limit
  const response = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "sonar",
      messages: [
        { role: "user", content: cleanedQuery }
      ],
      // No max_results - let API return all
    }),
  });

  // Handle HTTP errors
  if (!response.ok) {
    const status = response.status;
    
    if (status === 429) {
      const error = new Error("Perplexity rate limit reached 🙀");
      error.type = "RATE_LIMIT";
      throw error;
    }
    
    if (status === 401) {
      const error = new Error("Perplexity API key invalid 🔑");
      error.type = "AUTH_ERROR";
      throw error;
    }
    
    if (status === 408 || status === 504) {
      const error = new Error("Perplexity search timed out ⏱️");
      error.type = "TIMEOUT";
      throw error;
    }
    
    const error = new Error(`Perplexity API error (${status}) 🐱‍👤`);
    error.type = "API_ERROR";
    throw error;
  }

  const data = await response.json();

  // Extract citations from Perplexity response
  const citations = data.citations || [];

  // Perplexity always searches, but might return no citations
  if (citations.length === 0) {
    return {
      llm: "perplexity",
      query: cleanedQuery,
      query_language: queryLanguage,
      needs_search: true,
      ccp: 40, // Base CCP for a search with no results
      fanout_queries: [cleanedQuery],
      cited_sources: [],
      unique_domains: 0,
      source_diversity: [],
      warning: "Search performed but no sources found.",
      warning_type: "NO_RESULTS",
    };
  }

  // Parse sources from citations
  const sources = citations
    .filter(url => url && typeof url === 'string')
    .map(url => ({
      url: stripQueryParams(url),
      title: extractDomain(url), // Perplexity doesn't give titles, use domain
      domain: extractDomain(url),
    }));

  // Deduplicate by URL
  const uniqueSources = Array.from(
    new Map(sources.map((s) => [s.url, s])).values()
  );

  const uniqueUrls = uniqueSources.map((s) => s.url);
  const uniqueDomains = [...new Set(uniqueSources.map((s) => s.domain))];

  // Calculate source diversity
  const categoryCount = {};

  uniqueSources.forEach(({ url, title }) => {
    const category = classifySource(url, title);
    categoryCount[category] = (categoryCount[category] || 0) + 1;
  });

  const sourceDiversity = Object.entries(categoryCount)
    .sort((a, b) => b[1] - a[1])
    .map(([category, count]) => ({ category, count }));

  // Generate fanout queries via helpers.js (dynamic count based on URL count)
  const fanoutQueries = await cleanFanoutQueries(cleanedQuery, uniqueSources);

  // Calculate CCP
  const ccpResult = calculateCCP(
    uniqueUrls,
    sourceDiversity,
    querySignals
  );

  // Build result object
  const result = {
    llm: "perplexity",
    query: cleanedQuery,
    query_language: queryLanguage,
    needs_search: true, // Perplexity always searches
    ccp: ccpResult.ccp,
    fanout_queries: fanoutQueries,
    cited_sources: uniqueUrls,
    unique_domains: uniqueDomains.length,
    source_diversity: sourceDiversity,
  };

  // Add dominance info if significant
  if (ccpResult.dominance && ccpResult.dominance.dominanceRatio > 0.5) {
    result.category_dominance = {
      category: ccpResult.dominance.topCategory,
      ratio: ccpResult.dominance.dominanceRatio,
      ccp_impact: ccpResult.ccpPenalty ? `-${ccpResult.ccpPenalty}` : "none"
    };
  }

  return result;
}

// Export CONFIG for validation in API wrappers
export { CONFIG };
