/* ---- Config ---- */

// Lines: each is a card showing departures for one line from one or more stops
const DEFAULT_LINES = [
  {
    name: '206',
    color: '#1e6bc9',
    url: 'https://kund.printhuset-sthlm.se/sl/v206.pdf',
    sources: [
      { id: 2070, lines: [206], stop: 'Larsberg' },
      { id: 9220, lines: [206], directions: [1], stop: 'Ropsten' },
    ],
  },
  {
    name: '21',
    color: '#7b4fa0',
    url: 'https://kund.printhuset-sthlm.se/sl/v21.pdf',
    sources: [
      { id: 9249, lines: [21], directions: [2], stop: 'Larsberg', dest: 'Ropsten' },
    ],
  },
  {
    name: '80',
    color: '#00a4b7',
    url: 'https://kund.printhuset-sthlm.se/sl/v80.pdf',
    sources: [
      { id: 9255, lines: [80], directions: [2], stop: 'Dalénum', dest: 'Nacka Strand' },
      { id: 1442, lines: [80], directions: [1], stop: 'Saltsjöqvarn' },
    ],
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

function saveConfig(config) {
  localStorage.setItem('slapp-config', JSON.stringify(config));
}

let config = loadConfig();

const ZONES = [
  { lat: 59.356, lng: 18.130, radius: 800, lines: ['206', '21', '80'] },
  { lat: 59.320, lng: 18.100, radius: 500, lines: ['80'] },
];

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

async function fetchSourceDepartures(source) {
  const res = await fetch(`${API_BASE}/${source.id}/departures`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return (data.departures || []).filter((dep) =>
    dep.journey?.state !== 'CANCELLED' && dep.state !== 'CANCELLED' &&
    source.lines.includes(dep.line?.id) &&
    (!source.directions || source.directions.includes(dep.direction_code)) &&
    minutesUntil(dep) <= MAX_MINUTES
  ).map((dep) => ({ ...dep, _stop: source.stop, ...(source.dest && { destination: source.dest }) }));
}

async function fetchLine(line) {
  const results = await Promise.allSettled(line.sources.map(fetchSourceDepartures));
  const allDeps = [];
  for (const r of results) {
    if (r.status === 'fulfilled') allDeps.push(...r.value);
  }
  // Sort by time
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

function renderLine({ line, departures }, dimmed, index) {
  const rows = departures.length
    ? departures.map(renderDeparture).join('')
    : '<div class="no-departures">Inga avgångar</div>';

  return `
    <section class="stop-section${dimmed ? ' dimmed' : ''}">
      <div class="stop-header" style="background:${line.color}">
        <span class="line-badge">${esc(line.name)}</span>
        ${line.url ? `<a href="${line.url}" target="_blank" class="timetable-link">(PDF)</a>` : ''}
        <button class="remove-line" data-index="${index}">−</button>
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

function getRelevantLines() {
  if (!userPosition) return null;
  for (const zone of ZONES) {
    const dist = distanceMeters(userPosition.lat, userPosition.lng, zone.lat, zone.lng);
    if (dist <= zone.radius) return zone.lines;
  }
  return null;
}

function updateGPS() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => { userPosition = { lat: pos.coords.latitude, lng: pos.coords.longitude }; },
    () => { userPosition = null; },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
  );
}

/* ---- Add line discovery ---- */

const MODE_COLORS = {
  BUS: '#1e6bc9',
  METRO: '#e32d22',
  TRAM: '#7b4fa0',
  SHIP: '#00a4b7',
  TRAIN: '#f47d30',
};

async function addLineFlow() {
  const lineNumber = prompt('Linjenummer?');
  if (!lineNumber) return;

  const stopName = prompt('Hållplats?');
  if (!stopName) return;

  try {
    // Resolve stop
    const stopRes = await fetch(
      `https://journeyplanner.integration.sl.se/v2/stop-finder?name_sf=${encodeURIComponent(stopName)}&type_sf=any&any_obj_filter_sf=2`
    );
    if (!stopRes.ok) { alert('Kunde inte söka hållplats.'); return; }
    const stopData = await stopRes.json();

    const locations = stopData.locations || [];
    if (!locations.length) { alert('Hittade ingen hållplats.'); return; }

    const location = locations[0];
    const stopId = location.properties?.stopId;
    if (!stopId) { alert('Kunde inte hitta stopp-ID.'); return; }

    // Extract numeric site ID
    const siteId = parseInt(stopId, 10);
    if (isNaN(siteId)) { alert('Ogiltigt stopp-ID.'); return; }

    // Fetch departures to verify line exists
    const depRes = await fetch(`${API_BASE}/${siteId}/departures`);
    if (!depRes.ok) { alert('Kunde inte hämta avgångar.'); return; }
    const depData = await depRes.json();

    const lineId = parseInt(lineNumber, 10);
    const matching = (depData.departures || []).find(
      (d) => d.line?.id === lineId
    );

    if (!matching) { alert(`Linje ${lineNumber} hittades inte vid denna hållplats.`); return; }

    const transportMode = matching.line?.transport_mode || 'BUS';
    const color = MODE_COLORS[transportMode] || '#888';
    const resolvedStopName = location.name || stopName;

    config.lines.push({
      name: lineNumber,
      color,
      sources: [
        { id: siteId, lines: [lineId], stop: resolvedStopName },
      ],
    });
    saveConfig(config);
    refresh();
  } catch (err) {
    console.error('Add line failed:', err);
    alert('Något gick fel.');
  }
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

async function refresh() {
  updateGPS();
  const relevant = getRelevantLines();
  const [, ...lineResults] = await Promise.allSettled([
    refreshRoute(),
    ...config.lines.map(fetchLine),
  ]);
  const html = lineResults.map((result, i) => {
    const dimmed = relevant !== null && !relevant.includes(config.lines[i].name);
    if (result.status === 'fulfilled') {
      return renderLine(result.value, dimmed, i);
    }
    console.error(`Failed to fetch ${config.lines[i].name}:`, result.reason);
    return `
      <section class="stop-section${dimmed ? ' dimmed' : ''}">
        <div class="stop-header"><span class="line-badge" style="background:${config.lines[i].color}">${esc(config.lines[i].name)}</span></div>
        <div class="no-departures">Kunde inte hämta avgångar</div>
      </section>`;
  });

  // Add the "+" button section
  html.push(`
    <section class="stop-section add-line-section">
      <div class="stop-header add-line-header">
        <button class="add-line">+</button>
      </div>
    </section>`);

  departuresEl.innerHTML = html.join('');

  // Attach remove-line handlers
  departuresEl.querySelectorAll('.remove-line').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.index, 10);
      config.lines.splice(idx, 1);
      saveConfig(config);
      refresh();
    });
  });

  // Attach add-line handler
  const addBtn = departuresEl.querySelector('.add-line');
  if (addBtn) {
    addBtn.addEventListener('click', () => addLineFlow());
  }

  updateTimestamp();
}

refresh();
setInterval(refresh, REFRESH_INTERVAL);
