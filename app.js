/* ---- Config ---- */

const DEFAULT_LINES = [
  {
    lineId: 206, lineName: '206', color: '#1e6bc9',
    url: 'https://kund.printhuset-sthlm.se/sl/v206.pdf',
    from: { siteId: 2070, name: 'Larsberg' },
    to: { siteId: 9220, name: 'Ropsten' },
  },
  {
    lineId: 21, lineName: '21', color: '#7b4fa0',
    url: 'https://kund.printhuset-sthlm.se/sl/v21.pdf',
    from: { siteId: 9249, name: 'Larsberg' },
    to: null,
  },
  {
    lineId: 80, lineName: '80', color: '#00a4b7',
    url: 'https://kund.printhuset-sthlm.se/sl/v80.pdf',
    from: { siteId: 9255, name: 'Dalénum' },
    to: { siteId: 1442, name: 'Saltsjöqvarn' },
  },
];

const DEFAULT_ROUTE = {
  origin: 'Åsögatan 122',
  destination: 'Larsbergsvägen 27',
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

// Smart connections: walk → green line Medborgarplatsen → Slussen → red 13 → Ropsten → 206/21
// Alternative: walk → bus 76 Medborgarplatsen → Ropsten → 206/21
const CONNECTIONS = {
  // Walk to Medborgarplatsen
  walkToMedborgare: 6,       // min walk from Åsögatan 122
  medborgareSiteId: 9191,     // Medborgarplatsen
  // Metro route: green line → Slussen → red line → Ropsten
  greenLines: [17, 18, 19],
  greenDirection: 1,           // northbound towards Slussen
  greenTravelTime: 2,          // min Medborgarplatsen → Slussen
  slussenSiteId: 9192,
  redLines: [13, 14],
  redDirection: 1,              // northbound towards Ropsten
  slussenTransfer: 3,           // min transfer green→red at Slussen
  redTravelTime: 12,            // min Slussen → Ropsten
  // Bus 76 alternative: direct Medborgarplatsen → Ropsten
  bus76Line: 76,
  bus76Direction: 2,            // towards Ropsten
  bus76TravelTime: 25,          // min Medborgarplatsen → Ropsten
  // Transfer at Ropsten to 206/21
  buffer: 3,
  ropsten: { id: 9220, lines: [206, 21], directions: [1] },
  // Last mile: ride from Ropsten + walk to Larsbergsvägen 27
  lastMile: {
    206: 22,  // 20 min bus to Larsbergsvägen (Vändslingan) + 2 min walk
    21: 16,   // 6 min tram to Larsberg + 10 min walk
  },
};

const API_BASE = 'https://transport.integration.sl.se/v1/sites';
const MAX_DEPARTURES = 8;
const MAX_MINUTES = 60;
const REFRESH_INTERVAL = 30000;

const departuresEl = document.getElementById('departures');
const routeCardEl = document.getElementById('route-card');
const updatedEl = document.getElementById('updated');

let userPosition = null;
let allSLLines = null; // fetched once on load

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function pad(n) { return String(n).padStart(2, '0'); }

const DESTINATION_NAMES = {
  'Högsätra Larsberg': 'Larsberg',
  'Gåshaga brygga': 'Gåshaga',
  'Käppala': 'Gåshaga',
  'Gåshaga Brygga': 'Gåshaga',
};

function cleanDestination(name) {
  return DESTINATION_NAMES[name] || name;
}

/* ---- Fetch all SL lines (once) ---- */

async function fetchAllLines() {
  try {
    const res = await fetch('https://transport.integration.sl.se/v1/lines?transport_authority_id=1');
    if (!res.ok) return;
    const data = await res.json();
    allSLLines = data || [];
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

const TRANSPORT_MODE_ORDER = ['METRO', 'TRAM', 'BUS', 'SHIP', 'TRAIN'];

/* ---- Smart connections: Åsögatan → Slussen → Ropsten → Lidingö ---- */

async function fetchConnections() {
  const C = CONNECTIONS;
  const [greenRes, redRes, ropstenRes] = await Promise.allSettled([
    fetch(`${API_BASE}/${C.medborgareSiteId}/departures`).then((r) => r.ok ? r.json() : Promise.reject()),
    fetch(`${API_BASE}/${C.slussenSiteId}/departures`).then((r) => r.ok ? r.json() : Promise.reject()),
    fetch(`${API_BASE}/${C.ropsten.id}/departures`).then((r) => r.ok ? r.json() : Promise.reject()),
  ]);

  if (greenRes.status !== 'fulfilled' || redRes.status !== 'fulfilled' || ropstenRes.status !== 'fulfilled') return [];

  const now = new Date();

  function depTime(dep) {
    return dep.expected ? new Date(dep.expected) : new Date(dep.scheduled);
  }

  function notCancelled(d) {
    return d.journey?.state !== 'CANCELLED' && d.state !== 'CANCELLED';
  }

  // Green line from Medborgarplatsen northbound
  const greens = (greenRes.value.departures || []).filter(
    (d) => notCancelled(d) && C.greenLines.includes(d.line?.id) && d.direction_code === C.greenDirection
  );

  // Red line from Slussen northbound
  const reds = (redRes.value.departures || []).filter(
    (d) => notCancelled(d) && C.redLines.includes(d.line?.id) && d.direction_code === C.redDirection
  );

  // 206/21 from Ropsten towards Lidingö
  const lidingo = (ropstenRes.value.departures || []).filter(
    (d) => notCancelled(d) && C.ropsten.lines.includes(d.line?.id) && C.ropsten.directions.includes(d.direction_code)
  );

  // Bus 76 from Medborgarplatsen towards Ropsten
  const buses76 = (greenRes.value.departures || []).filter(
    (d) => notCancelled(d) && d.line?.id === C.bus76Line && d.direction_code === C.bus76Direction
  );

  const connections = [];

  for (const lid of lidingo) {
    const lidDep = depTime(lid);

    // --- Metro route: green → red → Ropsten ---
    const latestRedArr = new Date(lidDep.getTime() - C.buffer * 60000);
    const latestRedDep = new Date(latestRedArr.getTime() - C.redTravelTime * 60000);

    let bestRed = null;
    for (const r of reds) {
      const rDep = depTime(r);
      if (rDep <= latestRedDep && rDep > now - 60000) {
        if (!bestRed || rDep > depTime(bestRed)) bestRed = r;
      }
    }

    if (bestRed) {
      const redDep = depTime(bestRed);
      const latestGreenArr = new Date(redDep.getTime() - C.slussenTransfer * 60000);
      const latestGreenDep = new Date(latestGreenArr.getTime() - C.greenTravelTime * 60000);

      let bestGreen = null;
      for (const g of greens) {
        const gDep = depTime(g);
        if (gDep <= latestGreenDep && gDep > now - 60000) {
          if (!bestGreen || gDep > depTime(bestGreen)) bestGreen = g;
        }
      }

      if (bestGreen) {
        const greenDep = depTime(bestGreen);
        const leaveWork = new Date(greenDep.getTime() - C.walkToMedborgare * 60000);
        if (leaveWork >= now - 60000) {
          const lastMileMin = C.lastMile[lid.line?.id] || 20;
          const arriveHome = new Date(lidDep.getTime() + lastMileMin * 60000);
          connections.push({
            type: 'metro',
            leaveWork,
            arriveHome,
            greenDep,
            greenLine: bestGreen.line?.id,
            redDep,
            redLine: bestRed.line?.id,
            lidingoDep: lidDep,
            lidingoLine: lid.line?.id,
            lidingoDest: cleanDestination(lid.destination),
            totalMin: Math.round((arriveHome - leaveWork) / 60000),
          });
        }
      }
    }

    // --- Bus 76 route: direct to Ropsten ---
    const latestBusArr = new Date(lidDep.getTime() - C.buffer * 60000);
    const latestBusDep = new Date(latestBusArr.getTime() - C.bus76TravelTime * 60000);

    let bestBus = null;
    for (const b of buses76) {
      const bDep = depTime(b);
      if (bDep <= latestBusDep && bDep > now - 60000) {
        if (!bestBus || bDep > depTime(bestBus)) bestBus = b;
      }
    }

    if (bestBus) {
      const busDep = depTime(bestBus);
      const leaveWork = new Date(busDep.getTime() - C.walkToMedborgare * 60000);
      if (leaveWork >= now - 60000) {
        const lastMileMin = C.lastMile[lid.line?.id] || 20;
        const arriveHome = new Date(lidDep.getTime() + lastMileMin * 60000);
        connections.push({
          type: 'bus76',
          leaveWork,
          arriveHome,
          busDep,
          lidingoDep: lidDep,
          lidingoLine: lid.line?.id,
          lidingoDest: cleanDestination(lid.destination),
          totalMin: Math.round((arriveHome - leaveWork) / 60000),
        });
      }
    }
  }

  // Sort by leave time, deduplicate
  connections.sort((a, b) => a.leaveWork - b.leaveWork);
  const seen = new Set();
  return connections.filter((c) => {
    const key = `${c.type}-${c.lidingoDep.getTime()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 5);
}

function fmtTime(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const LINE_COLORS = {
  13: '#e32d22', 14: '#1e6bc9',  // red, blue metro
  17: '#4ca85b', 18: '#4ca85b', 19: '#4ca85b',  // green metro
  206: '#1e6bc9', 21: '#7b4fa0', 80: '#00a4b7',  // bus, tram, boat
  76: '#1e6bc9',  // bus 76
};

function renderConnection(conn) {
  const lidingoColor = LINE_COLORS[conn.lidingoLine] || '#888';
  const lidingoIcon = conn.lidingoLine === 206 ? '🚌' : '🚃';

  let legsHtml;
  if (conn.type === 'bus76') {
    legsHtml = `
      <span class="route-leg walk">🚶 ${CONNECTIONS.walkToMedborgare}m</span>
      <span class="route-arrow">→</span>
      <span class="route-leg transit" style="background:${LINE_COLORS[76]}">🚌 76 Medborgarpl. ${fmtTime(conn.busDep)}</span>
      <span class="route-arrow">→</span>
      <span class="route-leg transit" style="background:${lidingoColor}">
        ${lidingoIcon} ${conn.lidingoLine} ${fmtTime(conn.lidingoDep)}
      </span>`;
  } else {
    const greenColor = LINE_COLORS[conn.greenLine] || '#4ca85b';
    const redColor = LINE_COLORS[conn.redLine] || '#e32d22';
    legsHtml = `
      <span class="route-leg walk">🚶 ${CONNECTIONS.walkToMedborgare}m</span>
      <span class="route-arrow">→</span>
      <span class="route-leg transit" style="background:${greenColor}">🚇 ${conn.greenLine} Medborgarpl. ${fmtTime(conn.greenDep)}</span>
      <span class="route-arrow">→</span>
      <span class="route-leg transit" style="background:${redColor}">🚇 ${conn.redLine} Slussen ${fmtTime(conn.redDep)}</span>
      <span class="route-arrow">→</span>
      <span class="route-leg transit" style="background:${lidingoColor}">
        ${lidingoIcon} ${conn.lidingoLine} ${fmtTime(conn.lidingoDep)}
      </span>`;
  }

  return `
    <div class="route-journey">
      <div class="route-times">
        <span class="route-dep">${fmtTime(conn.leaveWork)}</span>
        <span class="route-dur">${conn.totalMin} min</span>
        <span class="route-arr">${fmtTime(conn.arriveHome)}</span>
      </div>
      <div class="route-legs">${legsHtml}</div>
    </div>`;
}

async function refreshRoute() {
  try {
    const connections = await fetchConnections();
    if (!connections.length) {
      routeCardEl.innerHTML = '';
      return;
    }
    const html = connections.map(renderConnection).join('');
    routeCardEl.innerHTML = `
      <div class="route-card">
        <div class="route-header">${esc(config.route.origin)} → ${esc(config.route.destination)}</div>
        ${html}
      </div>`;
  } catch (err) {
    console.error('Failed to fetch connections:', err);
    routeCardEl.innerHTML = '';
  }
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

async function fetchSiteDepartures(siteId, lineId, stopName, applyDestOverride) {
  const res = await fetch(`${API_BASE}/${siteId}/departures`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return (data.departures || []).filter((dep) =>
    dep.journey?.state !== 'CANCELLED' && dep.state !== 'CANCELLED' &&
    dep.line?.id === lineId &&
    minutesUntil(dep) <= MAX_MINUTES
  ).map((dep) => {
    const result = { ...dep, _stop: stopName };
    if (applyDestOverride && DESTINATION_NAMES[dep.destination]) {
      result.destination = DESTINATION_NAMES[dep.destination];
    }
    return result;
  });
}

async function fetchLine(line) {
  const fetches = [];
  // Is this one of the default lines? (for dest override logic)
  const isDefault = DEFAULT_LINES.some((dl) => dl.lineId === line.lineId);

  // Fetch from "from" station
  fetches.push(fetchSiteDepartures(line.from.siteId, line.lineId, line.from.name, isDefault));

  // Fetch from "to" station if present
  if (line.to) {
    fetches.push(fetchSiteDepartures(line.to.siteId, line.lineId, line.to.name, isDefault));
  }

  const results = await Promise.allSettled(fetches);
  const allDeps = [];
  for (const r of results) {
    if (r.status === 'fulfilled') allDeps.push(...r.value);
  }
  allDeps.sort((a, b) => minutesUntil(a) - minutesUntil(b));
  return { line, departures: allDeps.slice(0, MAX_DEPARTURES) };
}

function renderDeparture(dep) {
  const isNow = dep.display === 'Nu';
  const dest = cleanDestination(dep.destination);
  const route = dep._stop ? `${dep._stop}–${dest}` : dest;
  return `
    <div class="departure-row">
      <span class="destination">${esc(route)}</span>
      <span class="time${isNow ? ' now' : ''}">${esc(dep.display)}</span>
    </div>`;
}

function renderLine({ line, departures }, index) {
  const rows = departures.length
    ? departures.map(renderDeparture).join('')
    : '<div class="no-departures">Inga avgångar</div>';

  return `
    <section class="stop-section">
      <div class="stop-header" style="background:${line.color}">
        <span class="line-name" data-index="${index}">${esc(line.lineName)}</span>
        ${line.url ? `<a href="${line.url}" target="_blank" class="timetable-link">(PDF)</a>` : ''}
        <span class="header-sep">·</span>
        <span class="station-pick" data-index="${index}" data-field="from">${esc(line.from.name)}</span>
        ${line.to ? `<span class="header-sep">·</span><span class="station-pick" data-index="${index}" data-field="to">${esc(line.to.name)}</span>` : ''}
      </div>
      ${rows}
    </section>`;
}

/* ---- GPS ---- */

function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function updateGPS() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => { userPosition = { lat: pos.coords.latitude, lng: pos.coords.longitude }; },
    () => { userPosition = null; },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
  );
}

/* ---- Line selection (native <select> dropdown) ---- */

function showLineSelect(index, targetEl) {
  if (!allSLLines || !allSLLines.length) {
    alert('Linjer har inte laddats än. Försök igen.');
    return;
  }

  // Group lines by transport_mode
  const grouped = {};
  for (const mode of TRANSPORT_MODE_ORDER) grouped[mode] = [];
  for (const line of allSLLines) {
    const mode = line.transport_mode || 'BUS';
    if (!grouped[mode]) grouped[mode] = [];
    grouped[mode].push(line);
  }
  // Sort each group by designation
  for (const mode of Object.keys(grouped)) {
    grouped[mode].sort((a, b) => {
      const aNum = parseInt(a.designation, 10);
      const bNum = parseInt(b.designation, 10);
      if (!isNaN(aNum) && !isNaN(bNum)) return aNum - bNum;
      return a.designation.localeCompare(b.designation);
    });
  }

  const sel = document.createElement('select');
  sel.className = 'line-select-dropdown';
  sel.size = 12;

  const modeLabels = { METRO: 'Tunnelbana', TRAM: 'Spårvagn', BUS: 'Buss', SHIP: 'Båt', TRAIN: 'Tåg' };

  for (const mode of TRANSPORT_MODE_ORDER) {
    if (!grouped[mode] || !grouped[mode].length) continue;
    const optgroup = document.createElement('optgroup');
    optgroup.label = modeLabels[mode] || mode;
    for (const line of grouped[mode]) {
      const opt = document.createElement('option');
      opt.value = JSON.stringify({ id: line.id, designation: line.designation, mode: line.transport_mode });
      opt.textContent = `${line.designation}${line.group_of_lines ? ' – ' + line.group_of_lines : ''}`;
      opt.selected = line.id === config.lines[index].lineId;
      optgroup.appendChild(opt);
    }
    sel.appendChild(optgroup);
  }

  // Position over the target element
  const rect = targetEl.getBoundingClientRect();
  sel.style.position = 'fixed';
  sel.style.left = rect.left + 'px';
  sel.style.top = rect.bottom + 'px';
  sel.style.zIndex = '200';
  sel.style.background = '#1a1a2e';
  sel.style.color = '#fff';
  sel.style.border = '1px solid rgba(255,255,255,0.2)';
  sel.style.borderRadius = '8px';
  sel.style.padding = '4px';
  sel.style.fontSize = '0.9rem';
  sel.style.minWidth = '200px';
  sel.style.maxHeight = '300px';
  sel.style.overflowY = 'auto';

  function cleanup() {
    sel.remove();
  }

  sel.addEventListener('change', () => {
    const val = JSON.parse(sel.value);
    const lineConfig = config.lines[index];
    lineConfig.lineId = val.id;
    lineConfig.lineName = val.designation;
    lineConfig.color = TRANSPORT_MODE_COLORS[val.mode] || '#888';
    lineConfig.url = `https://kund.printhuset-sthlm.se/sl/v${val.designation}.pdf`;
    saveConfig(config);
    cleanup();
    refresh();
  });

  sel.addEventListener('blur', cleanup);

  document.body.appendChild(sel);
  sel.focus();
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
            const siteId = parseInt(rawId, 10);
            if (isNaN(siteId)) {
              alert('Ogiltigt stopp-ID.');
              return;
            }

            // Verify line serves this station
            try {
              const depRes = await fetch(`${API_BASE}/${siteId}/departures`);
              if (!depRes.ok) {
                alert('Kunde inte hämta avgångar för denna hållplats.');
                return;
              }
              const depData = await depRes.json();
              const lineId = config.lines[index].lineId;
              const found = (depData.departures || []).some((d) => d.line?.id === lineId);
              if (!found) {
                alert(`Linje ${config.lines[index].lineName} hittades inte vid ${name}.`);
                return;
              }
            } catch (e) {
              alert('Kunde inte verifiera hållplats.');
              return;
            }

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

updateGPS();
fetchAllLines();

async function refresh() {
  updateGPS();
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

  departuresEl.innerHTML = html.join('');

  // Attach line-name click handlers
  departuresEl.querySelectorAll('.line-name').forEach((el) => {
    el.addEventListener('click', (e) => {
      const idx = parseInt(el.dataset.index, 10);
      showLineSelect(idx, el);
    });
  });

  // Attach station-pick click handlers
  departuresEl.querySelectorAll('.station-pick').forEach((el) => {
    el.addEventListener('click', (e) => {
      const idx = parseInt(el.dataset.index, 10);
      const field = el.dataset.field;
      showStationSearch(idx, field);
    });
  });

  updateTimestamp();
}

refresh();
setInterval(refresh, REFRESH_INTERVAL);
