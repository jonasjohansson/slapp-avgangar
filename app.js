/* ---- Config ---- */

const EMPTY_LINE = { lineId: null, lineName: null, color: '#555', url: null, from: null };

const MAX_LINES = 6;

const DEFAULT_LINES = [
  { ...EMPTY_LINE },
];

const DEFAULT_ROUTE = {
  origin: '',
  destination: '',
};

function loadConfig() {
  try {
    const raw = localStorage.getItem('slapp-config');
    if (raw) return JSON.parse(raw);
  } catch (e) { /* ignore */ }
  return { lines: DEFAULT_LINES, route: DEFAULT_ROUTE };
}

function saveConfig(cfg) {
  localStorage.setItem('slapp-config', JSON.stringify(cfg));
}

let config = loadConfig();

const JP_BASE = 'https://journeyplanner.integration.sl.se/v2';

const API_BASE = 'https://transport.integration.sl.se/v1/sites';
const MAX_DEPARTURES = 6;
const MAX_MINUTES = 60;
const REFRESH_INTERVAL = 30000;

const departuresEl = document.getElementById('departures');
const routeCardEl = document.getElementById('route-card');
const updatedEl = document.getElementById('updated');

let allSLLines = null; // fetched once on load

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function pad(n) { return String(n).padStart(2, '0'); }

/* ---- Fetch all SL lines (once) ---- */

async function fetchAllLines() {
  try {
    const res = await fetch('https://transport.integration.sl.se/v1/lines?transport_authority_id=1');
    if (!res.ok) return;
    const data = await res.json();
    // API returns { metro: [...], tram: [...], bus: [...], ... } — flatten into one array
    const modeMap = { metro: 'METRO', tram: 'TRAM', bus: 'BUS', ship: 'SHIP', train: 'TRAIN' };
    const lines = [];
    for (const [key, arr] of Object.entries(data)) {
      if (!Array.isArray(arr)) continue;
      const mode = modeMap[key] || key.toUpperCase();
      for (const line of arr) {
        lines.push({ ...line, transport_mode: line.transport_mode || mode });
      }
    }
    allSLLines = lines;
  } catch (e) {
    console.error('Failed to fetch SL lines:', e);
  }
}

const TRANSPORT_MODE_COLORS = {
  BUS: '#1e6bc9',
  METRO: '#e32d22',
  TRAM: '#7b4fa0',
  SHIP: '#00a4b7',
  TRAIN: '#f47d30',
};

/* ---- Journey Planner API ---- */

async function fetchTrips() {
  const { origin, destination } = config.route;
  if (!origin || !destination) return [];

  const params = new URLSearchParams({
    type_origin: 'any',
    name_origin: origin,
    type_destination: 'any',
    name_destination: destination,
    calc_number_of_trips: '3',
  });

  const res = await fetch(`${JP_BASE}/trips?${params}`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.journeys || [];
}

function fmtTime(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const PRODUCT_ICONS = {
  'Tunnelbana': '🚇',
  'Spårvagn': '🚃',
  'Buss': '🚌',
  'Pendelbåt': '⛴',
  'footpath': '🚶',
};

function getProductColor(transportation) {
  const name = (transportation?.name || '').toLowerCase();
  if (name.includes('röda linje')) return '#e32d22';
  if (name.includes('blå linje')) return '#0d6eb8';
  if (name.includes('gröna linje')) return '#4ca85b';
  if (name.includes('spårvagn')) return '#7b4fa0';
  if (name.includes('pendelbåt')) return '#00a4b7';
  return '#1e6bc9'; // default bus blue
}

function renderTrip(journey) {
  const legs = journey.legs || [];
  const firstLeg = legs[0];
  const lastLeg = legs[legs.length - 1];
  if (!firstLeg || !lastLeg) return '';

  const depTime = new Date(firstLeg.origin.departureTimePlanned);
  const arrTime = new Date(lastLeg.destination.arrivalTimePlanned);
  const totalMin = Math.round((arrTime - depTime) / 60000);

  const legsHtml = legs
    .filter((leg) => {
      // Skip internal transfers (class 99)
      return leg.transportation?.product?.class !== 99;
    })
    .map((leg) => {
      const t = leg.transportation;
      const isWalk = t?.product?.name === 'footpath';
      if (isWalk) {
        const walkMin = Math.round(leg.duration / 60);
        return `<span class="route-leg walk">🚶 ${walkMin}m</span>`;
      }
      const icon = PRODUCT_ICONS[t?.product?.name] || '🚌';
      const color = getProductColor(t);
      // Extract line number from the end of transportation.name
      const lineNum = t?.name?.match(/\d+$/)?.[0] || '';
      const stopName = leg.origin.name?.split(',')[0] || '';
      const time = fmtTime(new Date(leg.origin.departureTimePlanned));
      return `<span class="route-leg transit" style="background:${color}">${icon} ${lineNum} ${stopName} ${time}</span>`;
    })
    .join('<span class="route-arrow">→</span>');

  return `
    <div class="route-journey">
      <div class="route-times">
        <span class="route-dep">${fmtTime(depTime)}</span>
        <span class="route-dur">${totalMin} min</span>
        <span class="route-arr">${fmtTime(arrTime)}</span>
      </div>
      <div class="route-legs">${legsHtml}</div>
    </div>`;
}

async function refreshRoute() {
  const { origin, destination } = config.route;
  const originLabel = origin || 'Från';
  const destLabel = destination || 'Till';
  const hasRoute = origin && destination;

  let tripsHtml = '';
  if (hasRoute) {
    try {
      const journeys = await fetchTrips();
      const now = new Date();
      const sorted = journeys
        .map((j) => {
          const legs = j.legs || [];
          const dep = new Date(legs[0]?.origin?.departureTimePlanned);
          const arr = new Date(legs[legs.length - 1]?.destination?.arrivalTimePlanned);
          return { journey: j, dep, duration: arr - dep };
        })
        .filter((x) => x.dep >= now)
        .sort((a, b) => a.duration - b.duration)
        .slice(0, 3)
        .map((x) => x.journey);
      tripsHtml = sorted.length
        ? sorted.map(renderTrip).join('')
        : '<div class="no-departures">Inga resor hittades</div>';
    } catch (err) {
      console.error('Failed to fetch trips:', err);
    }
  }

  routeCardEl.innerHTML = `
    <div class="route-card">
      <div class="stop-header" style="background:#555">
        <span class="route-pick" data-field="origin">${esc(originLabel)}</span>
        <span class="route-swap" id="route-swap">⇄</span>
        <span class="route-pick" data-field="destination">${esc(destLabel)}</span>
        ${hasRoute ? `<span class="line-clear" id="route-clear">&times;</span>` : ''}
      </div>
      ${tripsHtml}
    </div>`;

  routeCardEl.querySelectorAll('.route-pick').forEach((el) => {
    el.addEventListener('click', () => {
      const field = el.dataset.field;
      const current = config.route[field] || '';
      showAddressSearch(field === 'origin' ? 'Från?' : 'Till?', current, (val) => {
        config.route[field] = val;
        saveConfig(config);
        refresh();
      });
    });
  });

  document.getElementById('route-swap')?.addEventListener('click', () => {
    const tmp = config.route.origin;
    config.route.origin = config.route.destination;
    config.route.destination = tmp;
    saveConfig(config);
    refresh();
  });

  document.getElementById('route-clear')?.addEventListener('click', () => {
    config.route = { origin: '', destination: '' };
    saveConfig(config);
    refresh();
  });
}

function showAddressSearch(placeholder, current, onSelect) {
  const overlay = document.createElement('div');
  overlay.className = 'search-overlay';

  const box = document.createElement('div');
  box.className = 'search-box';

  const input = document.createElement('input');
  input.className = 'search-input';
  input.type = 'text';
  input.placeholder = placeholder;
  input.value = current || '';
  input.autocomplete = 'off';

  const results = document.createElement('div');
  results.className = 'search-results';

  box.appendChild(input);
  box.appendChild(results);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  input.focus();
  input.select();

  let timer = null;

  function close() {
    if (timer) clearTimeout(timer);
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }

  function onKey(e) {
    if (e.key === 'Escape') close();
  }
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  input.addEventListener('input', () => {
    if (timer) clearTimeout(timer);
    const query = input.value.trim();
    if (!query) { results.innerHTML = ''; return; }
    timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `${JP_BASE}/stop-finder?name_sf=${encodeURIComponent(query)}&type_sf=any&any_obj_filter_sf=0`
        );
        if (!res.ok) return;
        const data = await res.json();
        const locations = data.locations || [];
        results.innerHTML = locations.slice(0, 8).map((loc) =>
          `<div class="search-result" data-name="${esc(loc.name)}">${esc(loc.name)}</div>`
        ).join('');
        results.querySelectorAll('.search-result').forEach((el) => {
          el.addEventListener('click', () => {
            onSelect(el.dataset.name);
            close();
          });
        });
      } catch (e) {
        console.error('Address search failed:', e);
      }
    }, 300);
  });
}

/* ---- Departures ---- */

function minutesUntil(dep) {
  if (dep.display === 'Nu') return 0;
  const minMatch = dep.display.match(/^(\d+)\s*min/);
  if (minMatch) return parseInt(minMatch[1]);
  const timeMatch = dep.display.match(/^(\d{1,2}):(\d{2})$/);
  if (timeMatch) {
    const now = new Date();
    const depTime = new Date();
    depTime.setHours(parseInt(timeMatch[1]), parseInt(timeMatch[2]), 0, 0);
    const diff = (depTime - now) / 60000;
    return diff < 0 ? diff + 1440 : diff;
  }
  return 0;
}

async function fetchSiteDepartures(siteId, lineId, stopName) {
  const res = await fetch(`${API_BASE}/${siteId}/departures`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const deps = (data.departures || []).filter((dep) =>
    dep.journey?.state !== 'CANCELLED' && dep.state !== 'CANCELLED' &&
    dep.line?.id === lineId &&
    minutesUntil(dep) <= MAX_MINUTES
  ).map((dep) => ({ ...dep, _stop: stopName }));

  return deps;
}

async function fetchLine(line) {
  if (!line.lineId || !line.from || !line.to) return { line, departures: [] };

  const [fromResult, toResult] = await Promise.allSettled([
    fetchSiteDepartures(line.from.siteId, line.lineId, line.from.name),
    fetchSiteDepartures(line.to.siteId, line.lineId, line.to.name),
  ]);

  // Keep departures separate per station, take top 3 from each
  const fromDeps = (fromResult.status === 'fulfilled' ? fromResult.value : []).slice(0, 3);
  const toDeps = (toResult.status === 'fulfilled' ? toResult.value : []).slice(0, 3);

  // Tag with override destination
  const toName = cleanStopName(line.to.name);
  const fromName = cleanStopName(line.from.name);
  for (const d of fromDeps) d._destOverride = toName;
  for (const d of toDeps) d._destOverride = fromName;

  return { line, departures: [...fromDeps, ...toDeps] };
}

function cleanStopName(name) {
  return name.replace(/^(Stockholm|Lidingö|Nacka|Solna|Sundbyberg|Danderyd),\s*/i, '');
}

function renderDeparture(dep) {
  const isNow = dep.display === 'Nu';
  const dest = dep._destOverride || cleanStopName(dep.destination);
  const stop = dep._stop ? cleanStopName(dep._stop) : '';
  const route = stop ? `${stop}–${dest}` : dest;

  // Calculate departure clock time and minutes
  const mins = minutesUntil(dep);
  let depClock;
  const timeMatch = dep.display.match(/^(\d{1,2}):(\d{2})$/);
  if (timeMatch) {
    depClock = dep.display;
  } else {
    const now = new Date();
    const clock = new Date(now.getTime() + mins * 60000);
    depClock = `${pad(clock.getHours())}:${pad(clock.getMinutes())}`;
  }

  // Detect delay: expected vs scheduled
  const isDelayed = dep.expected && dep.scheduled && new Date(dep.expected) > new Date(dep.scheduled);
  const timeColor = isDelayed ? ' style="color:#f59e0b"' : '';

  let timeHtml;
  if (isNow) {
    timeHtml = `<span class="time now">Nu</span><span class="time now">${depClock}</span>`;
  } else {
    timeHtml = `<span class="time-min"${timeColor}>${Math.round(mins)} min</span><span class="time"${timeColor}>${depClock}</span>`;
  }

  return `
    <div class="departure-row">
      <span class="destination">${esc(route)}</span>
      ${timeHtml}
    </div>`;
}

function renderLine({ line, departures }, index) {
  const isConfigured = line.lineId && line.from;
  let rows;
  if (!isConfigured) {
    rows = '';
  } else if (!departures.length) {
    rows = '<div class="no-departures">Inga avgångar</div>';
  } else {
    // Group by departure station
    const grouped = {};
    for (const dep of departures) {
      const stop = dep._stop ? cleanStopName(dep._stop) : '';
      if (!grouped[stop]) grouped[stop] = [];
      grouped[stop].push(dep);
    }
    const stops = Object.keys(grouped);
    if (stops.length > 1) {
      rows = stops.map((stop) =>
        `<div class="direction-header">${esc(stop)}</div>` +
        grouped[stop].map(renderDeparture).join('')
      ).join('');
    } else {
      rows = departures.map(renderDeparture).join('');
    }
  }

  // Collect unique deviation/disruption messages
  const deviationMessages = [];
  const seenMessages = new Set();
  for (const dep of departures) {
    const devs = dep.deviations || [];
    for (const dev of devs) {
      const msg = dev.message || dev.header || '';
      if (msg && !seenMessages.has(msg)) {
        seenMessages.add(msg);
        deviationMessages.push(msg);
      }
    }
  }
  const deviationsHtml = deviationMessages.length
    ? `<div class="deviation-banner">${deviationMessages.map((m) => esc(m)).join('<br>')}</div>`
    : '';

  const fromName = line.from?.name ? cleanStopName(line.from.name) : 'Från';
  const toName = line.to?.name ? cleanStopName(line.to.name) : 'Till';
  const hasLine = !!line.lineId;

  return `
    <section class="stop-section">
      <div class="stop-header" style="background:${line.color}">
        ${hasLine
          ? `<span class="line-name" data-index="${index}">${esc(line.lineName)}</span>
             ${line.url ? `<a href="${line.url}" target="_blank" class="timetable-link">(PDF)</a>` : ''}
             <span class="header-sep">·</span>
             <span class="station-pick" data-index="${index}" data-field="from">${esc(fromName)}</span>
             <span class="header-sep">·</span>
             <span class="station-pick" data-index="${index}" data-field="to">${esc(toName)}</span>
             <span class="line-clear" data-index="${index}">&times;</span>`
          : `<input class="line-input" data-index="${index}" type="text" inputmode="numeric" placeholder="Lägg till linje…" maxlength="4" /><span class="line-ok hidden" data-index="${index}">OK</span>`
        }
      </div>
      ${deviationsHtml}
      ${rows}
    </section>`;
}

/* ---- Line selection (inline input) ---- */

function applyLineMatch(index, match) {
  const lineConfig = config.lines[index];
  lineConfig.lineId = match.id;
  lineConfig.lineName = match.designation;
  lineConfig.color = TRANSPORT_MODE_COLORS[match.transport_mode] || '#888';
  lineConfig.url = `https://kund.printhuset-sthlm.se/sl/v${match.designation}.pdf`;
  saveConfig(config);
  refresh();
}

/* ---- Station selection (search modal) ---- */

let searchDebounceTimer = null;

function showStationSearch(index, field) {
  const overlay = document.createElement('div');
  overlay.className = 'search-overlay';

  const box = document.createElement('div');
  box.className = 'search-box';

  const input = document.createElement('input');
  input.className = 'search-input';
  input.type = 'text';
  input.placeholder = 'Sök hållplats...';
  input.autocomplete = 'off';

  const results = document.createElement('div');
  results.className = 'search-results';

  box.appendChild(input);
  box.appendChild(results);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  input.focus();

  function close() {
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    overlay.remove();
  }

  // Close on overlay click (but not box click)
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  // Close on Escape
  function onKey(e) {
    if (e.key === 'Escape') {
      close();
      document.removeEventListener('keydown', onKey);
    }
  }
  document.addEventListener('keydown', onKey);

  input.addEventListener('input', () => {
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    const query = input.value.trim();
    if (!query) {
      results.innerHTML = '';
      return;
    }
    searchDebounceTimer = setTimeout(async () => {
      try {
        const res = await fetch(
          `https://journeyplanner.integration.sl.se/v2/stop-finder?name_sf=${encodeURIComponent(query)}&type_sf=any&any_obj_filter_sf=2`
        );
        if (!res.ok) return;
        const data = await res.json();
        const locations = data.locations || [];
        results.innerHTML = locations.slice(0, 10).map((loc) => {
          const stopId = loc.properties?.stopId || '';
          return `<div class="search-result" data-stop-id="${esc(stopId)}" data-name="${esc(loc.name)}">${esc(loc.name)}</div>`;
        }).join('');

        results.querySelectorAll('.search-result').forEach((el) => {
          el.addEventListener('click', async () => {
            const rawId = el.dataset.stopId;
            const name = el.dataset.name;
            // Stop-finder returns long IDs (e.g. 18009249), departures API uses short (9249)
            const longId = parseInt(rawId, 10);
            if (isNaN(longId)) {
              alert('Ogiltigt stopp-ID.');
              return;
            }
            const siteId = longId > 100000 ? longId % 100000 : longId;

            // Update config
            config.lines[index][field] = { siteId, name };
            saveConfig(config);
            document.removeEventListener('keydown', onKey);
            close();
            refresh();
          });
        });
      } catch (e) {
        console.error('Station search failed:', e);
      }
    }, 300);
  });
}

/* ---- Timestamp ---- */

function updateTimestamp() {
  const now = new Date();
  const time = now.toLocaleTimeString('sv-SE', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  updatedEl.textContent = `Uppdaterad ${time}`;
}

/* ---- Main loop ---- */

fetchAllLines();

let refreshing = false;

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  const [, ...lineResults] = await Promise.allSettled([
    refreshRoute(),
    ...config.lines.map(fetchLine),
  ]);
  const html = lineResults.map((result, i) => {
    if (result.status === 'fulfilled') {
      return renderLine(result.value, i);
    }
    console.error(`Failed to fetch ${config.lines[i].lineName}:`, result.reason);
    return `
      <section class="stop-section">
        <div class="stop-header" style="background:${config.lines[i].color}">
          <span class="line-name">${esc(config.lines[i].lineName)}</span>
        </div>
        <div class="no-departures">Kunde inte hämta avgångar</div>
      </section>`;
  });

  // Add "add line" bar if under max
  const allConfigured = config.lines.every((l) => l.lineId && l.from && l.to);
  if (config.lines.length < MAX_LINES) {
    const disabled = !allConfigured;
    html.push(`
      <section class="stop-section add-line-section${disabled ? ' disabled' : ''}" id="add-line-btn">
        <div class="stop-header add-line-header">+</div>
      </section>`);
  }

  departuresEl.innerHTML = html.join('');

  // Attach line-name click handlers (re-enter line number)
  departuresEl.querySelectorAll('.line-name').forEach((el) => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.index, 10);
      // Reset line to show input again
      config.lines[idx] = { ...EMPTY_LINE };
      saveConfig(config);
      refresh();
    });
  });

  // Click header to focus input
  departuresEl.querySelectorAll('.stop-header').forEach((header) => {
    const input = header.querySelector('.line-input');
    if (!input) return;
    header.style.cursor = 'text';
    header.addEventListener('click', (e) => {
      if (e.target !== input && !e.target.classList.contains('line-ok')) input.focus();
    });
  });

  // Show OK button when typing line number + handle Enter key
  departuresEl.querySelectorAll('.line-input').forEach((input) => {
    const idx = input.dataset.index;
    const btn = departuresEl.querySelector(`.line-ok[data-index="${idx}"]`);
    input.addEventListener('input', () => {
      btn?.classList.toggle('hidden', !input.value.trim());
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const val = input.value.trim();
        if (!val || !allSLLines) return;
        const match = allSLLines.find((l) => l.designation === val);
        if (!match) return;
        applyLineMatch(parseInt(idx, 10), match);
      }
    });
  });

  // Attach line-input OK handlers
  departuresEl.querySelectorAll('.line-ok').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.index, 10);
      const input = departuresEl.querySelector(`.line-input[data-index="${idx}"]`);
      const val = input?.value.trim();
      if (!val || !allSLLines) return;
      const match = allSLLines.find((l) => l.designation === val);
      if (!match) return;
      applyLineMatch(idx, match);
    });
  });

  // Attach station-pick click handlers
  departuresEl.querySelectorAll('.station-pick').forEach((el) => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.index, 10);
      const field = el.dataset.field;
      showStationSearch(idx, field);
    });
  });

  // Attach clear button handlers — remove the line with confirmation
  departuresEl.querySelectorAll('.line-clear').forEach((el) => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.index, 10);
      const name = config.lines[idx].lineName || 'denna linje';
      if (!confirm(`Ta bort ${name}?`)) return;
      config.lines.splice(idx, 1);
      if (config.lines.length === 0) config.lines.push({ ...EMPTY_LINE });
      saveConfig(config);
      refresh();
    });
  });

  // Attach add-line button
  document.getElementById('add-line-btn')?.addEventListener('click', () => {
    config.lines.push({ ...EMPTY_LINE });
    saveConfig(config);
    refresh();
  });

  updateTimestamp();
  refreshing = false;
}

refresh();
setInterval(refresh, REFRESH_INTERVAL);
