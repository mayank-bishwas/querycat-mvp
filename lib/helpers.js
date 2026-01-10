// lib/helpers.js
// V2.0 — Helper for fanout_queries generation (ChatGPT & Perplexity)
//
// Uses GPT-4o-mini to extract clean fanout queries from sources.
// Fanout count is now DYNAMIC based on URL count:
//   - URLs ≤ 5 → fanouts = URLs
//   - URLs > 5 → fanouts = 5 + floor((URLs - 5) / 2)
//   - Min: 2, Max: 8
//
// Cost: ~$0.001 per call

import 'dotenv/config';

/**
 * Calculate dynamic fanout count based on URL count
 * @param {number} urlCount - Number of URLs fetched
 * @returns {number} Target fanout count
 */
function calculateFanoutCount(urlCount) {
  if (urlCount <= 1) return 2; // Minimum 2 fanouts
  if (urlCount <= 5) return urlCount;
  
  // For URLs > 5: base 5 + 1 for every 2 additional URLs
  const extra = Math.floor((urlCount - 5) / 2);
  return Math.min(5 + extra, 8); // Cap at 8
}

/**
 * Generate clean fanout queries using GPT-4o-mini
 * Used by ChatGPT and Perplexity (NOT Gemini - it has its own)
 * 
 * @param {string} originalQuery - The user's original query
 * @param {Array} sources - Array of {url, title, domain} objects
 * @returns {Promise<string[]>} Array of fanout query strings
 */
export async function cleanFanoutQueries(originalQuery, sources) {
  const apiKey = process.env.OPENAI_API_KEY;
  
  console.log('[cleanFanoutQueries] API key exists:', !!apiKey);
  console.log('[cleanFanoutQueries] Sources count:', sources?.length || 0);
  
  if (!apiKey) {
    console.error('[cleanFanoutQueries] No API key - returning original query');
    return [originalQuery];
  }
  
  if (!sources || sources.length === 0) {
    console.error('[cleanFanoutQueries] No sources - returning original query');
    return [originalQuery];
  }

  // Calculate dynamic fanout count based on URL count
  const urlCount = sources.length;
  const fanoutCount = calculateFanoutCount(urlCount);
  
  console.log('[cleanFanoutQueries] URL count:', urlCount, '→ Target fanout count:', fanoutCount);

  // Show more sources for better context (up to 12)
  const sourceList = sources
    .slice(0, 12)
    .map((s, i) => `${i + 1}. ${s.title || ''} - ${s.url || ''}`)
    .join('\n');

  console.log('[cleanFanoutQueries] Source list:\n', sourceList);

  const prompt = `Given a user searched: "${originalQuery}"

And these ${urlCount} sources were cited:
${sourceList}

Extract exactly ${fanoutCount} realistic search queries that would lead to these sources.
Return ONLY a JSON array of strings, nothing else. No markdown, no code blocks.
Example: ["query one", "query two", "query three"]`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 300, // Increased for more fanouts
        temperature: 0.3,
      }),
    });

    const data = await response.json();
    console.log('[cleanFanoutQueries] API response:', JSON.stringify(data).slice(0, 200));
    
    const content = data.choices?.[0]?.message?.content?.trim();
    
    if (!content) {
      console.error('[cleanFanoutQueries] No content in response');
      return [originalQuery];
    }
    
    // Strip markdown code blocks if present
    let jsonStr = content;
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/i, '');
    }
    
    console.log('[cleanFanoutQueries] Cleaned JSON:', jsonStr);
    
    const queries = JSON.parse(jsonStr);
    
    if (Array.isArray(queries) && queries.length > 0) {
      console.log('[cleanFanoutQueries] Success! Queries:', queries);
      // Return exactly the target count (or all if less)
      return queries.slice(0, fanoutCount);
    }
    
    console.error('[cleanFanoutQueries] Invalid queries format');
    return [originalQuery];
  } catch (err) {
    console.error('[cleanFanoutQueries] Error:', err.message);
    return [originalQuery];
  }
}
