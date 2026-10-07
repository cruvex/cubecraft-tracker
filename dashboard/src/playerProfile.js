// Player profile panel: search/select a player, fetch their scores, render
// stats + the score-over-time chart.
import { el, formatUuid } from "./dom.js";
import { state, subscribe } from "./state.js";
import { apiFetch, endpoints } from "./api.js";
import { updatePath } from "./router.js";
import { renderPlayerChart, destroyPlayerChart } from "./charts/playerChart.js";
import { addToComparison, isInComparison } from "./comparisonSelection.js";
import { selectedPeriod, periodLabel, monthStart } from "./period.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Reflect whether the displayed player is already on the comparison chart.
 * @param {{ uuid: string, ign: string }} player
 */
function syncAddToComparisonBtn(player) {
  const btn = el("addToComparisonBtn");
  if (!btn) return;
  const added = isInComparison(player.ign);
  btn.textContent = added ? "✓ In comparison" : "+ Add to comparison";
  btn.classList.toggle("added", added);
  btn.onclick = () => {
    addToComparison(player);
    syncAddToComparisonBtn(player);
  };
}

// Keep the profile button in sync when the comparison changes elsewhere
// (e.g. reset/clear, or removing the player via a chip).
document.addEventListener("comparison:rendered", () => {
  const cp = state.currentPlayer;
  if (cp?.ign && el("playerProfile").style.display !== "none") {
    syncAddToComparisonBtn({ uuid: cp.id, ign: cp.ign });
  }
});

// A game change invalidates the profile's data (app.js clears it), so refetch.
subscribe(["game"], () => {
  if (state.currentPlayer) return loadPlayerProfile(state.currentPlayer.ign, true);
});

subscribe(["topGainersPeriod"], () => {
  if (state.currentPlayer) return loadPlayerProfile(state.currentPlayer.ign);
});

export function scrollToPlayerProfile() {
  if (window.innerWidth <= 900) {
    document.querySelector("main").scrollIntoView({ behavior: "smooth" });
  } else {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
}

export async function loadPlayerProfile(idOrIgn, forceFetch = false) {
  if (!idOrIgn) return;

  const scoreType = state.currentGame?.scoreType || "Wins";
  const cp = state.currentPlayer;
  const period = state.topGainersPeriod;

  const isCached =
    cp &&
    (cp.id === idOrIgn || cp.ign === idOrIgn) &&
    cp.data &&
    cp.period === period;

  if (!forceFetch && isCached) {
    renderPlayerProfile(cp.data, scoreType);
    return;
  }

  const gameId = state.currentGame.id;

  try {
    const scoreData = await apiFetch(endpoints.playerScores(gameId, idOrIgn, selectedPeriod()));
    // Ignore the response if the game or period changed while it loaded.
    if (gameId !== state.currentGame?.id || period !== state.topGainersPeriod) return;
    state.currentPlayer = { id: scoreData.player, ign: scoreData.ign, period, data: scoreData };

    updatePath();
    renderPlayerProfile(scoreData, scoreType);
  } catch (err) {
    console.error(err);
    el("playerProfile").style.display = "none";
    el("errorState").style.display = "block";
    el("errorTitle").innerText = "Player Not Found";
    el("errorMessage").innerText = `Player '${idOrIgn}' is not on the ${
      state.currentGame?.displayName || "selected game"
    } leaderboard.`;
  } finally {
    el("chartLoading").style.display = "none";
  }
}

export function renderPlayerProfile(scoreData, scoreType) {
  el("emptyState").style.display = "none";
  el("errorState").style.display = "none";
  el("playerProfile").style.display = "block";

  el("displayIgn").innerText = scoreData.ign;
  el("displayUuid").innerText = formatUuid(scoreData.player);
  syncAddToComparisonBtn({ uuid: scoreData.player, ign: scoreData.ign });

  const setGainEl = (id, value, showPlus) => {
    const elem = el(id);
    elem.innerText = (showPlus && value > 0 ? "+" : "") + value.toLocaleString();
    elem.classList.remove("text-positive", "text-negative");
    if (value > 0) elem.classList.add("text-positive");
    else if (value < 0) elem.classList.add("text-negative");
  };

  const { rows, current } = scoreData;

  el("displayGainPeriod").innerText = periodLabel();
  setGainEl("displayGain", periodGain(scoreData), true);

  if (!current) {
    el("displayCurrentScore").innerText = "No data";
  } else if (state.displayMode === "wins") {
    el("displayCurrentScore").innerText = current.score.toLocaleString();
  } else {
    el("displayCurrentScore").innerText = "#" + current.position.toLocaleString();
  }

  const emptyEl = el("chartEmpty");
  if (rows.length) {
    emptyEl.style.display = "none";
    renderPlayerChart(rows, scoreType, chartRange(rows));
  } else {
    emptyEl.textContent = scoreData.period ? `No data for ${periodLabel()}` : "No data";
    emptyEl.style.display = "flex";
    destroyPlayerChart();
  }
}

/** Wins gained, or positions climbed (#10 to #5 is +5), over the loaded period. */
function periodGain(scoreData) {
  if (state.displayMode === "wins") return scoreData.gain;

  const { rows } = scoreData;
  if (rows.length < 2) return 0;
  return rows[0].position - rows[rows.length - 1].position;
}

/** The chart's x-axis span, in epoch ms, for the selected period. */
function chartRange(rows) {
  const now = Date.now();
  const { days, month, year } = selectedPeriod();

  if (days) {
    return { min: now - days * DAY_MS, max: now };
  }

  const start = year ? new Date(`${year}-01-01T00:00:00Z`) : monthStart(month);
  const end = new Date(start);
  if (year) end.setUTCFullYear(end.getUTCFullYear() + 1);
  else end.setUTCMonth(end.getUTCMonth() + 1);
  const firstReading = new Date(rows[0].timestamp);

  return {
    // Starts at the carry reading when it is before the period's start.
    min: Math.min(start.getTime(), firstReading.getTime()),
    // The current period ends now.
    max: Math.min(end.getTime(), now),
  };
}
