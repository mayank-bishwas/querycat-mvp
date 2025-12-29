import 'dotenv/config';

// api/single-back.js
// V3.0 — Multi-LLM orchestrator for single-query analysis
//
// The Kitchen Manager: Calls all 3 chefs (ChatGPT, Gemini, Perplexity)
// sequentially, combines their results, calculates average CCP.
//
// One query in → three analyses out → unified response.

import { analyzeQuery as analyzeChatGPT, CONFIG } from "../lib/chatgpt.js";
import { analyzeQuery as analyzeGemini } from "../lib/gemini.js";
import { analyzeQuery as analyzePerplexity } from "../lib/perplexity.js";

/* =========================
   HELPER: Safe LLM Call
========================= */

/**
 * Call an LLM analyzer with error isolation.
 * If it fails, return an error result instead of throwing.
 * Also normalizes "empty search" results to no-search state.
 */
async function safeLLMCall(llmName, analyzerFn, query, apiKey) {
  try {
    const result = await analyzerFn(query, apiKey);
    
    // Normalize: if search triggered but no real results, treat as no-search
    if (result.needs_search === true) {
      const hasResults = 
        (result.cited_sources && result.cited_sources.length > 0) ||
        (result.fanout_queries && result.fanout_queries.length > 1);
      
      if (!hasResults) {
        return {
          llm: llmName,
          query: query,
          needs_search: false,
          ccp: 0,
          fanout_queries: [],
          cited_sources: [],
          source_diversity: [],
          message: "This LLM didn't perform web search for the said query.",
        };
      }
    }
    
    return result;
  } catch (err) {
    // Return error result instead of throwing
    return {
      llm: llmName,
      query: query,
      needs_search: null,
      ccp: null,
      fanout_queries: [],
      cited_sources: [],
      source_diversity: [],
      error: err.message || `${llmName} failed 🐱‍👤`,
    };
  }
}

/* =========================
   HELPER: Calculate Average CCP
========================= */

/**
 * Calculate average CCP from results, excluding failed LLMs.
 * Returns null if all LLMs failed.
 */
function calculateAverageCCP(results) {
  const validCCPs = Object.values(results)
    .filter(r => r.ccp !== null && r.ccp !== undefined && !r.error)
    .map(r => r.ccp);

  if (validCCPs.length === 0) return null;

  const sum = validCCPs.reduce((a, b) => a + b, 0);
  return Math.round(sum / validCCPs.length);
}

/* =========================
   MAIN HANDLER
========================= */

export default async function handler(req, res) {
  // Method check
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only 🐱" });
  }

  // API keys check
  const openaiKey = process.env.OPENAI_API_KEY;
  const googleKey = process.env.GOOGLE_API_KEY;
  const perplexityKey = process.env.PERPLEXITY_API_KEY;
  console.log("API KEYS CHECK:", !!openaiKey, !!googleKey, !!perplexityKey);

  const missingKeys = [];
  if (!openaiKey) missingKeys.push("OPENAI_API_KEY");
  if (!googleKey) missingKeys.push("GOOGLE_API_KEY");
  if (!perplexityKey) missingKeys.push("PERPLEXITY_API_KEY");

  if (missingKeys.length === 3) {
    return res.status(500).json({
      error: "All API keys missing 🙀",
      type: "CONFIG_ERROR",
    });
  }

  // Extract and validate query
  const { query } = req.body || {};
  const cleanedQuery = typeof query === "string" ? query.trim() : "";

  if (cleanedQuery.length < CONFIG.MIN_QUERY_LENGTH) {
    return res.status(400).json({
      error: `Query must be at least ${CONFIG.MIN_QUERY_LENGTH} characters`,
      type: "QUERY_TOO_SHORT",
    });
  }

  if (cleanedQuery.length > CONFIG.MAX_QUERY_LENGTH) {
    return res.status(400).json({
      error: `Query must be under ${CONFIG.MAX_QUERY_LENGTH} characters`,
      type: "QUERY_TOO_LONG",
    });
  }

  /* =========================
     CALL ALL 3 LLMS (Sequential)
  ========================= */

  const results = {};

  // 1. ChatGPT
  if (openaiKey) {
    results.chatgpt = await safeLLMCall("chatgpt", analyzeChatGPT, cleanedQuery, openaiKey);
  } else {
    results.chatgpt = {
      llm: "chatgpt",
      query: cleanedQuery,
      needs_search: null,
      ccp: null,
      fanout_queries: [],
      cited_sources: [],
      source_diversity: [],
      error: "OpenAI API key not configured 🔑",
    };
  }

  // 2. Gemini
  if (googleKey) {
    results.gemini = await safeLLMCall("gemini", analyzeGemini, cleanedQuery, googleKey);
  } else {
    results.gemini = {
      llm: "gemini",
      query: cleanedQuery,
      needs_search: null,
      ccp: null,
      fanout_queries: [],
      cited_sources: [],
      source_diversity: [],
      error: "Google API key not configured 🔑",
    };
  }

  // 3. Perplexity
  if (perplexityKey) {
    results.perplexity = await safeLLMCall("perplexity", analyzePerplexity, cleanedQuery, perplexityKey);
  } else {
    results.perplexity = {
      llm: "perplexity",
      query: cleanedQuery,
      needs_search: null,
      ccp: null,
      fanout_queries: [],
      cited_sources: [],
      source_diversity: [],
      error: "Perplexity API key not configured 🔑",
    };
  }

  /* =========================
     BUILD RESPONSE
  ========================= */

  const averageCCP = calculateAverageCCP(results);

  // Check if ALL failed
  const allFailed = Object.values(results).every(r => r.error);

  if (allFailed) {
    return res.status(500).json({
      error: "All LLMs failed 🙀 Try again in a moment.",
      type: "ALL_FAILED",
      query: cleanedQuery,
      chatgpt: results.chatgpt,
      gemini: results.gemini,
      perplexity: results.perplexity,
    });
  }

  // Success (even if partial)
  return res.status(200).json({
    query: cleanedQuery,
    average_ccp: averageCCP,
    chatgpt: results.chatgpt,
    gemini: results.gemini,
    perplexity: results.perplexity,
  });
}