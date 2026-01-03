// lib/analyzers/chatgpt.js
// V2.3 — Core analysis logic for ChatGPT web search
// Extracted from api/single-real.js for reuse in single + bulk endpoints
//
// This is THE BRAIN. Both single-real.js and bulk-real.js call this.
// One brain, two bodies. No drift, no drama.
//
// Exports:
//   analyzeQuery(query, apiKey) → result object or throws error
//
// Changelog:
// - V2.3: Improved fanout cleaning (5+ digit IDs, date patterns, noise words)
// - V2.2: Entity-style fanout limiting, CCP soft-caps, category penalties
// - V2.1: URL encoding fix, deduplication, language preservation

import OpenAI from "openai";
import { cleanFanoutQueries } from './helpers.js';  

/* =========================
   CONFIGURATION
========================= */

const CONFIG = {
  MIN_QUERY_LENGTH: 4,
  MAX_QUERY_LENGTH: 100,
  MIN_FANOUT_LENGTH: 10,
  MAX_FANOUTS: 6,
  MAX_ENTITY_FANOUTS: 3,
  MIN_FANOUTS_IF_SOURCES: 2,
};

// CCP penalties by category when that category dominates
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

// Noise words to filter out from fanouts
const NOISE_WORDS = new Set([
  "newsroom", "news", "article", "articles", "blog", "blogs", "post", "posts",
  "story", "stories", "press", "media", "release", "releases",
  "page", "pages", "index", "home", "default", "main",
  "category", "categories", "tag", "tags", "archive", "archives",
  "content", "contents", "site", "web", "www", "http", "https",
  "html", "htm", "php", "aspx", "jsp",
  "en", "us", "uk", "in", "de", "fr", "es", "pt", "it", "nl", "ja", "ko", "zh",
  "amp", "mobile", "print", "share", "comment", "comments",
  "undefined", "null", "none", "empty"
]);

// Action words that indicate query-style (not entity-style) fanout
const ACTION_WORDS = new Set([
  "best", "top", "how", "what", "why", "where", "when", "who",
  "compare", "vs", "versus", "review", "guide", "tutorial",
  "list", "tips", "ways", "steps", "learn", "find", "get",
  "buy", "price", "cost", "cheap", "free", "near", "in", "for"
]);

// Location words that suggest entity-style fanout
const LOCATION_WORDS = new Set([
  "delhi", "mumbai", "bangalore", "chennai", "kolkata", "hyderabad",
  "pune", "ahmedabad", "jaipur", "lucknow", "patna", "india", "भारत",
  "london", "new york", "sydney", "tokyo", "paris", "berlin",
  "दिल्ली", "मुंबई", "चेन्नई", "कोलकाता"
]);

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

function isGoogleMapsUrl(url) {
  return url.includes("google.com/maps") || url.includes("maps.google");
}

function extractEntityFromMapsUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname;
    
    const match = path.match(/\/maps\/(?:search|place)\/([^/]+)/);
    if (!match) return null;
    
    let entity = decodeURIComponent(match[1]);
    
    entity = entity
      .replace(/\+/g, " ")
      .replace(/,/g, " ")
      .replace(/\([^)]*\)/g, "")
      .replace(/\s+/g, " ")
      .trim();
    
    const parts = entity.split(/\s{2,}|,/);
    if (parts.length > 0) {
      return parts[0].trim();
    }
    
    return entity;
  } catch {
    return null;
  }
}

/* =========================
   TEXT NORMALIZATION
========================= */

function normalizeText(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\u00C0-\u024F\u0900-\u097F\u4E00-\u9FFF\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractWords(str) {
  return normalizeText(str).split(" ").filter((w) => w.length > 0);
}

function decodeAndClean(str) {
  try {
    let decoded = str;
    try {
      decoded = decodeURIComponent(str.replace(/\+/g, " "));
    } catch {
      // Continue with original if decoding fails
    }

    return decoded
      .replace(/\b\d{5,}\b/g, "")
      .replace(/\b\d{2}[-_]?\d{2}[-_]?\d{4}\b/g, "")
      .replace(/\b\d{4}[-_]?\d{2}[-_]?\d{2}\b/g, "")
      .replace(/\b\d{2}[-/_]\d{2}[-/_]\d{4}\b/g, "")
      .replace(/\b\d{4}[-/_]\d{2}[-/_]\d{2}\b/g, "")
      .replace(/\b[a-f0-9]{2}\s+[a-f0-9]{2}\b/gi, "")
      .replace(/\b[a-z]\d{4,}[-_]?\d*\b/gi, "")
      .replace(/^\d{5,}[-_\s]*/g, "")
      .replace(/[-_]/g, " ")
      .replace(/\.(html|htm|php|aspx|pdf)$/i, "")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return str;
  }
}

function removeNoiseWords(words) {
  return words.filter(w => {
    const lower = w.toLowerCase();
    if (NOISE_WORDS.has(lower)) return false;
    if (w.length < 3) return false;
    if (/^\d+$/.test(w)) return false;
    return true;
  });
}

function isGarbageFanout(fanout) {
  const words = fanout.split(/\s+/);
  
  if (words.length < 2) return true;
  
  const numberCount = words.filter(w => /\d/.test(w)).length;
  if (numberCount > words.length * 0.5) return true;
  
  const avgLen = fanout.replace(/\s/g, "").length / words.length;
  if (avgLen < 3) return true;
  
  if (/^\d/.test(fanout)) return true;
  
  if (/\d{5,}/.test(fanout)) return true;
  
  return false;
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
   FANOUT CLASSIFICATION
========================= */

function isEntityStyleFanout(fanout) {
  const words = fanout.toLowerCase().split(/\s+/);
  
  if (words.some(w => ACTION_WORDS.has(w))) {
    return false;
  }
  
  if (words.length <= 4 && words.some(w => LOCATION_WORDS.has(w))) {
    return true;
  }
  
  const entityIndicators = ["ias", "academy", "institute", "coaching", "classes", "school", "college", "university"];
  if (entityIndicators.some(ind => fanout.toLowerCase().includes(ind))) {
    return true;
  }
  
  const originalWords = fanout.split(/\s+/);
  const capitalizedCount = originalWords.filter(w => /^[A-Z\u0900-\u097F]/.test(w)).length;
  if (capitalizedCount > words.length * 0.6 && words.length <= 5) {
    return true;
  }
  
  return false;
}

function scoreFanout(fanout, isEntity) {
  let score = 50;
  
  const lower = fanout.toLowerCase();
  const words = lower.split(/\s+/);
  
  if (isEntity) {
    score -= 30;
  }
  
  if (words.some(w => ACTION_WORDS.has(w))) {
    score += 20;
  }
  
  if (/\b20[0-9]{2}\b/.test(fanout)) {
    score += 15;
  }
  
  if (words.length >= 4 && words.length <= 7) {
    score += 10;
  }
  
  if (words.length < 3) {
    score -= 15;
  }
  
  return score;
}

/* =========================
   FANOUT GENERATION
========================= */

function mapsUrlToFanout(url, title) {
  const entity = extractEntityFromMapsUrl(url);
  if (entity && entity.length >= 5 && entity.length <= 50) {
    return entity;
  }
  
  if (title) {
    const cleanTitle = decodeAndClean(title);
    if (cleanTitle.length >= 5 && cleanTitle.length <= 50) {
      return cleanTitle;
    }
  }
  
  return null;
}

function titleSlugToFanout(title, url, queryLanguage) {
  try {
    if (isGoogleMapsUrl(url)) {
      return mapsUrlToFanout(url, title);
    }
    
    const cleanUrl = stripQueryParams(url);
    const pathParts = cleanUrl.split("/").filter((p) => p.length > 0);
    const slug = pathParts[pathParts.length - 1] || "";

    if (!slug || slug.length < 3) return null;

    const cleanSlug = decodeAndClean(slug);
    let slugWords = extractWords(cleanSlug).filter((w) => w.length > 2);
    
    slugWords = removeNoiseWords(slugWords);

    const cleanTitle = decodeAndClean(title);
    let titleWords = extractWords(cleanTitle).filter((w) => w.length > 2);
    
    titleWords = removeNoiseWords(titleWords);

    if (slugWords.length < 2) return null;

    const merged = [...slugWords];
    const seen = new Set(slugWords.map((w) => w.toLowerCase()));

    for (const w of titleWords) {
      if (merged.length >= 8) break;
      const lower = w.toLowerCase();
      if (!seen.has(lower) && w.length > 3) {
        merged.push(w);
        seen.add(lower);
      }
    }

    let fanout = merged.join(" ").trim();

    if (fanout.length < CONFIG.MIN_FANOUT_LENGTH || fanout.length > 80) {
      return null;
    }

    if (isGarbageFanout(fanout)) {
      return null;
    }

    return fanout;
  } catch {
    return null;
  }
}

function processFanouts(rawFanouts, rewrittenQuery) {
  const rewrittenNormalized = rewrittenQuery.toLowerCase().trim();
  
  const scored = rawFanouts
    .filter(f => f && f.toLowerCase().trim() !== rewrittenNormalized)
    .map(f => {
      const isEntity = isEntityStyleFanout(f);
      return {
        text: f,
        isEntity,
        score: scoreFanout(f, isEntity)
      };
    });
  
  scored.sort((a, b) => b.score - a.score);
  
  const result = [rewrittenQuery];
  let entityCount = 0;
  const seen = new Set([rewrittenNormalized]);
  
  for (const item of scored) {
    if (result.length >= CONFIG.MAX_FANOUTS) break;
    
    const normalized = item.text.toLowerCase().trim();
    if (seen.has(normalized)) continue;
    
    if (item.isEntity) {
      if (entityCount >= CONFIG.MAX_ENTITY_FANOUTS) continue;
      entityCount++;
    }
    
    result.push(item.text);
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

  let base = 0.4 + 0.30 * Math.log(1 + U) + 0.20 * (D / 8);

  if (querySignals.hasYear) base += 0.08;
  if (querySignals.hasRecency) base += 0.10;
  if (querySignals.hasCommercial) base += 0.08;
  if (querySignals.hasLocation) base += 0.05;
  if (querySignals.hasMediaType) base += 0.05;

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
 * Analyze a single query using ChatGPT's web search
 * 
 * @param {string} query - The user's query
 * @param {string} apiKey - OpenAI API key
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

  const client = new OpenAI({ apiKey });

  // Make the real web search call
  const response = await client.responses.create({
    model: "gpt-4o-mini",
    input: cleanedQuery,
    tools: [{ type: "web_search" }],
  });

  const webSearchCall = response.output.find(
    (item) => item.type === "web_search_call"
  );

  // No search triggered — memory answer
  if (!webSearchCall) {
    return {
      llm: "chatgpt",
      query: cleanedQuery,
      query_language: queryLanguage,
      needs_search: false,
      message: "None. Because ChatGPT answered from memory; no web search was performed.",
      ccp: 0,
      fanout_queries: [],
      cited_sources: [],
      source_diversity: [],
    };
  }

  const rewrittenQuery = webSearchCall.action?.query || cleanedQuery;
  const queryWasRewritten = rewrittenQuery !== cleanedQuery;

  // Extract sources from response
  const sources = [];

  response.output.forEach((item) => {
    if (item.type === "message") {
      item.content?.forEach((block) => {
        block.annotations?.forEach((a) => {
          if (a.url && a.title) {
            sources.push({
              url: stripQueryParams(a.url),
              title: a.title,
              domain: extractDomain(a.url),
            });
          }
        });
      });
    }
  });

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

  // Generate fanout queries
  const rawFanouts = [];

  uniqueSources.forEach(({ title, url }) => {
    const f = titleSlugToFanout(title, url, queryLanguage);
    if (f) {
      rawFanouts.push(f);
    }
  });

  const fanoutQueries = await cleanFanoutQueries(
      cleanedQuery,
      uniqueSources
    );

  // Calculate CCP
  const ccpResult = calculateCCP(
    uniqueUrls,
    sourceDiversity,
    querySignals,
    true
  );

  // Build result object
  const result = {
    llm: "chatgpt",
    query: cleanedQuery,
    query_language: queryLanguage,
    needs_search: true,
    ccp: ccpResult.ccp,
    fanout_queries: fanoutQueries,
    cited_sources: uniqueUrls,
    unique_domains: uniqueDomains.length,
    source_diversity: sourceDiversity,
  };

  // Add rewritten query if changed
  if (queryWasRewritten) {
    result.rewritten_query = rewrittenQuery;
  }

  // Add dominance info if significant
  if (ccpResult.dominance && ccpResult.dominance.dominanceRatio > 0.5) {
    result.category_dominance = {
      category: ccpResult.dominance.topCategory,
      ratio: ccpResult.dominance.dominanceRatio,
      ccp_impact: ccpResult.ccpPenalty ? `-${ccpResult.ccpPenalty}` : "none"
    };
  }

  // Add warning if search triggered but no citations
  if (uniqueUrls.length === 0) {
    result.warning = "Web search was performed but no sources were cited.";
    result.warning_type = "NO_CITATIONS";
  }

  return result;
}

// Also export CONFIG for validation in API wrappers
export { CONFIG };