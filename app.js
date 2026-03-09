/* ---- Config ---- */

// Lines: each is a card showing departures for one line from one or more stops
const LINES = [
  {
    name: '206',
    color: '#1e6bc9',
    sources: [
      { id: 2070, lines: [206] },                  // Larsbergsvägen (both dirs)
      { id: 9220, lines: [206], directions: [1] },  // Ropsten towards Larsberg
    ],
  },
  {
    name: '21',
    color: '#7b4fa0',
    sources: [
      { id: 9249, lines: [21] },                    // Larsberg (both dirs)
    ],
  },
  {
    name: '80',
    color: '#00a4b7',
    sources: [
      { id: 9255, lines: [80] },                    // Dalénum
      { id: 1442, lines: [80] },                    // Saltsjöqvarn
    ],
  },
];

const ZONES = [
  { lat: 59.356, lng: 18.130, radius: 800, lines: ['206', '21', '80'] },
  { lat: 59.320, lng: 18.100, radius: 500, lines: ['80'] },
];

const ROUTE = {
  origin: 'Larsbergsvägen 27, Lidingö',
  destination: 'Åsögatan 122, Stockholm',
};

// Bike+boat route config
const BIKE_ROUTE = {
  bikeToBoat: 5,       // min bike from home to Dalénum
  boatSiteId: 9255,    // Dalénum
  boatLine: 80,
  boatDirection: 2,    // towards Nybroplan (passes Saltsjöqvarn)
  boatTravelTime: 25,  // min Dalénum → Saltsjöqvarn (via Ropsten, Nacka Strand)
  bikeFromBoat: 12,    // min bike from Saltsjöqvarn to Åsögatan 122
};

const JOURNEY_API = 'https://journeyplanner.integration.sl.se/v2/trips';
const API_BASE = 'https://transport.integration.sl.se/v1/sites';
const MAX_DEPARTURES = 8;
const MAX_MINUTES = 30;
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
};

function cleanDestination(name) {
  return DESTINATION_NAMES[name] || name;
}

/* ---- Journey planner ---- */

const MODE_ICONS = {
  1: '🚇', 2: '🚇', 4: '🚃', 5: '🚌', 6: '🚌',
  7: '⛴', 9: '🚆', 99: '🚶', 100: '🚶',
};

async function fetchJourneys(from, to, count = 3) {
  const params = new URLSearchParams({
    type_origin: 'any',
    name_origin: from,
    type_destination: 'any',
    name_destination: to,
    calc_number_of_trips: String(count),
    language: 'sv',
  });
  const res = await fetch(`${JOURNEY_API}?${params}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return (data.journeys || []).slice(0, count);
}

async function fetchBikeBoatRoutes() {
  const res = await fetch(`${API_BASE}/${BIKE_ROUTE.boatSiteId}/departures`);
  if (!res.ok) return [];
  const data = await res.json();
  const boats = (data.departures || []).filter(
    (d) => d.line?.id === BIKE_ROUTE.boatLine && d.direction_code === BIKE_ROUTE.boatDirection
  );

  const now = new Date();
  return boats.slice(0, 2).map((boat) => {
    const scheduled = new Date(boat.scheduled);
    const leaveHome = new Date(scheduled.getTime() - BIKE_ROUTE.bikeToBoat * 60000);
    const arrSaltsjoquvarn = new Date(scheduled.getTime() + BIKE_ROUTE.boatTravelTime * 60000);
    const arrWork = new Date(arrSaltsjoquvarn.getTime() + BIKE_ROUTE.bikeFromBoat * 60000);
    const totalMin = Math.round((arrWork - leaveHome) / 60000);

    // Skip if we'd need to leave before now
    if (leaveHome < now - 60000) return null;

    return {
      depTime: `${pad(leaveHome.getHours())}:${pad(leaveHome.getMinutes())}`,
      arrTime: `${pad(arrWork.getHours())}:${pad(arrWork.getMinutes())}`,
      boatDep: `${pad(scheduled.getHours())}:${pad(scheduled.getMinutes())}`,
      totalMin,
      label: 'bike',
    };
  }).filter(Boolean);
}

function renderLeg(leg) {
  const tp = leg.transportation?.product;
  const iconId = tp?.iconId || 100;
  const icon = MODE_ICONS[iconId] || '🚶';
  const line = leg.transportation?.disassembledName || '';
  const isWalk = iconId >= 99;

  if (isWalk && !line) {
    const mins = Math.round(leg.duration / 60);
    if (mins <= 1) return '';
    return `<span class="route-leg walk">${icon} ${mins}m</span>`;
  }

  return `<span class="route-leg transit">${icon} ${esc(line)}</span>`;
}

function renderJourney(journey) {
  const legs = journey.legs || [];
  const firstDep = legs[0]?.origin?.departureTimePlanned || '';
  const lastArr = legs[legs.length - 1]?.destination?.arrivalTimePlanned || '';
  const depTime = firstDep.slice(11, 16);
  const arrTime = lastArr.slice(11, 16);
  const totalMin = Math.round(journey.tripDuration / 60);

  const legHtml = legs.map(renderLeg).filter(Boolean).join('<span class="route-arrow">→</span>');

  return `
    <div class="route-journey">
      <div class="route-times">
        <span class="route-dep">${esc(depTime)}</span>
        <span class="route-dur">${totalMin} min</span>
        <span class="route-arr">${esc(arrTime)}</span>
      </div>
      <div class="route-legs">${legHtml}</div>
    </div>`;
}

function renderBikeBoatJourney(route) {
  return `
    <div class="route-journey">
      <div class="route-times">
        <span class="route-dep">${esc(route.depTime)}</span>
        <span class="route-dur">${route.totalMin} min</span>
        <span class="route-arr">${esc(route.arrTime)}</span>
      </div>
      <div class="route-legs">
        <span class="route-leg walk">🚲 ${BIKE_ROUTE.bikeToBoat}m</span>
        <span class="route-arrow">→</span>
        <span class="route-leg transit">⛴ 80</span>
        <span class="route-arrow">→</span>
        <span class="route-leg walk">🚲 ${BIKE_ROUTE.bikeFromBoat}m</span>
      </div>
    </div>`;
}

function buildRouteCard(label, allRoutes) {
  if (!allRoutes.length) return '';
  allRoutes.sort((a, b) => a.dep.localeCompare(b.dep));
  const html = allRoutes.map((r) =>
    r.type === 'transit' ? renderJourney(r.data) : renderBikeBoatJourney(r.data)
  ).join('');
  return `
    <div class="route-card">
      <div class="route-header">${label}</div>
      ${html}
    </div>`;
}

async function refreshRoute() {
  try {
    const [toWork, toHome, bikeToWork] = await Promise.all([
      fetchJourneys(ROUTE.origin, ROUTE.destination, 3),
      fetchJourneys(ROUTE.destination, ROUTE.origin, 3),
      fetchBikeBoatRoutes(),
    ]);

    // To work: transit + bike+boat options
    const toWorkRoutes = [];
    for (const j of toWork) {
      const dep = j.legs?.[0]?.origin?.departureTimePlanned?.slice(11, 16) || '99:99';
      toWorkRoutes.push({ type: 'transit', data: j, dep });
    }
    for (const b of bikeToWork) {
      toWorkRoutes.push({ type: 'bike', data: b, dep: b.depTime });
    }

    // To home: transit only
    const toHomeRoutes = toHome.map((j) => ({
      type: 'transit',
      data: j,
      dep: j.legs?.[0]?.origin?.departureTimePlanned?.slice(11, 16) || '99:99',
    }));

    routeCardEl.innerHTML =
      buildRouteCard('Larsbergsvägen 27 → Åsögatan 122', toWorkRoutes) +
      buildRouteCard('Åsögatan 122 → Larsbergsvägen 27', toHomeRoutes);
  } catch (err) {
    console.error('Failed to fetch routes:', err);
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
    source.lines.includes(dep.line?.id) &&
    (!source.directions || source.directions.includes(dep.direction_code)) &&
    minutesUntil(dep) <= MAX_MINUTES
  );
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
  return `
    <div class="departure-row">
      <span class="destination">${esc(cleanDestination(dep.destination))}</span>
      <span class="time${isNow ? ' now' : ''}">${esc(dep.display)}</span>
    </div>`;
}

function renderLine({ line, departures }, dimmed) {
  const rows = departures.length
    ? departures.map(renderDeparture).join('')
    : '<div class="no-departures">Inga avgångar</div>';

  return `
    <section class="stop-section${dimmed ? ' dimmed' : ''}">
      <div class="stop-header"><span class="line-badge" style="background:${line.color}">${esc(line.name)}</span></div>
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
    ...LINES.map(fetchLine),
  ]);
  const html = lineResults.map((result, i) => {
    const dimmed = relevant !== null && !relevant.includes(LINES[i].name);
    if (result.status === 'fulfilled') {
      return renderLine(result.value, dimmed);
    }
    console.error(`Failed to fetch ${LINES[i].name}:`, result.reason);
    return `
      <section class="stop-section${dimmed ? ' dimmed' : ''}">
        <div class="stop-header"><span class="line-badge" style="background:${LINES[i].color}">${esc(LINES[i].name)}</span></div>
        <div class="no-departures">Kunde inte hämta avgångar</div>
      </section>`;
  });
  departuresEl.innerHTML = html.join('');
  updateTimestamp();
}

refresh();
setInterval(refresh, REFRESH_INTERVAL);
