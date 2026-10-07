// Sidebar "Top Gainers" list and its period dropdown.
import { el, currentMonth } from "./dom.js";
import { state, subscribe, notify } from "./state.js";
import { apiFetch, endpoints } from "./api.js";
import { renderLabels } from "./labels.js";
import { loadPlayerProfile, scrollToPlayerProfile } from "./playerProfile.js";
import { addToComparison, isInComparison } from "./comparisonSelection.js";
import { selectedPeriod, currentYear, formatMonth, formatShortMonth } from "./period.js";

/** The current game's months, keyed by "YYYY-MM". */
let months = new Map();

/** Reflect comparison membership on a hover-revealed add button. */
function setAddedState(btn, added) {
  btn.classList.toggle("added", added);
  btn.textContent = added ? "✓" : "+";
  btn.title = added ? "In comparison chart" : "Add to comparison chart";
}

/** Re-sync every add button to current comparison membership. */
function syncTopGainersButtons() {
  document.querySelectorAll("#topGainers .add-to-comparison-btn").forEach((btn) => {
    setAddedState(btn, isInComparison(btn.dataset.ign));
  });
}

// Keep the buttons in sync whenever the comparison changes (add/remove/reset).
document.addEventListener("comparison:rendered", syncTopGainersButtons);

subscribe(["game"], async () => {
  const { month } = selectedPeriod();

  if (!month) {
    return Promise.all([loadMonths(), loadTopGainers()]);
  }

  await loadMonths();

  // Switch to the last 30 days when the selected month isn't available for this game.
  if (!months.has(month)) {
    return selectPeriod("30");
  }
  return loadTopGainers();
});

subscribe(["topGainersPeriod"], loadTopGainers);

el("topGainersPeriod").onchange = (e) => selectPeriod(e.target.value);
renderPeriodOptions();

function selectPeriod(period) {
  state.topGainersPeriod = period;
  el("topGainersPeriod").value = period;
  return notify("topGainersPeriod");
}

async function loadMonths() {
  const gameId = state.currentGame.id;

  try {
    const list = await apiFetch(endpoints.topGainerMonths(gameId));
    if (gameId !== state.currentGame?.id) return;
    months = new Map(list.map((m) => [m.month, m]));
  } catch (err) {
    console.error("Failed to load top gainer months", err);
    months = new Map();
  }

  renderPeriodOptions();
}

function renderPeriodOptions() {
  const thisMonth = currentMonth();
  const past = [...months.values()].filter((m) => m.month !== thisMonth);

  const select = el("topGainersPeriod");
  select.replaceChildren(
    new Option("Last 7 days", "7"),
    new Option("Last 30 days", "30"),
    new Option("This month", thisMonth),
    new Option("This year", currentYear())
  );

  if (past.length) {
    const group = document.createElement("optgroup");
    group.label = "Past months";
    for (const m of past) {
      group.appendChild(new Option(formatMonth(m.month), m.month));
    }
    select.appendChild(group);
  }

  select.value = state.topGainersPeriod;
}

export async function loadTopGainers() {
  const container = el("topGainers");
  const gameId = state.currentGame.id;
  const period = state.topGainersPeriod;
  const selected = selectedPeriod();

  renderNote(selected.month ? months.get(selected.month) : null);

  try {
    const topGainers = await apiFetch(endpoints.topGainers(gameId, selected));
    // Ignore the response if the game or period changed while it loaded.
    if (gameId !== state.currentGame?.id || period !== state.topGainersPeriod) return;
    renderTopGainers(topGainers);
  } catch (err) {
    container.innerHTML =
      '<div class="text-muted centered-p error-text" style="padding: 1.5rem;">Failed to load data</div>';
  }
}

function renderNote(monthInfo) {
  const note = el("topGainersNote");

  if (monthInfo?.partial) {
    note.textContent = `Only tracked ${monthInfo.firstDay}–${monthInfo.lastDay} ${formatShortMonth(monthInfo.month)}`;
    note.hidden = false;
  } else {
    note.hidden = true;
  }
}

function renderTopGainers(data) {
  const container = el("topGainers");

  if (!data?.length) {
    container.innerHTML =
      '<div class="text-muted centered-p" style="padding: 2rem;">No data</div>';
    return;
  }

  const header = document.createElement("div");
  header.className = "tg-header";
  header.innerHTML = `
    <span>#</span>
    <span>Player</span>
    <span data-label="scoreType">Wins</span>
  `;

  const list = document.createElement("ol");
  list.className = "tg-list";

  data.forEach((row, i) => {
    const item = document.createElement("li");
    item.className = "tg-row";
    // The rank cell doubles as the add-to-comparison control: the number shows
    // by default and is replaced by a "+" on row hover.
    item.innerHTML = `
      <div class="tg-rank">
        <span class="rank-number">${i + 1}.</span>
        <button type="button" class="add-to-comparison-btn"
          title="Add to comparison chart"
          aria-label="Add ${row.ign} to comparison chart">+</button>
      </div>
      <div class="player-ign-cell">${row.ign}</div>
      <div>
        <span class="badge">+${row.score_gain.toLocaleString()}</span>
      </div>
    `;

    const addBtn = item.querySelector(".add-to-comparison-btn");
    addBtn.dataset.ign = row.ign;
    setAddedState(addBtn, isInComparison(row.ign));
    addBtn.onclick = (e) => {
      e.stopPropagation(); // don't open the player profile
      addToComparison({ uuid: row.player, ign: row.ign });
      setAddedState(addBtn, true); // snappy; the render event re-syncs all rows
    };

    item.onclick = () => {
      if (state.currentPlayer && state.currentPlayer.id === row.player) return;
      loadPlayerProfile(row.player);
      scrollToPlayerProfile();
    };

    list.appendChild(item);
  });

  container.replaceChildren(header, list);
  renderLabels(header);
}
