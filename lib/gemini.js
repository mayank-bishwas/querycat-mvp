// lib/gemini.js
// V1.1 — Core analysis logic for Gemini with Google Search grounding
//
// The Gemini Chef: Google's grounding gives us ACTUAL search queries.
// Unlike ChatGPT/Perplexity where we infer fanouts, Gemini tells us directly.
//
// V1.1: Added redirect resolver for proxy URLs
//
// Exports:
//   analyzeQuery(query, apiKey) → result object or throws error
//
// Contract: Returns the SAME shape as chatgpt.js and perplexity.js
// so the API layer can treat all LLMs uniformly.

import { GoogleGenerativeAI } from "@google/generative-ai";

/* =========================
   CONFIGURATION
========================= */

const CONFIG = {
  MIN_QUERY_LENGTH: 4,
  MAX_QUERY_LENGTH: 100,
  MODEL: "gemini-2.5-flash",
  MAX_FANOUTS: 6,
  REDIRECT_TIMEOUT_MS: 3000, // Max wait per redirect resolve
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
    ["utm_source", "utm_medium", "utm_campaign", "ref", "source"].forEach(
      (param) => u.searchParams.delete(param)
    );
    return `${u.origin}${u.pathname}`;
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

/**
 * Check if URL is a Google Vertex AI proxy redirect
 */
function isProxyUrl(url) {
  return url.includes("vertexaisearch.cloud.google.com");
}

/**
 * Resolve a single proxy URL to its real destination.
 * Makes a HEAD request and follows the redirect.
 * Returns original URL if resolution fails.
 */
async function resolveProxyUrl(proxyUrl) {
  if (!isProxyUrl(proxyUrl)) {
    return proxyUrl;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONFIG.REDIRECT_TIMEOUT_MS);

    const response = await fetch(proxyUrl, {
      method: "HEAD",
      redirect: "manual", // Don't auto-follow, we want the Location header
      signal: controller.signal,
    });

    clearTimeout(timeout);

    // Check for redirect (3xx status)
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location) {
        return location;
      }
    }

    // Some servers might return 200 with the final URL in response
    // In that case, we're already at the destination
    if (response.status === 200) {
      return response.url || proxyUrl;
    }

    // Fallback: return original
    return proxyUrl;

  } catch (err) {
    // Timeout, network error, etc. — return original
    return proxyUrl;
  }
}

/**
 * Resolve multiple proxy URLs in parallel.
 * Returns array of resolved URLs in same order as input.
 */
async function resolveProxyUrls(urls) {
  const promises = urls.map(url => resolveProxyUrl(url));
  return Promise.all(promises);
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
    u.includes("medium.com") ||
    u.includes("substack.com") ||
    u.includes("blogspot.com") ||
    u.includes("wordpress.com") ||
    (u.split("/").pop()?.split("-").length || 0) > 5
  ) {
    return "Blogs";
  }

  const foodKeywords = ["cafe", "coffee", "restaurant", "bar", "bistro", "espresso", "bakery", "diner"];
  if (foodKeywords.some((k) => u.includes(k) || t.includes(k))) {
    return "Local/Dining";
  }

  return "Brands";
}

/* =========================
   FANOUT PROCESSING
========================= */

/**
 * Process Gemini's webSearchQueries into fanouts.
 * Unlike ChatGPT/Perplexity, Gemini gives us ACTUAL queries — use them directly!
 */
function processFanouts(webSearchQueries, originalQuery) {
  if (!webSearchQueries || webSearchQueries.length === 0) {
    return [originalQuery];
  }

  const queryNormalized = originalQuery.toLowerCase().trim();
  const seen = new Set([queryNormalized]);
  const result = [originalQuery]; // Start with original

  for (const q of webSearchQueries) {
    if (result.length >= CONFIG.MAX_FANOUTS) break;
    
    const normalized = q.toLowerCase().trim();
    if (seen.has(normalized)) continue;
    
    // Skip very short or garbage queries
    if (q.length < 5 || q.length > 100) continue;
    
    result.push(q);
    seen.add(normalized);
  }

  return result;
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

function calculateCCP(uniqueUrls, sourceDiversity, querySignals, searchTriggered) {
  if (!searchTriggered) return { ccp: 0 };

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

  // Edge case: search happened but no sources
  if (searchTriggered && U === 0) {
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
 * Analyze a single query using Gemini with Google Search grounding
 * 
 * @param {string} query - The user's query
 * @param {string} apiKey - Google AI API key
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

  // Initialize Gemini client
  const genAI = new GoogleGenerativeAI(apiKey);
  
  const model = genAI.getGenerativeModel({
    model: CONFIG.MODEL,
    // Enable Google Search grounding
    tools: [{ googleSearch: {} }],
    // Minimize output tokens — we only need the grounding metadata
    systemInstruction: "Respond briefly. One sentence maximum.",
  });

  let response;
  
  try {
    response = await model.generateContent(cleanedQuery);
  } catch (err) {
    // Handle specific Gemini errors
    const msg = err?.message || "";
    
    if (msg.includes("429") || msg.includes("quota") || msg.includes("rate")) {
      const error = new Error("Gemini rate limit reached 🙀");
      error.type = "RATE_LIMIT";
      throw error;
    }
    
    if (msg.includes("401") || msg.includes("403") || msg.includes("API key")) {
      const error = new Error("Gemini API key invalid 🔑");
      error.type = "AUTH_ERROR";
      throw error;
    }
    
    if (msg.includes("timeout") || msg.includes("DEADLINE")) {
      const error = new Error("Gemini search timed out ⏱️");
      error.type = "TIMEOUT";
      throw error;
    }
    
    // Generic error
    const error = new Error(`Gemini API error: ${msg.slice(0, 100)} 🐱‍👤`);
    error.type = "API_ERROR";
    throw error;
  }

  // Extract grounding metadata
  const candidate = response.response?.candidates?.[0];
  const groundingMetadata = candidate?.groundingMetadata;

  // No grounding = answered from memory
  if (!groundingMetadata) {
    return {
      llm: "gemini",
      query: cleanedQuery,
      query_language: queryLanguage,
      needs_search: false,
      message: "None. Because Gemini answered from memory; no web search was performed.",
      ccp: 0,
      fanout_queries: [],
      cited_sources: [],
      source_diversity: [],
    };
  }

  // Extract web search queries (these are the actual fanouts!)
  const webSearchQueries = groundingMetadata.webSearchQueries || [];

  // Extract grounding chunks (sources) — raw proxy URLs for now
  const groundingChunks = groundingMetadata.groundingChunks || [];
  
  const rawSources = groundingChunks
    .filter(chunk => chunk.web?.uri)
    .map(chunk => ({
      proxyUrl: chunk.web.uri,
      title: chunk.web.title || "",
    }));

  // Resolve proxy URLs to real URLs (parallel for speed)
  const proxyUrls = rawSources.map(s => s.proxyUrl);
  const resolvedUrls = await resolveProxyUrls(proxyUrls);

  // Build sources with resolved URLs
  const sources = rawSources.map((source, index) => {
    const resolvedUrl = resolvedUrls[index];
    const cleanUrl = stripQueryParams(resolvedUrl);
    // Use title from Gemini, or extract domain as fallback
    const title = source.title || extractDomain(cleanUrl);
    return {
      url: cleanUrl,
      title,
      domain: extractDomain(cleanUrl),
    };
  });

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

  // Process fanouts (use Gemini's actual search queries)
  const fanoutQueries = processFanouts(webSearchQueries, cleanedQuery);

  // Calculate CCP
  const ccpResult = calculateCCP(
    uniqueUrls,
    sourceDiversity,
    querySignals,
    true
  );

  // Build result object
  const result = {
    llm: "gemini",
    query: cleanedQuery,
    query_language: queryLanguage,
    needs_search: true,
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

  // Warning if search triggered but no sources
  if (uniqueUrls.length === 0) {
    result.warning = "Web search was performed but no sources were cited.";
    result.warning_type = "NO_CITATIONS";
  }

  return result;
}

// Export CONFIG for validation in API wrappers
export { CONFIG };