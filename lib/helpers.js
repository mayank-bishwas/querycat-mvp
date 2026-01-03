import 'dotenv/config';

/**
 * Helper for fanout_queries of ChatGPT and Perplexity
 * Use GPT-4o-mini to extract clean fanout queries from sources
 * Cost: ~$0.001 per call
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

  const sourceList = sources
    .slice(0, 6)
    .map((s, i) => `${i + 1}. ${s.title || ''} - ${s.url || ''}`)
    .join('\n');

  console.log('[cleanFanoutQueries] Source list:\n', sourceList);

  const prompt = `Given a user searched: "${originalQuery}"

And these sources were cited:
${sourceList}

Extract 3-5 realistic search queries that would lead to these sources. 
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
        max_tokens: 200,
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
      return queries.slice(0, 6);
    }
    
    console.error('[cleanFanoutQueries] Invalid queries format');
    return [originalQuery];
  } catch (err) {
    console.error('[cleanFanoutQueries] Error:', err.message);
    return [originalQuery];
  }
}