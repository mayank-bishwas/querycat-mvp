// js/bulk.js
// Frontend wiring for CKR — Bulk Queries
// Handles validation, UI states, API call, CSV download
// IMPORTANT: Input errors and API errors are handled separately

document.addEventListener("DOMContentLoaded", () => {
  /* =========================
     ELEMENTS
  ========================= */
  const textarea = document.getElementById("bulkQueryInput");
  const actionBtn = document.getElementById("actionBtnTop");
  const inputError = document.getElementById("inputError");
  const downloadAgainLink = document.getElementById("downloadAgain");
  
  const queryBox = document.querySelector(".query-box");
queryBox.addEventListener("click", (e) => {
  if (document.activeElement !== queryInput) {
    queryInput.focus();
  }
});
  
  const wrapper = document.querySelector(".bulk-input-wrapper");

  /* =========================
     STATE
  ========================= */
  let lastCsvUrl = null;
  let lastFilename = null;

  /* =========================
     WRAPPER STATE HELPERS
     (Overlay states ONLY)
  ========================= */
  function setWrapperState(state) {
    wrapper.classList.remove(
      "state-default",
      "state-processing",
      "state-done",
      "state-error"
    );
    wrapper.classList.add(state);
  }

  /* =========================
     INPUT ERROR (Frontend only)
     - No overlay
     - Input stays editable
  ========================= */
  function showInputError(msg) {
    inputError.textContent = msg;
  }

  function clearInputError() {
    inputError.textContent = "";
  }

  /* =========================
     API ERROR (Backend failure)
     - Overlay + error cat
     - Reset-only flow
  ========================= */
  function showApiError(msg) {
    clearInputError();              // Inline error not relevant here
    setWrapperState("state-error"); // Triggers overlay + error cat
  }

  /* =========================
     PROCESSING STATE
  ========================= */
  function setProcessing() {
    textarea.disabled = true;
    actionBtn.disabled = true;
    actionBtn.textContent = "Analyzing…";
    setWrapperState("state-processing");
  }

  /* =========================
     DONE STATE
  ========================= */
  function setDone() {
    setWrapperState("state-done");
    actionBtn.textContent = "Reset";
    actionBtn.disabled = false;
  }

  /* =========================
     RESET UI
  ========================= */
  function resetUI() {
    textarea.value = "";
    textarea.disabled = false;
    textarea.focus();

    actionBtn.textContent = "Analyze All Queries";
    actionBtn.disabled = false;

    clearInputError();
    setWrapperState("state-default");

    // Clean up CSV blob memory
    if (lastCsvUrl) {
      URL.revokeObjectURL(lastCsvUrl);
      lastCsvUrl = null;
      lastFilename = null;
    }
  }

  /* =========================
     PARSE INPUT
  ========================= */
  function parseQueries() {
    return textarea.value
      .split("\n")
      .map(q => q.trim())
      .filter(Boolean);
  }

  /* =========================
     MAIN ACTION
  ========================= */
  async function analyzeBulk() {
    clearInputError();

    const queries = parseQueries();

    /* ---- Frontend validation ---- */

    if (queries.length < 2 || queries.length > 5) {
      showInputError("Give me 2–5 queries — no more, no less. Cats count carefully 🐾");
      return;
    }

    for (const q of queries) {
      if (q.length < 4 || q.length > 100) {
        showInputError("Each query must be 4–100 chars. Tiny mice or giant lions not allowed 😾");
        return;
      }
    }

    /* ---- Valid input: start processing ---- */
    setProcessing();

    try {
      const res = await fetch("/api/bulk-real", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ queries })
      });

      if (!res.ok) {
        // Backend responded but failed
        const err = await res.json();
        throw new Error(err.error || "Bulk processing failed");
      }

      /* ---- Get CSV ---- */
      const blob = await res.blob();
      lastCsvUrl = URL.createObjectURL(blob);

      // Extract filename from response header
      const disposition = res.headers.get("Content-Disposition") || "";
      const match = disposition.match(/filename="(.+)"/);
      lastFilename = match ? match[1] : "chatgptkwr_bulk.csv";

      /* ---- Auto-download once ---- */
      const a = document.createElement("a");
      a.href = lastCsvUrl;
      a.download = lastFilename;
      document.body.appendChild(a);
      a.click();
      a.remove();

      setDone();

    } catch (err) {
      // ONLY backend / network failures land here
      showApiError(err.message || "Something went wrong. Please 'Reset' and try again.");
      actionBtn.textContent = "Reset";
      actionBtn.disabled = false;
    }
  }

  /* =========================
     EVENTS
  ========================= */
  actionBtn.addEventListener("click", () => {
    if (actionBtn.textContent === "Reset") {
      resetUI();
    } else {
      analyzeBulk();
    }
  });

  /* =========================
     DOWNLOAD AGAIN
  ========================= */
  if (downloadAgainLink) {
    downloadAgainLink.addEventListener("click", e => {
      e.preventDefault();
      if (!lastCsvUrl || !lastFilename) return;

      const a = document.createElement("a");
      a.href = lastCsvUrl;
      a.download = lastFilename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
  }
});
