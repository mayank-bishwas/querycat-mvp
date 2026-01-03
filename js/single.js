// js/single.js
// V3.0 — Multi-LLM frontend for QueryCat
// Renders results from ChatGPT, Gemini, and Perplexity in 3 columns

document.addEventListener("DOMContentLoaded", () => {

  /* =========================
     ELEMENTS
  ========================= */
  const queryInput = document.getElementById("queryInput");
  const actionBtn = document.getElementById("actionBtnTop");
  const inputError = document.getElementById("inputError");

  const resultsSection = document.getElementById("singleResultsSection");

  const resetBtn = document.getElementById("resetBtn");
  const screenshotBtn = document.getElementById("screenshotBtn");

  // Header elements
  const ccpPercentEl = document.getElementById("ccpPercent");
  const ccpQueryTextEl = document.getElementById("ccpQueryText");

  // Individual LLM CCP elements
  const chatgptCCPEl = document.getElementById("chatgptCCP");
  const geminiCCPEl = document.getElementById("geminiCCP");
  const perplexityCCPEl = document.getElementById("perplexityCCP");

  // Fanout lists (Row 1)
  const chatgptFanoutList = document.getElementById("chatgptFanoutList");
  const geminiFanoutList = document.getElementById("geminiFanoutList");
  const perplexityFanoutList = document.getElementById("perplexityFanoutList");

  // Sources lists (Row 2)
  const chatgptSourcesList = document.getElementById("chatgptSourcesList");
  const geminiSourcesList = document.getElementById("geminiSourcesList");
  const perplexitySourcesList = document.getElementById("perplexitySourcesList");

  // Diversity lists (Row 3)
  const chatgptDiversityList = document.getElementById("chatgptDiversityList");
  const geminiDiversityList = document.getElementById("geminiDiversityList");
  const perplexityDiversityList = document.getElementById("perplexityDiversityList");

  const copyButtons = document.querySelectorAll(".copy-btn");

  let isResultShown = false;

  /* =========================
     HELPERS
  ========================= */
  function showError(msg) {
    inputError.textContent = msg;
  }

  function clearError() {
    inputError.textContent = "";
  }

  function clearList(el) {
    if (el) el.innerHTML = "";
  }

  function renderList(el, items) {
    if (!el) return;
    clearList(el);
    items.forEach(text => {
      const li = document.createElement("li");
      li.textContent = text;
      el.appendChild(li);
    });
  }

  function renderSourcesList(el, urls) {
    if (!el) return;
    clearList(el);
    urls.forEach(url => {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = url;
      a.textContent = url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      li.appendChild(a);
      el.appendChild(li);
    });
  }

  function setLoading(isLoading) {
    actionBtn.disabled = isLoading;
    if (isLoading || !isResultShown) {
      actionBtn.textContent = isLoading ? "Analyzing…" : "Analyze Query";
    }
  }

  function showResults() {
    resultsSection.style.display = "block";
    resultsSection.scrollIntoView({ behavior: "smooth" });
  }

  function hideResults() {
    resultsSection.style.display = "none";
  }

  function switchToResetMode() {
    isResultShown = true;
    queryInput.disabled = true;
    actionBtn.textContent = "Reset";
    actionBtn.disabled = false;
    resetBtn.style.display = "flex";
  }

  function resetUI() {
    queryInput.value = "";
    queryInput.disabled = false;
    queryInput.focus();

    clearError();
    hideResults();

    // Reset header
    ccpPercentEl.textContent = "--";
    ccpQueryTextEl.textContent = "\"your query will appear here\"";

    // Reset LLM CCPs
    chatgptCCPEl.textContent = "--";
    geminiCCPEl.textContent = "--";
    perplexityCCPEl.textContent = "--";

    // Clear all lists
    clearList(chatgptFanoutList);
    clearList(geminiFanoutList);
    clearList(perplexityFanoutList);
    clearList(chatgptSourcesList);
    clearList(geminiSourcesList);
    clearList(perplexitySourcesList);
    clearList(chatgptDiversityList);
    clearList(geminiDiversityList);
    clearList(perplexityDiversityList);

    actionBtn.textContent = "Analyze Query";
    actionBtn.disabled = false;

    resetBtn.style.display = "none";
    isResultShown = false;
  }

  /* =========================
     RENDER LLM RESULT
  ========================= */
  function renderLLMResult(llmData, elements) {
    const { ccpEl, fanoutEl, sourcesEl, diversityEl } = elements;

    // Handle error state
    if (llmData.error) {
      ccpEl.textContent = "Error";
      renderList(fanoutEl, [llmData.error]);
      renderList(sourcesEl, ["—"]);
      renderList(diversityEl, ["—"]);
      return;
    }

    // Handle no-search state (answered from memory)
    if (llmData.needs_search === false) {
      const msg = llmData.message || "This LLM didn't perform web search for the said query.";
      ccpEl.textContent = "0";
      renderList(fanoutEl, [msg]);
      renderList(sourcesEl, [msg]);
      renderList(diversityEl, [msg]);
      return;
    }

    // Normal result
  ccpEl.textContent = `${llmData.ccp}`;

  // Fanout queries
  const fanouts = llmData.fanout_queries || [];
  renderList(fanoutEl, fanouts.length > 0 ? fanouts : ["This LLM didn't perform web search for the said query."]);

  // Cited sources (as clickable links)
  const sources = llmData.cited_sources || [];
  if (sources.length > 0) {
    renderSourcesList(sourcesEl, sources);
  } else {
    renderList(sourcesEl, ["This LLM didn't perform web search for the said query."]);
  }

  // Source diversity
  const diversity = (llmData.source_diversity || []).map(
    d => `${d.category} (${d.count})`
  );
  renderList(diversityEl, diversity.length > 0 ? diversity : ["—"]);
}

  /* =========================
     MAIN ACTION
  ========================= */
  async function analyzeQuery() {
    const query = queryInput.value.trim();

    if (!query) {
      showError("Type something, please. Be a curious cat 🐱");
      return;
    }

    if (query.length < 4 || query.length > 100) {
      showError("Keep it 4–100 chars. Cats count carefully 😼");
      return;
    }

    clearError();
    setLoading(true);

    try {
      const res = await fetch("/api/single-real", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query })
      });

      const data = await res.json();

      if (!res.ok) {
        showError(data.error || "Something went wrong 🐈‍⬛. Refresh and try again.");
        setLoading(false);
        return;
      }

      // Set query text
      ccpQueryTextEl.textContent = `"${data.query}"`;

      // Set average CCP
      if (data.average_ccp !== null) {
          ccpPercentEl.textContent = `${data.average_ccp}`;
        } else {
          ccpPercentEl.textContent = "--";
        }

      // Render ChatGPT results
      renderLLMResult(data.chatgpt, {
        ccpEl: chatgptCCPEl,
        fanoutEl: chatgptFanoutList,
        sourcesEl: chatgptSourcesList,
        diversityEl: chatgptDiversityList
      });

      // Render Gemini results
      renderLLMResult(data.gemini, {
        ccpEl: geminiCCPEl,
        fanoutEl: geminiFanoutList,
        sourcesEl: geminiSourcesList,
        diversityEl: geminiDiversityList
      });

      // Render Perplexity results
      renderLLMResult(data.perplexity, {
        ccpEl: perplexityCCPEl,
        fanoutEl: perplexityFanoutList,
        sourcesEl: perplexitySourcesList,
        diversityEl: perplexityDiversityList
      });

      showResults();
      switchToResetMode();

    } catch (err) {
      showError("Cat lost its way. 'Reset' and retry 🐈");
    } finally {
      setLoading(false);
    }
  }

  /* =========================
     SCREENSHOT
  ========================= */
  screenshotBtn.addEventListener("click", async () => {
    resultsSection.classList.add("screenshot-mode");

    // Small delay to let styles apply
    await new Promise(r => setTimeout(r, 50));

    try {
      const dataUrl = await domtoimage.toPng(resultsSection, {
        bgcolor: "#121212",
        scale: 2
      });
      
      const link = document.createElement("a");
      link.download = "QueryCat_result.png";
      link.href = dataUrl;
      link.click();
      
      showToast("Screenshot saved 📸");
    } catch (err) {
      console.error("Screenshot failed:", err);
      showToast("Screenshot failed 😿");
    }

    resultsSection.classList.remove("screenshot-mode");
  });

  function showToast(text) {
    const toast = document.createElement("div");
    toast.textContent = text;
    toast.style.cssText = `
      position: fixed;
      bottom: 64px;
      left: 50%;
      transform: translateX(-50%);
      background: #121212;
      color: #fefefe;
      padding: 10px 24px;
      border-radius: 12px;
      font-size: 20px;
      box-shadow: 0 4px 14px rgba(104, 127, 60, 0.15);
      z-index: 9999;
      transition: opacity 0.5s ease;
    `;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  }

  /* =========================
     EVENTS
  ========================= */
  actionBtn.addEventListener("click", () => {
    isResultShown ? resetUI() : analyzeQuery();
  });

  queryInput.addEventListener("keydown", e => {
    if (e.key === "Enter" && !isResultShown) {
      analyzeQuery();
    }
  });

  resetBtn.addEventListener("click", resetUI);

  // Copy buttons — now works with all 9 lists
  copyButtons.forEach(btn => {
    btn.addEventListener("click", async () => {
      const target = document.getElementById(btn.dataset.target);
      if (!target) return;

      const text = [...target.querySelectorAll("li")]
      .map((li, index) => `${index + 1}. ${li.textContent}`)
      .join("\n");

      await navigator.clipboard.writeText(text);
      btn.classList.add("copied");
      setTimeout(() => btn.classList.remove("copied"), 400);
    });
  });

});