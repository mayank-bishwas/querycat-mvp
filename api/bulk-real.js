// api/bulk-back.js
// V3.0 — Multi-LLM bulk query analysis endpoint
//
// The Kitchen Manager (Bulk Edition): Processes 2-5 queries across all 3 LLMs.
// Outputs a 15-column CSV with per-LLM breakdown.

import 'dotenv/config';


import { analyzeQuery as analyzeChatGPT, CONFIG } from "../lib/chatgpt.js";
import { analyzeQuery as analyzeGemini } from "../lib/gemini.js";
import { analyzeQuery as analyzePerplexity } from "../lib/perplexity.js";


/* =========================
   HELPERS
========================= */

/**
 * Get current date+time in IST, formatted as dd-mm-yyyy_hh:mm:ss
 */
function getISTTimestamp() {
  const now = new Date();
  
  const options = {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  };
  
  const formatter = new Intl.DateTimeFormat("en-GB", options);
  const parts = formatter.formatToParts(now);
  
  const get = (type) => parts.find(p => p.type === type)?.value || "00";
  
  const date = `${get("day")}-${get("month")}-${get("year")}`;
  const time = `${get("hour")}:${get("minute")}:${get("second")}`;
  
  return `${date}_${time}`;
}

/**
 * Escape a value for CSV (handles quotes, newlines)
 */
function csvEscape(value) {
  if (value == null) return '""';
  const str = String(value).replace(/"/g, '""');
  return `"${str}"`;
}

/**
 * Format source diversity for CSV cell
 */
function formatSourceDiversity(sourceDiversity) {
  if (!sourceDiversity || sourceDiversity.length === 0) {
    return "N/A";
  }

  const sorted = [...sourceDiversity].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.category.localeCompare(b.category);
  });

  return sorted
    .map((d, i) => `${i + 1}. ${d.category} (${d.count})`)
    .join("\n");
}

/**
 * Format fanout queries for CSV cell
 */
function formatFanoutQueries(fanoutQueries) {
  if (!fanoutQueries || fanoutQueries.length === 0) {
    return "N/A";
  }
  return fanoutQueries
    .map((q, i) => `${i + 1}. ${q}`)
    .join("\n");
}

/**
 * Format cited sources for CSV cell
 */
function formatCitedSources(citedSources) {
  if (!citedSources || citedSources.length === 0) {
    return "N/A";
  }
  return citedSources
    .map((url, i) => `${i + 1}. ${url}`)
    .join("\n");
}

/**
 * Call an LLM analyzer with error isolation.
 * If it fails, return an error result instead of throwing.
 * Also normalizes "empty search" results to no-search state.
 */
async function safeLLMCall(llmName, analyzerFn, query, apiKey) {
  if (!apiKey) {
    return {
      llm: llmName,
      query: query,
      needs_search: null,
      ccp: null,
      fanout_queries: [],
      cited_sources: [],
      source_diversity: [],
      error: `${llmName} API key not configured.`,
    };
  }

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
    return {
      llm: llmName,
      query: query,
      needs_search: null,
      ccp: null,
      fanout_queries: [],
      cited_sources: [],
      source_diversity: [],
      error: err.message || `${llmName} failed`,
    };
  }
}

/**
 * Format LLM result for CSV columns
 */
function formatLLMResult(result) {
  if (result.error) {
    return {
      ccp: "Error",
      fanout: result.error,
      sources: "N/A",
      diversity: "N/A",
    };
  }

  if (result.needs_search === false) {
    const noSearchMsg = "This LLM didn't perform web search for the said query.";
    return {
      ccp: "0",
      fanout: noSearchMsg,
      sources: noSearchMsg,
      diversity: noSearchMsg,
    };
  }

  return {
    ccp: `${result.ccp}`,
    fanout: formatFanoutQueries(result.fanout_queries),
    sources: formatCitedSources(result.cited_sources),
    diversity: formatSourceDiversity(result.source_diversity),
  };
}

/**
 * Calculate average CCP from array of results, excluding errors/nulls
 */
function calculateAverage(results) {
  const valid = results.filter(r => r.ccp !== null && !r.error);
  if (valid.length === 0) return null;
  const sum = valid.reduce((a, b) => a + b.ccp, 0);
  return Math.round(sum / valid.length);
}

/* =========================
   MAIN HANDLER
========================= */

export default async function handler(req, res) {
  // Method check
  if (req.method !== "POST") {
    return res.status(405).json({ error: "This cat listens to POST only 🐱" });
  }

  // API keys
  const openaiKey = process.env.OPENAI_API_KEY;
  const googleKey = process.env.GOOGLE_API_KEY;
  const perplexityKey = process.env.PERPLEXITY_API_KEY;

  // At least one key must exist
  if (!openaiKey && !googleKey && !perplexityKey) {
    return res.status(500).json({ 
      error: "All API keys missing 🙀",
      type: "CONFIG_ERROR"
    });
  }

  // Extract queries
  const { queries } = req.body || {};

  // Validate: must be array of 2-5 items
  if (!Array.isArray(queries) || queries.length < 2 || queries.length > 5) {
    return res.status(400).json({
      error: "Provide 2–5 queries only 🐾",
      type: "INVALID_QUERY_COUNT"
    });
  }

  // Validate each query length
  for (let i = 0; i < queries.length; i++) {
    const q = typeof queries[i] === "string" ? queries[i].trim() : "";
    if (q.length < CONFIG.MIN_QUERY_LENGTH || q.length > CONFIG.MAX_QUERY_LENGTH) {
      return res.status(400).json({
        error: `Query ${i + 1} must be ${CONFIG.MIN_QUERY_LENGTH}–${CONFIG.MAX_QUERY_LENGTH} characters`,
        type: "INVALID_QUERY_LENGTH"
      });
    }
  }

  /* =========================
     PROCESS QUERIES
  ========================= */
  const rows = [];
  const allChatGPT = [];
  const allGemini = [];
  const allPerplexity = [];

  for (let i = 0; i < queries.length; i++) {
    const query = String(queries[i]).trim();

    // Call all 3 LLMs sequentially
    const chatgpt = await safeLLMCall("chatgpt", analyzeChatGPT, query, openaiKey);
    const gemini = await safeLLMCall("gemini", analyzeGemini, query, googleKey);
    const perplexity = await safeLLMCall("perplexity", analyzePerplexity, query, perplexityKey);

    // Store for average calculation
    allChatGPT.push(chatgpt);
    allGemini.push(gemini);
    allPerplexity.push(perplexity);

    // Format each LLM's result
    const chatgptFmt = formatLLMResult(chatgpt);
    const geminiFmt = formatLLMResult(gemini);
    const perplexityFmt = formatLLMResult(perplexity);

    // Collect errors
    const errors = [];
    if (chatgpt.error) errors.push(`ChatGPT: ${chatgpt.error}`);
    if (gemini.error) errors.push(`Gemini: ${gemini.error}`);
    if (perplexity.error) errors.push(`Perplexity: ${perplexity.error}`);

    rows.push({
      index: i + 1,
      query: query,
      chatgpt_ccp: chatgptFmt.ccp,
      gemini_ccp: geminiFmt.ccp,
      perplexity_ccp: perplexityFmt.ccp,
      chatgpt_fanout: chatgptFmt.fanout,
      gemini_fanout: geminiFmt.fanout,
      perplexity_fanout: perplexityFmt.fanout,
      chatgpt_sources: chatgptFmt.sources,
      gemini_sources: geminiFmt.sources,
      perplexity_sources: perplexityFmt.sources,
      chatgpt_diversity: chatgptFmt.diversity,
      gemini_diversity: geminiFmt.diversity,
      perplexity_diversity: perplexityFmt.diversity,
      error: errors.length > 0 ? errors.join(" | ") : "N/A",
    });
  }

  /* =========================
     CALCULATE AVERAGES
  ========================= */
  const avgChatGPT = calculateAverage(allChatGPT);
  const avgGemini = calculateAverage(allGemini);
  const avgPerplexity = calculateAverage(allPerplexity);

  /* =========================
     BUILD CSV
  ========================= */
  const timestamp = getISTTimestamp();

  // Header row (15 columns)
  const header = [
    "#",
    "Input Query",
    "*ChatGPT_CS",
    "*Gemini_CS",
    "*Perplexity_CS",
    "ChatGPT_Fanout Queries",
    "Gemini_Fanout Queries",
    "Perplexity_Fanout Queries",
    "ChatGPT_Cited Sources",
    "Gemini_Cited Sources",
    "Perplexity_Cited Sources",
    "ChatGPT_Source Diversity",
    "Gemini_Source Diversity",
    "Perplexity_Source Diversity",
    "Error (if any)"
  ];

  const csvLines = [];
  csvLines.push(header.map(csvEscape).join(","));

  // Data rows
  rows.forEach(r => {
    csvLines.push([
      r.index,
      r.query,
      r.chatgpt_ccp,
      r.gemini_ccp,
      r.perplexity_ccp,
      r.chatgpt_fanout,
      r.gemini_fanout,
      r.perplexity_fanout,
      r.chatgpt_sources,
      r.gemini_sources,
      r.perplexity_sources,
      r.chatgpt_diversity,
      r.gemini_diversity,
      r.perplexity_diversity,
      r.error
    ].map(csvEscape).join(","));
  });

  // Average row
  csvLines.push([
    "",
    "Average",
    avgChatGPT !== null ? `${avgChatGPT}` : "N/A",
    avgGemini !== null ? `${avgGemini}` : "N/A",
    avgPerplexity !== null ? `${avgPerplexity}` : "N/A",
    "", "", "", "", "", "", "", "", "", ""
  ].map(csvEscape).join(","));

  // Empty row before footer
  csvLines.push("");

  // Footer row 1: CP definition
  const cpDefinition = `CS = Citation Signal
Shows to what degree an LLM relies on external sources for answer.
*based on observed LLM behavior; Not an official LLM metric.`;

  csvLines.push([
    "",
    csvEscape(cpDefinition),
    "", "", "", "", "", "", "", "", "", "", "", "", ""
  ].join(","));

  // Footer row 2: Generated by
  csvLines.push([
    "",
    csvEscape(`Generated with ♡ by QueryCat.app on ${timestamp}`),
    "", "", "", "", "", "", "", "", "", "", "", "", ""
  ].join(","));

  const csv = csvLines.join("\n");

  /* =========================
     SEND RESPONSE
  ========================= */
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="QueryCat_bulk_${timestamp}.csv"`
  );

  return res.status(200).send(csv);
}