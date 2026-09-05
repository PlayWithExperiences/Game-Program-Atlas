const DEFAULT_MAP_CENTER = [24, 8];
const DEFAULT_MAP_ZOOM = 2;
const PUBLIC_DATA_VERSION = "gpa-20260905b";
const publicDataUrl = (filename) => `${filename}?v=${PUBLIC_DATA_VERSION}`;
const WORLD_BOUNDS = L.latLngBounds(
  L.latLng(-85.05112878, -180),
  L.latLng(85.05112878, 180),
);
const WORLD_TILE_SIZE = 256;
const DRAG_THRESHOLD = 4;
const TILE_URL = new URLSearchParams(window.location.search).get("tiles") === "offline"
  ? "/__atlas_tile_failure__/{z}/{x}/{y}.png"
  : "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const state = {
  data: null,
  organizations: [],
  rootOrganizations: [],
  organizationById: new Map(),
  cityByKey: new Map(),
  programsByOrganization: new Map(),
  peopleById: new Map(),
  personEvidence: new Map(),
  personEvidenceStatus: "not_loaded",
  personEvidencePromise: null,
  personEvidenceError: null,
  currentEmployment: new Map(),
  employmentByOrganization: new Map(),
  selectedCountries: new Set(),
  map: null,
  tileLayer: null,
  markerLayer: null,
  markerByOrganization: new Map(),
  guideCountrySelection: null,
  orgLinks: [],
  linkLayer: null,
  linksVisible: true,
  baseMapAvailable: null,
  suppressMarkerClickUntil: 0,
  drag: null,
  selectedId: null,
  mapLayoutFrame: null,
  resizeTimer: null,
};
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function element(name, className, text) {
  const node = document.createElement(name);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function normalizedName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function degreeLevel(value) {
  const normalized = String(value || "").toLocaleLowerCase();
  if (["phd", "doctoral", "doctorate"].includes(normalized)) return "phd";
  if (["master", "masters", "ma", "msc", "mfa"].includes(normalized)) return "master";
  return "unbound";
}

function uniqueById(items) {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function buildModel(data) {
  state.data = data;
  state.organizations = data.organizations;
  state.organizationById = new Map(data.organizations.map((item) => [item.id, item]));
  state.cityByKey = new Map(data.cities.map((city) => [city.key, city]));
  state.peopleById = new Map(data.people.map((person) => [person.id, person]));
  state.personEvidence = new Map();
  const legacyEvidencePeople = data.people.filter((person) => (
    Array.isArray(person.supervision?.eligibility_evidence)
    || Array.isArray(person.supervision?.accepting_evidence)
  ));
  legacyEvidencePeople.forEach((person) => {
    state.personEvidence.set(person.id, {
      eligibility_evidence: person.supervision.eligibility_evidence || [],
      accepting_evidence: person.supervision.accepting_evidence || [],
    });
  });
  state.personEvidenceStatus = legacyEvidencePeople.length ? "loaded" : "not_loaded";
  state.personEvidencePromise = null;
  state.personEvidenceError = null;
  state.programsByOrganization = new Map();
  data.programs.forEach((program) => {
    const organizationIds = program.organization_ids || [];
    organizationIds.forEach((organizationId) => {
      if (!state.programsByOrganization.has(organizationId)) state.programsByOrganization.set(organizationId, []);
      state.programsByOrganization.get(organizationId).push(program);
    });
  });
  state.currentEmployment = new Map();
  state.employmentByOrganization = new Map();
  data.graph.employment_edges.filter((edge) => edge.current).forEach((edge) => {
    if (!state.currentEmployment.has(edge.organization_id)) state.currentEmployment.set(edge.organization_id, new Set());
    state.currentEmployment.get(edge.organization_id).add(edge.person_id);
    if (!state.employmentByOrganization.has(edge.organization_id)) state.employmentByOrganization.set(edge.organization_id, new Map());
    state.employmentByOrganization.get(edge.organization_id).set(edge.person_id, edge);
  });
  state.organizations.forEach((organization) => {
    organization.directPrograms = state.programsByOrganization.get(organization.id) || [];
    organization.directTeacherIds = state.currentEmployment.get(organization.id) || new Set();
    organization.cityCoordinate = state.cityByKey.get(organization.city_key) || null;
  });
  state.rootOrganizations = state.organizations
    .filter((organization) => organization.root_id === organization.id)
    .sort((a, b) => a.id.localeCompare(b.id));
  state.rootOrganizations.forEach((root) => {
    root.memberOrganizations = state.organizations.filter((organization) => organization.root_id === root.id);
    root.programs = uniqueById(root.memberOrganizations.flatMap((organization) => organization.directPrograms));
    root.degreeLevels = new Set(root.programs.map((program) => degreeLevel(program.degree_level)));
    root.teacherIds = new Set(root.memberOrganizations.flatMap((organization) => [...organization.directTeacherIds]));
    root.cityCoordinate = root.cityCoordinate || root.memberOrganizations.map((item) => item.cityCoordinate).find(Boolean) || null;
  });
  state.selectedCountries = new Set(
    state.rootOrganizations.map((organization) => organization.country).filter(Boolean),
  );
  state.orgLinks = Array.isArray(data.org_links) ? data.org_links : [];
}

function markerKind(organization) {
  if (organization.degreeLevels.has("phd") && organization.degreeLevels.has("master")) return "both";
  if (organization.degreeLevels.has("phd")) return "phd";
  if (organization.degreeLevels.has("master")) return "master";
  return "unbound";
}

function markerVisible(organization) {
  const checked = new Set($$(".degree-filters input:checked").map((input) => input.value));
  const kind = markerKind(organization);
  const degreeMatches = kind === "both" ? checked.has("phd") || checked.has("master") : checked.has(kind);
  return degreeMatches && state.selectedCountries.has(organization.country);
}

function stableCityIndex(organization) {
  return state.rootOrganizations
    .filter((candidate) => candidate.city_key === organization.city_key)
    .sort((a, b) => a.id.localeCompare(b.id))
    .findIndex((candidate) => candidate.id === organization.id);
}

function escaped(value) {
  return String(value || "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[character]));
}

function markerCoordinate(organization) {
  const city = organization.cityCoordinate;
  const index = stableCityIndex(organization);
  if (index <= 0) return [Number(city.latitude), Number(city.longitude)];
  const angle = index * 2.399963;
  const radiusKm = Math.min(1.8, 0.36 * Math.sqrt(index));
  const latitude = Number(city.latitude) + Math.sin(angle) * radiusKm / 111.32;
  const longitudeScale = Math.max(0.25, Math.cos(Number(city.latitude) * Math.PI / 180));
  const longitude = Number(city.longitude) + Math.cos(angle) * radiusKm / (111.32 * longitudeScale);
  return [latitude, longitude];
}

function markerMatchesSearch(organization) {
  const query = $("#search").value.trim().toLocaleLowerCase();
  return !query || searchText(organization).includes(query);
}

function renderMarkers() {
  if (!state.markerLayer) return;
  state.markerLayer.clearLayers();
  state.markerByOrganization.clear();
  state.rootOrganizations
    .filter((organization) => organization.cityCoordinate)
    .filter((organization) => markerVisible(organization) && markerMatchesSearch(organization))
    .forEach((organization) => {
      const kind = markerKind(organization);
      const label = organization.name.length > 30
        ? `${organization.name.slice(0, 29)}…`
        : organization.name;
      const title = `${organization.name} · ${organization.city || "地点未核"}`;
      const icon = L.divIcon({
        className: `institution-marker ${kind}`,
        html: `<span class="institution-marker-shell" title="${escaped(title)}"><i class="marker-dot"></i><span class="marker-label">${escaped(label)}</span></span>`,
        iconSize: [1, 1],
        iconAnchor: [0, 0],
      });
      const marker = L.marker(markerCoordinate(organization), {
        icon,
        keyboard: true,
        title,
        alt: title,
        riseOnHover: true,
      });
      marker.on("click", () => {
        if (performance.now() >= state.suppressMarkerClickUntil) openInstitution(organization.id);
      });
      marker.on("add", () => {
        const iconElement = marker.getElement();
        if (iconElement) iconElement.dataset.id = organization.id;
      });
      state.markerByOrganization.set(organization.id, marker);
      state.markerLayer.addLayer(marker);
    });
}

const LINK_STYLE = {
  study: { color: "#7c5cd6", label: "求学" },
  teach: { color: "#1e9e6a", label: "任教" },
  collab: { color: "#c2185b", label: "学术合作" },
};

function linkTooltipText(link, nameA, nameB) {
  const parts = Object.keys(LINK_STYLE)
    .filter((kind) => Number(link[kind]) > 0)
    .map((kind) => `${LINK_STYLE[kind].label}×${link[kind]}`);
  const discounted = link.discounted ? "（含历史/兼职关系）" : "";
  return `${nameA} ↔ ${nameB}\n${parts.join(" · ")}${discounted}`;
}

function renderLinks() {
  if (!state.linkLayer) return;
  state.linkLayer.clearLayers();
  const toggle = document.querySelector("#link-toggle");
  state.linksVisible = !toggle || toggle.checked;
  if (!state.linksVisible || !state.orgLinks.length) return;
  state.orgLinks.forEach((link) => {
    const orgA = state.organizationById.get(link.a);
    const orgB = state.organizationById.get(link.b);
    if (!orgA || !orgB || !orgA.cityCoordinate || !orgB.cityCoordinate) return;
    const kinds = Object.keys(LINK_STYLE).filter((kind) => Number(link[kind]) > 0);
    if (!kinds.length) return;
    const baseA = markerCoordinate(orgA);
    const baseB = markerCoordinate(orgB);
    kinds.forEach((kind, index) => {
      const offset = (index - (kinds.length - 1) / 2) * 0.12;
      const line = L.polyline(
        [[baseA[0] + offset, baseA[1]], [baseB[0] + offset, baseB[1]]],
        {
          color: LINK_STYLE[kind].color,
          weight: 1.5,
          opacity: 0.65,
          dashArray: link.discounted ? "4 3" : null,
          interactive: true,
        },
      );
      line.bindTooltip(linkTooltipText(link, orgA.name, orgB.name));
      state.linkLayer.addLayer(line);
    });
  });
}

function renderCountryFilters() {
  const container = $("#country-options");
  container.replaceChildren();
  const countries = [...new Set(
    state.rootOrganizations.map((organization) => organization.country).filter(Boolean),
  )].sort((a, b) => a.localeCompare(b, "zh-CN"));
  countries.forEach((country) => {
    const label = element("label", "country-option");
    const input = element("input");
    input.type = "checkbox";
    input.value = country;
    input.checked = state.selectedCountries.has(country);
    input.addEventListener("change", () => {
      if (input.checked) state.selectedCountries.add(country);
      else state.selectedCountries.delete(country);
      renderMarkers();
      scheduleMapLayout({ fit: true, animate: false });
      renderInstitutionList();
      const tablePanel = document.querySelector("#table-panel");
      if (tablePanel && !tablePanel.hidden) renderTable();
    });
    label.append(input, document.createTextNode(country));
    container.append(label);
  });
}

function visibleMarkerCoordinates() {
  return state.rootOrganizations
    .filter((organization) => organization.cityCoordinate)
    .filter((organization) => markerVisible(organization) && markerMatchesSearch(organization))
    .map(markerCoordinate);
}

function fitToMarkers(options = {}) {
  if (!state.map) return false;
  const coordinates = visibleMarkerCoordinates();
  if (!coordinates.length) return false;
  if (coordinates.length === 1) {
    state.map.setView(coordinates[0], Math.min(8, state.map.getMaxZoom()), options);
    return true;
  }
  state.map.fitBounds(L.latLngBounds(coordinates), {
    padding: [88, 48],
    maxZoom: 5,
    ...options,
  });
  return true;
}

function minimumWorldZoom() {
  if (!state.map) return 0;
  const size = state.map.getSize();
  const requiredWorldPixels = Math.max(size.x, size.y, WORLD_TILE_SIZE);
  return Math.max(0, Math.ceil(Math.log2(requiredWorldPixels / WORLD_TILE_SIZE)));
}

function constrainMapToWorld() {
  if (!state.map) return;
  const minimumZoom = minimumWorldZoom();
  state.map.setMinZoom(minimumZoom);
  state.map.setMaxBounds(WORLD_BOUNDS);
  if (state.map.getZoom() < minimumZoom) {
    state.map.setZoom(minimumZoom, { animate: false });
  }
  state.map.panInsideBounds(WORLD_BOUNDS, { animate: false });
}

function scheduleMapLayout({ fit = false, animate = false } = {}) {
  if (!state.map) return;
  state.map.whenReady(() => {
    if (state.mapLayoutFrame !== null) window.cancelAnimationFrame(state.mapLayoutFrame);
    state.mapLayoutFrame = window.requestAnimationFrame(() => {
      state.mapLayoutFrame = window.requestAnimationFrame(() => {
        state.mapLayoutFrame = null;
        state.map.invalidateSize({ animate: false });
        constrainMapToWorld();
        if (fit) fitToMarkers({ animate });
      });
    });
  });
}

function resetViewport() {
  if (fitToMarkers({ animate: true })) return;
  state.map?.setView(DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM, { animate: true });
}

function tidyCoverageText(text) {
  return String(text || "")
    .replace(/。\s*；/g, "；")
    .replace(/；\s*。/g, "。")
    .replace(/；\s*$/, "。")
    .replace(/\s*；\s*/g, "；")
    .replace(/。{2,}/g, "。");
}

function setBaseMapAvailability(available) {
  state.baseMapAvailable = available;
  $("#world-map").classList.toggle("is-basemap-unavailable", !available);
  $("#fallback-map").setAttribute("aria-hidden", String(available));
  const status = $("#map-status");
  status.textContent = available
    ? "OpenStreetMap 底图已加载"
    : "地图底图不可用 · 已切换 Natural Earth，机构标记仍可使用";
  status.hidden = available;
}

function installMapNavigation() {
  const map = $("#world-map");
  // Pure clicks must remain targeted at marker icons. Capture only after the
  // pointer has crossed the drag threshold, then suppress the synthetic click.
  map.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    state.drag = {
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      active: false,
    };
  });
  map.addEventListener("pointermove", (event) => {
    if (!state.drag || state.drag.pointerId !== event.pointerId) return;
    if (state.drag.active) return;
    const moved = Math.hypot(
      event.clientX - state.drag.originX,
      event.clientY - state.drag.originY,
    );
    if (moved < DRAG_THRESHOLD) return;
    state.drag.active = true;
    map.setPointerCapture(event.pointerId);
    map.classList.add("is-dragging");
  });
  const stopDragging = (event) => {
    if (!state.drag || state.drag.pointerId !== event.pointerId) return;
    if (state.drag.active) {
      state.suppressMarkerClickUntil = performance.now() + 300;
      if (map.hasPointerCapture(event.pointerId)) map.releasePointerCapture(event.pointerId);
    }
    state.drag = null;
    map.classList.remove("is-dragging");
  };
  map.addEventListener("pointerup", stopDragging);
  map.addEventListener("pointercancel", stopDragging);
  $("#zoom-reset").addEventListener("click", resetViewport);
}

function initializeMap(geojson) {
  state.map = L.map("leaflet-map", {
    center: DEFAULT_MAP_CENTER,
    zoom: DEFAULT_MAP_ZOOM,
    minZoom: 0,
    maxZoom: 18,
    maxBounds: WORLD_BOUNDS,
    maxBoundsViscosity: 1,
    worldCopyJump: true,
    zoomControl: true,
    attributionControl: false,
  });
  state.map.createPane("fallbackPane");
  state.map.getPane("fallbackPane").classList.add("leaflet-fallback-pane");
  state.map.getPane("fallbackPane").style.zIndex = "190";
  L.geoJSON(geojson, {
    pane: "fallbackPane",
    interactive: false,
    style: { className: "fallback-land" },
  }).addTo(state.map);

  let tileErrors = 0;
  let tileLoads = 0;
  const timeoutId = window.setTimeout(() => {
    if (state.baseMapAvailable === null) setBaseMapAvailability(false);
  }, 8000);
  state.tileLayer = L.tileLayer(TILE_URL, {
    minZoom: 0,
    maxZoom: 19,
    maxNativeZoom: 19,
    noWrap: true,
    keepBuffer: 2,
    updateWhenIdle: true,
    attribution: "© OpenStreetMap contributors",
  });
  state.tileLayer.on("tileerror", () => {
    tileErrors += 1;
    if (tileErrors >= 3) setBaseMapAvailability(false);
  });
  state.tileLayer.on("tileload", () => {
    tileLoads += 1;
    if (tileLoads < 3) return;
    tileErrors = 0;
    window.clearTimeout(timeoutId);
    setBaseMapAvailability(true);
  });
  state.tileLayer.on("load", () => {
    if (tileLoads === 0 || tileErrors > 0) return;
    window.clearTimeout(timeoutId);
    setBaseMapAvailability(true);
  });
  state.tileLayer.addTo(state.map);

  state.markerLayer = L.markerClusterGroup({
    disableClusteringAtZoom: 12,
    maxClusterRadius: 48,
    showCoverageOnHover: false,
    spiderfyOnMaxZoom: true,
    removeOutsideVisibleBounds: true,
    iconCreateFunction: (cluster) => L.divIcon({
      className: "atlas-cluster",
      html: `<span aria-label="${cluster.getChildCount()} 个机构">${cluster.getChildCount()}</span>`,
      iconSize: [34, 34],
    }),
  });
  state.linkLayer = L.layerGroup();
  state.map.addLayer(state.linkLayer);
  state.map.addLayer(state.markerLayer);
  scheduleMapLayout();
}

function locationLabel(organization) {
  if (!organization.city) return "地点未核";
  return [countryDisplayLabel(organization.country), organization.region, organization.city].filter(Boolean).join(" / ");
}

function degreeLabel(organization) {
  const labels = [];
  if (organization.degreeLevels.has("phd")) labels.push("博士");
  if (organization.degreeLevels.has("master")) labels.push("硕士");
  return labels.length ? labels.join(" + ") : "未关联学位项目记录";
}

function searchText(organization) {
  const teachers = [...organization.teacherIds].map((id) => state.peopleById.get(id)?.name || "");
  const members = organization.memberOrganizations.map((item) => item.name);
  const programs = organization.programs.map((item) => item.name);
  return [organization.name, organization.country, organization.city, organization.region, ...members, ...programs, ...teachers].join(" ").toLocaleLowerCase();
}

function renderInstitutionList() {
  const query = $("#search").value.trim().toLocaleLowerCase();
  const list = $("#institution-list");
  list.replaceChildren();
  const visible = state.rootOrganizations.filter((organization) => (
    markerVisible(organization) && (!query || searchText(organization).includes(query))
  ));
  visible.forEach((organization) => {
    const row = element("li", "institution-row");
    const button = element("button", "institution-button");
    button.type = "button";
    button.append(element("strong", "", organization.name));
    const meta = element("span", "institution-meta");
    meta.append(element("span", organization.cityCoordinate ? "" : "no-coordinate", organization.cityCoordinate ? locationLabel(organization) : "无坐标，未在地图上展示"));
    meta.append(element("span", "", `${degreeLabel(organization)} / ${organization.teacherIds.size} 位教师`));
    button.append(meta);
    button.addEventListener("click", () => openInstitution(organization.id));
    row.append(button);
    list.append(row);
  });
  if (!visible.length) list.append(element("li", "institution-button", "没有匹配机构"));
}

function evidenceLinks(container, evidence, prefix) {
  evidence.forEach((item, index) => {
    try {
      const url = new URL(item.source_url, window.location.href);
      if (!["http:", "https:"].includes(url.protocol)) return;
      const link = element("a", "", `${prefix}来源 ${index + 1}`);
      link.href = url.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.title = item.excerpt || "官方来源";
      container.append(link);
    } catch (_) { /* Unsupported URLs stay absent. */ }
  });
}

function groupedEvidence(evidence) {
  const sources = new Map();
  evidence.forEach((item) => {
    try {
      const url = new URL(item.source_url, window.location.href);
      if (!["http:", "https:"].includes(url.protocol)) return;
      if (!sources.has(url.href)) sources.set(url.href, []);
      const excerpt = String(item.excerpt || "").trim();
      if (excerpt && !sources.get(url.href).includes(excerpt)) {
        sources.get(url.href).push(excerpt);
      }
    } catch (_) { /* Unsupported URLs stay absent. */ }
  });
  return [...sources.entries()].map(([sourceUrl, excerpts]) => ({ sourceUrl, excerpts }));
}

function teacherEvidence(evidence) {
  const container = element("div", "teacher-evidence");
  groupedEvidence(evidence).forEach(({ sourceUrl, excerpts }) => {
    const source = element("section", "evidence-source");
    const link = element("a", "", "已查来源");
    link.href = sourceUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    source.append(link);
    excerpts.forEach((excerpt) => source.append(element("blockquote", "evidence-quote", excerpt)));
    container.append(source);
  });
  return container;
}

function personEvidence(person) {
  return state.personEvidence.get(person.id) || {
    eligibility_evidence: [],
    accepting_evidence: [],
  };
}

function ensurePersonEvidence() {
  if (state.personEvidenceStatus === "loaded") return Promise.resolve();
  if (state.personEvidencePromise) return state.personEvidencePromise;
  state.personEvidenceStatus = "loading";
  state.personEvidencePromise = fetch(publicDataUrl("atlas-person-evidence.json"))
    .then((response) => {
      if (!response.ok) throw new Error("导师证据读取失败：" + response.status);
      return response.json();
    })
    .then((payload) => {
      if (
        payload?.schema_version !== "game-program-atlas-person-evidence-v1"
        || !payload.people || typeof payload.people !== "object"
        || Object.keys(payload.people).length !== state.peopleById.size
      ) {
        throw new Error("导师证据索引不完整");
      }
      state.personEvidence = new Map(
        Object.entries(payload.people).map(([personId, evidence]) => [personId, {
          eligibility_evidence: Array.isArray(evidence?.eligibility_evidence)
            ? evidence.eligibility_evidence : [],
          accepting_evidence: Array.isArray(evidence?.accepting_evidence)
            ? evidence.accepting_evidence : [],
        }]),
      );
      state.personEvidenceStatus = "loaded";
      state.personEvidenceError = null;
      if (state.selectedId) openInstitution(state.selectedId, { requestEvidence: false });
    })
    .catch((error) => {
      state.personEvidenceStatus = "failed";
      state.personEvidenceError = error;
      if (state.selectedId) openInstitution(state.selectedId, { requestEvidence: false });
    });
  return state.personEvidencePromise;
}

const eligibilityLabels = {
  principal_eligible: "可作为该路线主导师",
  advisor_only: "该路线仅可协助指导",
  not_eligible: "该院系无博士培养路线",
  unverified: "未核",
};
const acceptingLabels = { accepting: "在招", not_accepting: "当前不招", unknown: "未核" };

function teacherItem(person, employment) {
  const item = element("li", "teacher-item");
  item.append(element("strong", "", person.name));
  if (person.supervision.current_title) item.append(element("span", "empty-copy", person.supervision.current_title));
  if (employment) {
    const role = employment.role || "职称未核";
    const unit = employment.unit || "所属子单位未核";
    item.append(element("p", "employment-fact", `该单位任职 · ${role} · ${unit}`));
  }
  const conclusions = element("div", "teacher-conclusions");
  const statuses = element("dl", "teacher-status");
  const addStatus = (title, value, observationState) => {
    const block = element("div", `status-block ${observationState}`);
    const stateLabel = state.data.tri_state_model[observationState] || observationState;
    block.append(element("dt", "", `${title} · ${stateLabel}`));
    block.append(element("dd", "", value));
    statuses.append(block);
  };
  addStatus("指导资格", eligibilityLabels[person.supervision.supervision_eligibility] || "未核", person.supervision.eligibility_observation_state);
  addStatus("当前在招", acceptingLabels[person.supervision.currently_accepting] || "未核", person.supervision.accepting_observation_state);
  conclusions.append(statuses);
  item.append(conclusions);
  const evidence = employment
    ? [{ source_url: employment.source_url, excerpt: employment.excerpt }]
    : [];
  if (state.personEvidenceStatus === "loaded") {
    const loaded = personEvidence(person);
    evidence.push(...loaded.eligibility_evidence, ...loaded.accepting_evidence);
  }
  const sources = teacherEvidence(evidence);
  if (sources.childElementCount) item.append(sources);
  if (state.personEvidenceStatus === "loading" || state.personEvidenceStatus === "not_loaded") {
    item.append(element("p", "empty-copy", "导师资格与在招证据按需读取中；三态结论已先行显示。"));
  } else if (state.personEvidenceStatus === "failed") {
    item.append(element("p", "empty-copy", "导师证据读取失败；这不等于没有证据，三态结论仍保留。"));
  } else if (!sources.childElementCount) {
    item.append(element("p", "empty-copy", "公开导出中没有可链接证据，三态保持原样。"));
  }
  return item;
}

function programmeSourceLabel(program) {
  return program.official_page_state === "verified"
    ? "最终事实来源 · 学校官方项目页"
    : "学校官方项目页 · 状态未核";
}

function programmeItem(program) {
  const item = element("li", "programme-item");
  if (program.official_url) {
    const link = element("a", "programme-link", program.name);
    link.href = program.official_url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    item.append(link);
  } else {
    item.append(element("strong", "", program.name));
    item.append(element("span", "programme-missing", "官方页未收录"));
  }
  return item;
}

function programmeSection(organization) {
  const section = element("details", "drawer-section");
  section.open = true;
  section.append(element("summary", "drawer-section-title", `① 学位项目 · ${organization.programs.length}`));
  if (!organization.programs.length) {
    section.append(element("p", "empty-copy", "公开数据没有把项目明确绑定到该机构。这里不做名称猜测。"));
    return section;
  }
  const groups = [
    ["phd", "博士项目"],
    ["master", "硕士项目"],
    ["unbound", "其他项目"],
  ];
  groups.forEach(([level, label]) => {
    const programmes = organization.programs.filter((program) => degreeLevel(program.degree_level) === level);
    if (!programmes.length) return;
    const group = element("section", "programme-group");
    group.append(element("h4", "", `${label} ${programmes.length}`));
    const list = element("ol", "programme-list");
    programmes.sort((a, b) => a.name.localeCompare(b.name)).forEach((program) => list.append(programmeItem(program)));
    group.append(list);
    section.append(group);
  });
  return section;
}

function organizationGroups(root) {
  const buckets = new Map();
  root.memberOrganizations.forEach((organization) => {
    const isRootIdentity = normalizedName(organization.name) === normalizedName(root.name);
    const key = isRootIdentity ? `root:${root.id}` : `name:${normalizedName(organization.name)}`;
    if (!buckets.has(key)) {
      buckets.set(key, {
        id: organization.id,
        name: isRootIdentity ? `${root.name}（根机构直属）` : organization.name,
        type: isRootIdentity ? "root" : organization.type,
        hasParent: Boolean(organization.parent_id),
        teacherIds: new Set(),
        employmentByPerson: new Map(),
        teacherCoverageState: organization.teacher_coverage_state,
        rosterEvidence: organization.teacher_roster_evidence || [],
      });
    }
    const bucket = buckets.get(key);
    if (organization.parent_id && !bucket.hasParent) {
      bucket.id = organization.id;
      bucket.type = organization.type;
      bucket.hasParent = true;
    }
    organization.directTeacherIds.forEach((personId) => bucket.teacherIds.add(personId));
    const employment = state.employmentByOrganization.get(organization.id) || new Map();
    employment.forEach((edge, personId) => bucket.employmentByPerson.set(personId, edge));
  });
  return [...buckets.values()].sort((a, b) => {
    if (a.type === "root") return -1;
    if (b.type === "root") return 1;
    return a.name.localeCompare(b.name);
  });
}

function emptyTeacherCopy(group) {
  if (group.teacherCoverageState === "official_faculty_page_not_found") {
    return "0 位教师；官方师资页未找到。已记录查找入口，不把空白解释为该校没有教师。";
  }
  if (group.teacherCoverageState === "source_unavailable") {
    return "0 位教师；官方师资来源暂不可用。抓取失败不等于没有教师。";
  }
  if (group.teacherCoverageState === "official_faculty_page_found") {
    return "0 位教师；官方师资页已查，但尚未抽取到可核的当前教师记录。";
  }
  return "0 位教师；教师待抓取。公开记录为空不代表该单位没有教师。";
}

function groupsSection(root) {
  const section = element("details", "drawer-section");
  section.open = true;
  const groups = organizationGroups(root);
  section.append(element("summary", "drawer-section-title", `② 研究组 / 部门 · ${groups.length}`));
  const list = element("ol", "organization-group-list");
  groups.forEach((group) => {
    const item = element("li");
    const groupDetails = element("details", "organization-group-item");
    groupDetails.open = false;
    const heading = element("summary", "organization-group-heading");
    heading.append(element("strong", "", group.name));
    heading.append(element("span", "", `${group.teacherIds.size} 位教师`));
    groupDetails.append(heading);
    groupDetails.append(element(
      "p",
      "empty-copy organization-group-copy",
      group.teacherIds.size
        ? `已收录 ${group.teacherIds.size} 位教师；在导师段展开查看结论与来源。`
        : emptyTeacherCopy(group),
    ));
    if (!group.teacherIds.size && group.rosterEvidence.length) {
      groupDetails.append(teacherEvidence(group.rosterEvidence));
    }
    item.append(groupDetails);
    list.append(item);
  });
  section.append(list);
  return section;
}

function mentorsSection(root) {
  const section = element("details", "drawer-section");
  section.open = true;
  const groups = organizationGroups(root);
  section.append(element("summary", "drawer-section-title", `③ 导师 · ${root.teacherIds.size}`));
  const list = element("ol", "organization-group-list mentor-groups");
  groups.forEach((group) => {
    const item = element("li");
    const groupDetails = element("details", "organization-group-item");
    groupDetails.open = false;
    const heading = element("summary", "organization-group-heading");
    heading.append(element("strong", "", group.name));
    heading.append(element("span", "", `${group.teacherIds.size} 位教师`));
    groupDetails.append(heading);
    if (group.teacherIds.size) {
      const teachers = element("ol", "teacher-list");
      [...group.teacherIds]
        .map((id) => state.peopleById.get(id))
        .filter(Boolean)
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach((person) => teachers.append(teacherItem(person, group.employmentByPerson.get(person.id))));
      groupDetails.append(teachers);
    } else {
      groupDetails.append(element("p", "empty-copy organization-group-copy", emptyTeacherCopy(group)));
      if (group.rosterEvidence.length) groupDetails.append(teacherEvidence(group.rosterEvidence));
    }
    item.append(groupDetails);
    list.append(item);
  });
  section.append(list);
  return section;
}

function openInstitution(organizationId, { requestEvidence = true } = {}) {
  const selected = state.organizationById.get(organizationId);
  const organization = selected ? state.organizationById.get(selected.root_id) : null;
  if (!organization) return;
  state.selectedId = organization.id;
  $("#drawer-location").textContent = organization.cityCoordinate ? locationLabel(organization) : "无坐标，未在地图上展示";
  $("#drawer-title").textContent = organization.name;
  const body = $("#drawer-body");
  body.replaceChildren();
  if (organization.location_evidence?.length) {
    const sources = element("div", "coordinate-source");
    evidenceLinks(sources, organization.location_evidence, "机构地点");
    if (organization.cityCoordinate?.source_url) {
      evidenceLinks(sources, [{ source_url: organization.cityCoordinate.source_url }], "城市坐标");
    }
    body.append(sources);
  }
  body.append(programmeSection(organization));
  body.append(groupsSection(organization));
  body.append(mentorsSection(organization));
  $("#institution-drawer").setAttribute("aria-hidden", "false");
  $("#drawer-scrim").hidden = false;
  window.location.hash = `institution=${encodeURIComponent(organization.id)}`;
  if (requestEvidence) void ensurePersonEvidence();
}

function closeDrawer() {
  $("#institution-drawer").setAttribute("aria-hidden", "true");
  $("#drawer-scrim").hidden = true;
}

function renderCoverage() {
  const locatedRecords = state.organizations.filter((organization) => organization.cityCoordinate);
  const locatedRoots = state.rootOrganizations.filter((organization) => organization.cityCoordinate);
  const countries = new Set(locatedRoots.map((organization) => organization.country));
  const phdCount = state.data.programs.filter((program) => degreeLevel(program.degree_level) === "phd").length;
  const masterCount = state.data.programs.filter((program) => degreeLevel(program.degree_level) === "master").length;
  $("#metric-organizations").textContent = String(state.rootOrganizations.length);
  $("#metric-countries").textContent = String(countries.size);
  $("#metric-people").textContent = String(state.data.people.length);
  $("#metric-programs").textContent = String(state.data.programs.length);
  $("#degree-counts").textContent = `博士 ${phdCount} / 硕士 ${masterCount}`;
  const registryCoverage = "中国博士登记 65 所：已核 65，游戏路径 4、无游戏路径 61、来源不可达 0、待查 0；美国博士登记 15 所：已核 15，游戏路径 11、无游戏路径 4、来源不可达 0、待查 0；中国硕士登记 263 所：已核 3，游戏路径 0、无游戏路径 3、来源不可达 0、待查 260；美国硕士登记 102 所：已核 10，游戏路径 4、无游戏路径 6、来源不可达 0、待查 92。";
  // Faculty coverage is the weakest part of this dataset and the easiest to
  // mistake for completeness, so it is stated up front rather than left to be
  // discovered by clicking through institutions one at a time.
  const rootsWithPrograms = state.rootOrganizations.filter((organization) => organization.programs.length);
  const withoutTeachers = rootsWithPrograms.filter((organization) => !organization.teacherIds.size).length;
  const thinTeachers = rootsWithPrograms.filter((organization) => organization.teacherIds.size > 0
    && organization.teacherIds.size <= 2).length;
  $("#coverage-statement").textContent = tidyCoverageText(
    `${registryCoverage} 当前公开 ${state.rootOrganizations.length} 个根机构、${countries.size} 个国家 / 地区、${state.data.programs.length} 个经官方页面核实的学位项目。`,
  );
  $("#faculty-gap").textContent = rootsWithPrograms.length
    ? `教师名册远未查全：${rootsWithPrograms.length} 个有学位项目的机构里，`
      + `${withoutTeachers} 所还没有任何教师记录、${thinTeachers} 所只有 1–2 位。`
      + `教师数为 0 表示尚未查到名册，不表示该机构没有教师。`
    : "";
  $("#map-coverage").textContent = `${locatedRoots.length} 个根机构点；${locatedRecords.length} / ${state.organizations.length} 条机构记录有城市坐标。`;
  $("#coordinate-note").textContent = `${state.organizations.length - locatedRecords.length} 条机构记录无坐标，未在地图上展示，但独立根机构仍保留在列表。`;
  $("#freshness").textContent = `公开数据 ${state.data.schema_version} / ${state.data.generated_at}`;

  const coverage = state.data.graph.coverage;
  const threshold = coverage.usable_threshold;
  const rate = (coverage.mentor_coverage_rate * 100).toFixed(1);
  $("#network-insufficient").textContent = coverage.network_usable
    ? `门禁通过：${coverage.verified_edge_count} 条边，${rate}% 导师覆盖。Atlas v4 暂不展示师承网络或聚类。`
    : `暂时隐藏：${coverage.verified_edge_count} 条边，${rate}% 导师覆盖。门槛为 ${threshold.minimum_verified_edges} 条边且 ${(threshold.minimum_mentor_coverage_rate * 100).toFixed(1)}% 覆盖；Atlas v4 暂不展示师承网络或聚类。`;
  $("#cluster-list").hidden = true;
  $("#cluster-list").replaceChildren();
}

async function start() {
  const [siteDatasetResponse, mapResponse] = await Promise.all([
    fetch(publicDataUrl("atlas-site-data.json")),
    fetch("world-land.geojson"),
  ]);
  const datasetResponse = siteDatasetResponse.ok
    ? siteDatasetResponse
    : await fetch(publicDataUrl("public-dataset.json"));
  if (!datasetResponse.ok) throw new Error(`公开数据读取失败：${datasetResponse.status}`);
  if (!mapResponse.ok) throw new Error(`本地底图读取失败：${mapResponse.status}`);
  const [data, geojson] = await Promise.all([datasetResponse.json(), mapResponse.json()]);
  buildModel(data);
  initializeMap(geojson);
  renderCountryFilters();
  renderMarkers();
  renderLinks();
  scheduleMapLayout({ fit: true, animate: false });
  renderInstitutionList();
  renderCoverage();
  renderDataGuide();
  const hashId = decodeURIComponent(window.location.hash.replace(/^#institution=/, ""));
  if (hashId && state.organizationById.has(hashId)) openInstitution(hashId);
  else if (window.location.hash === "#data-guide") setDataGuideOpen(true);
}


// ------------------------------------------------- data guide system
// Restored 2026-09-05: dropped without record by the 9/4 data publish;
// reinstated verbatim from 9d834ee~1 alongside the org-links layer.
function dataGuideStats() {
  const countryBuckets = new Map();
  state.rootOrganizations.forEach((root) => {
    const country = root.country || "未标注";
    if (!countryBuckets.has(country)) {
      countryBuckets.set(country, {
        organizations: 0,
        programIds: new Set(),
        peopleIds: new Set(),
        roots: [],
        locationStates: { verified: 0, inferred: 0, unverified: 0 },
        locationScopes: new Set(),
      });
    }
    const bucket = countryBuckets.get(country);
    bucket.organizations += 1;
    bucket.roots.push(root);
    const locationState = root.location_state || "unverified";
    if (bucket.locationStates[locationState] === undefined) bucket.locationStates[locationState] = 0;
    bucket.locationStates[locationState] += 1;
    if (root.location_scope) bucket.locationScopes.add(root.location_scope);
    root.programs.forEach((program) => bucket.programIds.add(program.id));
    root.teacherIds.forEach((personId) => bucket.peopleIds.add(personId));
  });
  const verifiedPrograms = state.data.programs.filter((program) => program.official_page_state === "verified");
  const sourceTypes = verifiedPrograms.reduce((counts, program) => {
    const key = program.official_page_source_type || "未标注来源类型";
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
  const projectEvidenceCount = verifiedPrograms.reduce(
    (count, program) => count + (program.official_page_evidence?.length || 0),
    0,
  );
  const degreeBuckets = [
    { key: "phd", label: "博士", count: 0 },
    { key: "master", label: "硕士", count: 0 },
    { key: "unbound", label: "未关联项目记录", count: 0 },
  ];
  state.data.programs.forEach((program) => {
    const bucket = degreeBuckets.find((item) => item.key === degreeLevel(program.degree_level));
    if (bucket) bucket.count += 1;
  });
  const knownCountryRows = [...countryBuckets.entries()]
    .filter(([country]) => country !== "未标注")
    .map(([country, bucket]) => ({ country, organizations: bucket.organizations }))
    .sort((left, right) => (
      right.organizations - left.organizations
      || left.country.localeCompare(right.country, "zh-CN")
    ));
  const unlabeledOrganizations = countryBuckets.get("未标注")?.organizations || 0;
  const countryChart = [
    ...knownCountryRows.map((row) => ({ ...row, countries: [row.country] })),
    ...(unlabeledOrganizations ? [{
      country: "未标注",
      organizations: unlabeledOrganizations,
      countries: ["未标注"],
    }] : []),
  ];
  return {
    organizationRecords: state.organizations.length,
    rootOrganizations: state.rootOrganizations.length,
    knownCountries: [...countryBuckets.keys()].filter((country) => country !== "未标注").length,
    unlabeledOrganizations: countryBuckets.get("未标注")?.organizations || 0,
    programs: state.data.programs.length,
    people: state.data.people.length,
    countryBuckets: [...countryBuckets.entries()]
      .map(([country, bucket]) => ({
        country,
        organizations: bucket.organizations,
        programs: bucket.programIds.size,
        people: bucket.peopleIds.size,
        locationStates: bucket.locationStates,
        locationScopes: [...bucket.locationScopes],
        roots: [...bucket.roots].sort((left, right) => left.name.localeCompare(right.name, "zh-CN")),
      }))
      .sort((left, right) => (
        right.organizations - left.organizations
        || left.country.localeCompare(right.country, "zh-CN")
      )),
    verifiedPrograms: verifiedPrograms.length,
    unverifiedPrograms: state.data.programs.length - verifiedPrograms.length,
    projectEvidenceCount,
    sourceTypes,
    degreeBuckets,
    countryChart,
    locationStates: state.rootOrganizations.reduce((counts, root) => {
      const key = root.location_state || "unverified";
      counts[key] = (counts[key] || 0) + 1;
      return counts;
    }, { verified: 0, inferred: 0, unverified: 0 }),
  };
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

function svgElement(name, attributes = {}) {
  const node = document.createElementNS(SVG_NAMESPACE, name);
  Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
  return node;
}

function formatPercent(value, total) {
  if (!total) return "0.0%";
  return `${((value / total) * 100).toFixed(1)}%`;
}

const LOCATION_STATE_LABELS = {
  verified: "已核实",
  inferred: "已归属·推断",
  unverified: "未标注",
};
const LOCATION_SCOPE_LABELS = {
  single_city: "单城市",
  country_only: "国家级",
  multi_site: "多校区",
  joint_program: "联合项目",
  online: "线上 / 远程",
};

function locationStateLabel(organization) {
  return LOCATION_STATE_LABELS[organization.location_state] || "未标注";
}

function locationScopeLabel(organization) {
  return LOCATION_SCOPE_LABELS[organization.location_scope] || "范围未标注";
}

function guideLocationBadges(organization) {
  const state = organization.location_state || "unverified";
  return [
    element("span", `guide-status-badge guide-status-${state}`, locationStateLabel(organization)),
    element("span", "guide-scope-badge", locationScopeLabel(organization)),
  ];
}

function programClassificationLabels(program, root = null) {
  const organizations = (program.organization_ids || [])
    .map((id) => state.organizationById.get(id))
    .filter(Boolean);
  const name = String(program.name || "");
  const isJoint = new Set(program.organization_ids || []).size > 1
    || organizations.some((organization) => organization.location_scope === "joint_program")
    || /\b(joint|dual|double|collaborative|consortium)\b|联合|混合/i.test(name);
  const isOnline = organizations.some((organization) => organization.location_scope === "online")
    || /\b(online|distance|remote|e-learning)\b|线上|在线|远程|en ligne|en línea/i.test(name);
  const labels = [];
  if (isJoint) labels.push("联合 / 混合项目");
  if (isOnline) labels.push("线上 / 远程");
  return labels;
}

function guideProgramBadges(program, root = null) {
  return programClassificationLabels(program, root).map((label) => (
    element("span", "guide-program-badge", label)
  ));
}

function guideCountryValues(node, fallback = []) {
  const encoded = node.dataset.guideCountries || node.dataset.guideCountry || "";
  const values = encoded.split("\u001f").filter(Boolean);
  return values.length ? values : fallback;
}

function setGuideCountryHover(countries, active) {
  const selected = new Set(countries);
  $$("#guide-country-chart [data-guide-country], #guide-country-legend [data-guide-country], #guide-country-body [data-guide-country]")
    .forEach((node) => {
      const values = guideCountryValues(node);
      node.classList.toggle("is-hovered", active && values.some((country) => selected.has(country)));
    });
}

function bindGuideCountryHover(node, countries) {
  const values = [...new Set(countries || [])].filter(Boolean);
  if (!values.length) return;
  node.dataset.guideCountries = values.join("\u001f");
  const activate = () => setGuideCountryHover(values, true);
  const deactivate = (event) => {
    if (event?.relatedTarget && node.contains(event.relatedTarget)) return;
    setGuideCountryHover(values, false);
  };
  node.addEventListener("pointerenter", activate);
  node.addEventListener("pointerleave", deactivate);
  node.addEventListener("focusin", activate);
  node.addEventListener("focusout", deactivate);
}

function polarPoint(center, radius, angle) {
  return {
    x: center + radius * Math.cos(angle),
    y: center + radius * Math.sin(angle),
  };
}

function donutPath(startAngle, endAngle, center = 110, outerRadius = 82, innerRadius = 52) {
  const fullTurn = Math.PI * 2;
  const span = endAngle - startAngle;
  const outerStart = polarPoint(center, outerRadius, startAngle);
  const innerStart = polarPoint(center, innerRadius, startAngle);
  if (span >= fullTurn - 0.0001) {
    const midAngle = startAngle + Math.PI;
    const outerMid = polarPoint(center, outerRadius, midAngle);
    const innerMid = polarPoint(center, innerRadius, midAngle);
    return [
      `M ${outerStart.x} ${outerStart.y}`,
      `A ${outerRadius} ${outerRadius} 0 1 1 ${outerMid.x} ${outerMid.y}`,
      `A ${outerRadius} ${outerRadius} 0 1 1 ${outerStart.x} ${outerStart.y}`,
      `L ${innerStart.x} ${innerStart.y}`,
      `A ${innerRadius} ${innerRadius} 0 1 0 ${innerMid.x} ${innerMid.y}`,
      `A ${innerRadius} ${innerRadius} 0 1 0 ${innerStart.x} ${innerStart.y}`,
      "Z",
    ].join(" ");
  }
  const outerEnd = polarPoint(center, outerRadius, endAngle);
  const innerEnd = polarPoint(center, innerRadius, endAngle);
  const largeArc = span > Math.PI ? 1 : 0;
  return [
    `M ${outerStart.x} ${outerStart.y}`,
    `A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y}`,
    `L ${innerEnd.x} ${innerEnd.y}`,
    `A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${innerStart.x} ${innerStart.y}`,
    "Z",
  ].join(" ");
}

function clearSvgDrawing(svg) {
  [...svg.children].forEach((child) => {
    if (![
      "title",
      "desc",
    ].includes(child.localName)) child.remove();
  });
}

function guideLegendRow(label, value, total, swatchClass, note = "", onSelect = null) {
  const row = element("li", "guide-chart-legend-row");
  const swatch = element("span", `guide-legend-swatch ${swatchClass}`);
  swatch.setAttribute("aria-hidden", "true");
  const name = element("span", "guide-legend-name", label);
  const valueText = element("span", "guide-legend-value", `${value} · ${formatPercent(value, total)}`);
  row.append(swatch, name, valueText);
  if (note) row.title = note;
  if (onSelect) {
    row.classList.add("guide-legend-interactive");
    row.setAttribute("role", "button");
    row.setAttribute("tabindex", "0");
    row.setAttribute("aria-pressed", "false");
    row.addEventListener("click", onSelect);
    row.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      onSelect();
    });
  }
  return row;
}

function countryChartColorClass(country, index) {
  if (country === "未标注") return "guide-country-unlabeled";
  return `guide-country-${index % 6}`;
}

function renderCountryDonut(countryChart) {
  const chart = $("#guide-country-chart");
  const legend = $("#guide-country-legend");
  state.guideCountrySelection = null;
  const selection = $("#guide-country-selection");
  if (selection) selection.textContent = "悬停或聚焦环图扇区、图例和国家明细，可联动高亮；点击可定位。";
  clearSvgDrawing(chart);
  legend.replaceChildren();
  const total = countryChart.reduce((sum, bucket) => sum + bucket.organizations, 0);
  const center = 110;
  const outerRadius = 82;
  const innerRadius = 52;
  if (!total) {
    const empty = svgElement("circle", {
      class: "guide-donut-empty",
      cx: center,
      cy: center,
      r: outerRadius,
    });
    empty.setAttribute("aria-label", "无可用数据");
    chart.append(empty);
    chart.append(
      svgElement("text", { class: "guide-donut-total", x: center, y: 108 }),
      svgElement("text", { class: "guide-donut-label", x: center, y: 127 }),
    );
    chart.querySelector(".guide-donut-total").textContent = "—";
    chart.querySelector(".guide-donut-label").textContent = "无可用数据";
    legend.append(element("li", "guide-chart-empty", "无可用数据"));
    return;
  }

  let angle = -Math.PI / 2;
  countryChart.forEach((bucket, index) => {
    if (bucket.organizations <= 0) return;
    const nextAngle = angle + (bucket.organizations / total) * Math.PI * 2;
    const colorClass = countryChartColorClass(bucket.country, index);
    const displayCountry = countryDisplayLabel(bucket.country);
    const segment = svgElement("path", {
      class: `guide-donut-segment ${colorClass}`,
      d: donutPath(angle, nextAngle, center, outerRadius, innerRadius),
      tabindex: "0",
    });
    segment.setAttribute("role", "button");
    segment.setAttribute("aria-pressed", "false");
    segment.setAttribute("data-guide-country", bucket.country);
    segment.setAttribute(
      "aria-label",
      `${displayCountry}：${bucket.organizations} 个根机构，占 ${formatPercent(bucket.organizations, total)}`,
    );
    segment.addEventListener("click", () => selectGuideCountryBucket(bucket));
    segment.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      selectGuideCountryBucket(bucket);
    });
    bindGuideCountryHover(segment, bucket.countries);
    chart.append(segment);
    const legendRow = guideLegendRow(
      displayCountry,
      bucket.organizations,
      total,
      colorClass,
      "图表单位为根机构，不表示项目质量或影响力。",
      () => selectGuideCountryBucket(bucket),
    );
    legendRow.setAttribute("data-guide-country", bucket.country);
    bindGuideCountryHover(legendRow, bucket.countries);
    legend.append(legendRow);
    angle = nextAngle;
  });
  const totalText = svgElement("text", { class: "guide-donut-total", x: center, y: 108 });
  totalText.textContent = String(total);
  const labelText = svgElement("text", { class: "guide-donut-label", x: center, y: 127 });
  labelText.textContent = "根机构";
  chart.append(totalText, labelText);
}

function renderDegreeBars(degreeBuckets) {
  const chart = $("#guide-degree-chart");
  const legend = $("#guide-degree-legend");
  clearSvgDrawing(chart);
  legend.replaceChildren();
  const visibleBuckets = degreeBuckets.filter((bucket) => bucket.count > 0);
  const total = visibleBuckets.reduce((sum, bucket) => sum + bucket.count, 0);
  if (!total) {
    const label = svgElement("text", { class: "guide-chart-empty", x: 0, y: 24 });
    label.textContent = "无可用数据";
    chart.append(label);
    legend.append(element("li", "guide-chart-empty", "无可用数据"));
    return;
  }
  const max = Math.max(...visibleBuckets.map((bucket) => bucket.count), 1);
  const trackX = 155;
  const trackWidth = 300;
  const barHeight = 20;
  const rowGap = 58;
  visibleBuckets.forEach((bucket, index) => {
    const y = 13 + index * rowGap;
    const label = svgElement("text", {
      class: "guide-bar-label",
      x: 0,
      y: y + 15,
    });
    label.textContent = bucket.label;
    const track = svgElement("rect", {
      class: "guide-bar-track",
      x: trackX,
      y,
      width: trackWidth,
      height: barHeight,
      rx: 2,
    });
    track.setAttribute("aria-hidden", "true");
    const bar = svgElement("rect", {
      class: `guide-bar guide-degree-${bucket.key}`,
      x: trackX,
      y,
      width: (bucket.count / max) * trackWidth,
      height: barHeight,
      rx: 2,
      tabindex: "0",
    });
    bar.setAttribute(
      "aria-label",
      `${bucket.label}：${bucket.count} 个项目，占 ${formatPercent(bucket.count, total)}`,
    );
    const value = svgElement("text", {
      class: "guide-bar-value",
      x: 510,
      y: y + 15,
    });
    value.textContent = String(bucket.count);
    const percent = svgElement("text", {
      class: "guide-bar-percent",
      x: trackX,
      y: y + 36,
    });
    percent.textContent = formatPercent(bucket.count, total);
    chart.append(label, track, bar, value, percent);
    legend.append(guideLegendRow(
      bucket.label,
      bucket.count,
      total,
      `guide-degree-${bucket.key}`,
      "图表单位为项目记录，不表示项目质量或影响力。",
    ));
  });
}

function renderGuideCharts(stats) {
  renderCountryDonut(stats.countryChart);
  renderDegreeBars(stats.degreeBuckets);
}

function selectGuideCountryBucket(bucket) {
  state.guideCountrySelection = bucket.country;
  const countries = new Set(bucket.countries || [bucket.country]);
  $("#guide-country-chart").querySelectorAll("[data-guide-country]").forEach((node) => {
    const selected = node.getAttribute("data-guide-country") === bucket.country;
    node.classList.toggle("is-selected", selected);
    node.setAttribute("aria-pressed", String(selected));
  });
  $("#guide-country-legend").querySelectorAll("[data-guide-country]").forEach((node) => {
    const selected = node.getAttribute("data-guide-country") === bucket.country;
    node.classList.toggle("is-selected", selected);
    node.setAttribute("aria-pressed", String(selected));
  });
  const details = $$("#guide-country-body .guide-country-details");
  details.forEach((detail) => {
    // Located countries stay expanded as the default reading surface.  A
    // click can temporarily open the unmarked group for inspection, but never
    // collapses the other country details the user is already reading.
    detail.open = detail.dataset.country !== "未标注" || countries.has(detail.dataset.country);
  });
  const selection = $("#guide-country-selection");
  if (selection) {
    const countryText = countryDisplayLabel(bucket.country);
    selection.textContent = `已选择 ${countryText} · ${bucket.organizations} 个根机构；下方对应明细已展开。`;
  }
  const firstDetail = details.find((detail) => countries.has(detail.dataset.country));
  if (firstDetail) firstDetail.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function guideCountryDetails(bucket) {
  const details = element("details", "guide-country-details");
  details.dataset.country = bucket.country;
  details.setAttribute("data-guide-country", bucket.country);
  details.open = bucket.country !== "未标注";
  bindGuideCountryHover(details, [bucket.country]);
  const summary = element("summary", "guide-country-summary");
  const summaryMeta = element("span", "guide-country-summary-meta");
  const stateSummary = Object.entries(bucket.locationStates || {})
    .filter(([, count]) => count)
    .map(([state, count]) => `${LOCATION_STATE_LABELS[state] || state} ${count}`)
    .join(" · ");
  if (stateSummary) summaryMeta.append(element("span", "guide-country-summary-state", stateSummary));
  (bucket.locationScopes || []).forEach((scope) => {
    summaryMeta.append(element("span", "guide-scope-badge", LOCATION_SCOPE_LABELS[scope] || scope));
  });
  summary.append(
    element("span", "guide-country-summary-name", countryDisplayLabel(bucket.country)),
    element("span", "guide-country-summary-count", `${bucket.organizations} 个根机构`),
    summaryMeta,
  );
  const institutionList = element("ul", "guide-country-institution-list");
  bucket.roots.forEach((root) => {
    const item = element("li", "guide-country-institution");
    const heading = element("div", "guide-country-institution-heading");
    const badges = element("span", "guide-location-badges");
    guideLocationBadges(root).forEach((badge) => badges.append(badge));
    heading.append(
      element("strong", "", root.name),
      badges,
      element("span", "", `${root.programs.length} 个项目 · ${root.teacherIds.size} 位公开教师`),
    );
    item.append(heading);

    if (root.programs.length) {
      const section = element("div", "guide-country-subsection");
      section.append(element("h4", "", "公开学位项目"));
      const programs = element("ul", "guide-country-programs");
      [...root.programs]
        .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"))
        .forEach((program) => {
          const programItem = element("li");
          if (program.official_url) {
            const link = element("a", "guide-country-program-link", program.name);
            link.href = program.official_url;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            programItem.append(link, element("span", "guide-country-source-label", programmeSourceLabel(program)));
          } else {
            programItem.append(
              element("span", "", program.name),
              element("span", "guide-country-source-label", "官方链接未提供"),
            );
          }
          guideProgramBadges(program, root).forEach((badge) => programItem.append(badge));
          programs.append(programItem);
        });
      section.append(programs);
      item.append(section);
    }

    if (root.teacherIds.size) {
      const section = element("div", "guide-country-subsection");
      section.append(element("h4", "", "公开教师"));
      const teachers = element("ul", "guide-country-teachers");
      [...root.teacherIds]
        .map((personId) => state.peopleById.get(personId))
        .filter(Boolean)
        .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"))
        .forEach((person) => {
          const line = element("li", "", person.name);
          if (person.supervision?.current_title) {
            line.append(element("span", "guide-country-teacher-title", ` · ${person.supervision.current_title}`));
          }
          teachers.append(line);
        });
      section.append(teachers);
      item.append(section);
    }

    if (!root.programs.length && !root.teacherIds.size) {
      item.append(element("p", "guide-country-empty", "暂无可定位的公开项目或教师记录。"));
    }
    institutionList.append(item);
  });
  details.append(summary, institutionList);
  return details;
}

function renderDataGuide() {
  if (!state.data) return;
  const stats = dataGuideStats();
  const sourceTypeLabels = {
    official_detail: "项目详情页",
    official_directory: "官方目录",
    "未标注来源类型": "未标注来源类型",
  };
  const sourceTypeText = Object.entries(stats.sourceTypes)
    .map(([type, count]) => (sourceTypeLabels[type] || type) + " " + count)
    .join("；") || "无已核项目来源类型记录";

  $("#data-guide-snapshot").textContent = "公开快照 " + stats.programs
    + " 个项目 · " + state.data.generated_at + " · schema " + state.data.schema_version;
  $("#guide-stats-note").textContent = "这里的“机构记录”是 " + stats.organizationRecords
    + " 条节点；“根机构”是去重后地图上的 " + stats.rootOrganizations
    + " 个主体。国家表按根机构归属统计，项目在各根机构内去重；教师列只反映已有机构关联的公开教师记录，不等于公开教师总数。地点状态分为“已核实”（官方页面直接确认）和“已归属·推断”（机构/城市证据足够，但国家是地理归属推导）；多校区、联合项目和线上项目不强行放置单一城市点。本页只展示可公开核对的信息。";

  const statList = $("#guide-stat-list");
  statList.replaceChildren();
  [
    ["学位项目", stats.programs],
    ["根机构（地图统计单位）", stats.rootOrganizations],
    ["机构记录（含院系 / 学校 / 研究组等节点）", stats.organizationRecords],
    ["已标注国家 / 地区", stats.knownCountries],
    ["地点已核实的根机构", stats.locationStates.verified],
    ["地点已归属·推断的根机构", stats.locationStates.inferred],
    ["未标注地点的根机构", stats.locationStates.unverified],
    ["公开教师记录", stats.people],
  ].forEach(([label, value]) => {
    const stat = element("div", "guide-stat");
    stat.append(element("dt", "", label), element("dd", "", String(value)));
    statList.append(stat);
  });

  renderGuideCharts(stats);

  const countryBody = $("#guide-country-body");
  countryBody.replaceChildren();
  stats.countryBuckets.forEach((bucket) => {
    const row = element("tr", bucket.country === "未标注" ? "guide-unlabeled-row" : "");
    row.setAttribute("data-guide-country", bucket.country);
    bindGuideCountryHover(row, [bucket.country]);
    const countryCell = element("th", "guide-country-cell");
    countryCell.scope = "row";
    countryCell.append(guideCountryDetails(bucket));
    row.append(
      countryCell,
      element("td", "", String(bucket.organizations)),
      element("td", "", String(bucket.programs)),
      element("td", "", String(bucket.people)),
    );
    countryBody.append(row);
  });

  $("#guide-official-source-stats").textContent = "项目状态为“已核”："
    + stats.verifiedPrograms + " / " + stats.programs
    + "；已核项目证据 " + stats.projectEvidenceCount + " 条；来源类型："
    + sourceTypeText + "。另有 " + stats.unverifiedPrograms
    + " 个项目未核，未计入已核统计。地点状态：已核实 "
    + stats.locationStates.verified + " 个根机构，已归属·推断 "
    + stats.locationStates.inferred + " 个，未标注 "
    + stats.locationStates.unverified + " 个。";
}

function setDataGuideOpen(open) {
  const guide = $("#data-guide");
  const toggle = $("#data-guide-toggle");
  if (open && !state.data) return;
  if (open) {
    if (window.location.hash !== "#data-guide") window.history.replaceState(null, "", "#data-guide");
    closeDrawer();
    renderDataGuide();
    guide.hidden = false;
    document.body.classList.add("is-guide-open");
    toggle.setAttribute("aria-expanded", "true");
    guide.scrollTop = 0;
    $("#data-guide-close").focus();
    return;
  }
  guide.hidden = true;
  document.body.classList.remove("is-guide-open");
  toggle.setAttribute("aria-expanded", "false");
  if (window.location.hash === "#data-guide") window.history.replaceState(null, "", "#world-map");
  toggle.focus();
}

// ---------------------------------------------------------------- table view
// The table answers a different question from the map: not "where is this" but
// "show me every programme once and let me sort it". A joint programme taught
// by several institutions is one row with combined institutions, never one row
// per institution (a test guards this).
// It deliberately reuses the map's filters rather than growing a second,
// divergent set of controls.
const COUNTRY_DISPLAY_LABELS = {
  China: "China · Mainland",
  "Hong Kong": "China · Hong Kong",
  Macao: "China · Macao",
  Taiwan: "China · Taiwan",
};

function countryDisplayLabel(country) {
  return COUNTRY_DISPLAY_LABELS[country] || country;
}
// `pick` gives the column a dropdown of the values actually present; everything else
// gets a contains-box. Which one a column deserves follows from its cardinality:
// 24 countries is a list you can choose from, 259 programme names is not.
const TABLE_COLUMNS = {
  programs: [
    { key: "name", label: "项目名称", width: "26rem" },
    { key: "degree", label: "层级", pick: true },
    { key: "institution", label: "机构" },
    { key: "country", label: "国家 / 地区", pick: true },
    { key: "city", label: "城市", pick: true },
    { key: "pageState", label: "官方页", pick: true },
    { key: "url", label: "官方链接", link: true },
  ],
  organizations: [
    { key: "name", label: "机构", width: "22rem" },
    { key: "country", label: "国家 / 地区", pick: true },
    { key: "city", label: "城市", pick: true },
    { key: "degree", label: "学位层级", pick: true },
    { key: "programCount", label: "项目数", numeric: true },
    { key: "teacherCount", label: "教师数", numeric: true },
    { key: "located", label: "是否上图", pick: true },
  ],
  people: [
    { key: "name", label: "姓名", width: "16rem" },
    { key: "title", label: "职称", width: "20rem" },
    { key: "institution", label: "机构", width: "18rem" },
    { key: "country", label: "国家 / 地区", pick: true },
    { key: "eligibility", label: "主导师资格", pick: true },
    { key: "accepting", label: "是否在招", pick: true },
  ],
};
// Deliberately the same vocabulary as the drawer: not_eligible says the route is
// not there, never that the person is personally disqualified. A test guards this.
const ELIGIBILITY_LABELS = {
  principal_eligible: "可挂帅",
  advisor_only: "仅协助",
  not_eligible: "无主导师路线",
  unverified: "未核",
};
const ACCEPTING_LABELS = { accepting: "在招", not_accepting: "不招", unknown: "未知" };
const tableState = { scope: "programs", sortKey: "name", sortDirection: 1, page: 0,
                     columnFilters: {} };

function tableVisible(organization) {
  const checked = new Set($$(".degree-filters input:checked").map((input) => input.value));
  const kind = markerKind(organization);
  const degreeMatches = kind === "both" ? checked.has("phd") || checked.has("master") : checked.has(kind);
  // No country means no coordinate, so the map drops it. The table still lists it.
  const countryMatches = !organization.country || state.selectedCountries.has(organization.country);
  return degreeMatches && countryMatches;
}

function programTableRows(visibleOrganizations) {
  const byProgramId = new Map();
  visibleOrganizations.forEach((organization) => {
    organization.programs.forEach((program) => {
      if (!byProgramId.has(program.id)) {
        byProgramId.set(program.id, {
          program,
          institutions: [],
          countries: [],
          cities: [],
        });
      }
      const row = byProgramId.get(program.id);
      if (organization.name && !row.institutions.includes(organization.name)) {
        row.institutions.push(organization.name);
      }
      if (organization.country && !row.countries.includes(organization.country)) {
        row.countries.push(organization.country);
      }
      if (organization.city && !row.cities.includes(organization.city)) {
        row.cities.push(organization.city);
      }
    });
  });
  const display = (values) => values.length ? values.join(" / ") : "—";
  return [...byProgramId.values()].map(({ program, institutions, countries, cities }) => ({
    name: program.name,
    degree: program.degree_level === "phd" ? "博士" : "硕士",
    institution: display(institutions),
    country: display(countries.map(countryDisplayLabel)),
    city: display(cities),
    pageState: program.official_page_state === "verified" ? "已核" : "未核",
    url: program.official_url || "",
    _id: program.id,
  }));
}

function tableRows() {
  const query = $("#table-search").value.trim().toLocaleLowerCase();
  const directoryQuery = $("#search").value.trim().toLocaleLowerCase();
  const visibleOrganizations = state.rootOrganizations.filter((organization) => (
    tableVisible(organization) && (!directoryQuery || searchText(organization).includes(directoryQuery))
  ));
  const visibleIds = new Set(visibleOrganizations.map((organization) => organization.id));
  let rows = [];
  if (tableState.scope === "organizations") {
    rows = visibleOrganizations.map((organization) => ({
      name: organization.name,
      country: organization.country || "—",
      city: organization.city || "—",
      degree: degreeLabel(organization),
      programCount: organization.programs.length,
      teacherCount: organization.teacherIds.size,
      located: organization.cityCoordinate ? "是" : "否（无坐标）",
      _id: organization.id,
    }));
  } else if (tableState.scope === "people") {
    visibleOrganizations.forEach((organization) => {
      organization.teacherIds.forEach((personId) => {
        const person = state.peopleById.get(personId);
        if (!person) return;
        const supervision = person.supervision || {};
        rows.push({
          name: person.name,
          title: supervision.current_title || "—",
          institution: organization.name,
          country: organization.country || "—",
          eligibility: ELIGIBILITY_LABELS[supervision.supervision_eligibility] || "未核",
          accepting: ACCEPTING_LABELS[supervision.currently_accepting] || "未知",
          _id: person.id,
        });
      });
    });
  } else {
    rows = programTableRows(visibleOrganizations);
  }
  if (tableState.scope === "programs" || tableState.scope === "people") {
    const seen = new Set();
    rows = rows.filter((row) => {
      const key = `${row._id}|${row.institution || ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  if (query) {
    rows = rows.filter((row) => Object.entries(row)
      .filter(([key]) => !key.startsWith("_"))
      .map(([, value]) => String(value))
      .join(" ")
      .toLocaleLowerCase()
      .includes(query));
  }
  const columnFilters = tableState.columnFilters;
  Object.entries(columnFilters).forEach(([key, filter]) => {
    if (!filter) return;
    if (filter.kind === "pick") {
      rows = rows.filter((row) => String(row[key]) === filter.value);
    } else {
      const needle = filter.value.toLocaleLowerCase();
      rows = rows.filter((row) => String(row[key]).toLocaleLowerCase().includes(needle));
    }
  });
  const column = TABLE_COLUMNS[tableState.scope].find((item) => item.key === tableState.sortKey);
  rows.sort((a, b) => {
    const left = a[tableState.sortKey];
    const right = b[tableState.sortKey];
    if (column?.numeric) return (Number(left) - Number(right)) * tableState.sortDirection;
    return String(left).localeCompare(String(right), "zh-Hans-CN") * tableState.sortDirection;
  });
  void visibleIds;
  return rows;
}

function pickerOptions(key) {
  const saved = tableState.columnFilters[key];
  delete tableState.columnFilters[key];
  const values = [...new Set(tableRows().map((row) => String(row[key])))]
    .filter((value) => value && value !== "—")
    .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
  if (saved) tableState.columnFilters[key] = saved;
  return values;
}

function renderTable() {
  const columns = TABLE_COLUMNS[tableState.scope];
  const rows = tableRows();
  const pageSize = Number($("#table-page-size").value) || rows.length || 1;
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  tableState.page = Math.min(tableState.page, pageCount - 1);
  const start = tableState.page * pageSize;
  const pageRows = rows.slice(start, start + pageSize);

  const head = $("#table-head");
  head.replaceChildren();
  const headRow = element("tr");
  columns.forEach((column) => {
    const cell = element("th");
    cell.scope = "col";
    if (column.width) cell.style.minWidth = column.width;
    const button = element("button", "table-sort", column.label);
    button.type = "button";
    if (tableState.sortKey === column.key) {
      button.classList.add("is-sorted");
      button.append(element("span", "sort-arrow", tableState.sortDirection > 0 ? " ▲" : " ▼"));
      cell.setAttribute("aria-sort", tableState.sortDirection > 0 ? "ascending" : "descending");
      button.setAttribute("aria-sort", tableState.sortDirection > 0 ? "ascending" : "descending");
    }
    button.addEventListener("click", () => {
      if (tableState.sortKey === column.key) tableState.sortDirection *= -1;
      else { tableState.sortKey = column.key; tableState.sortDirection = 1; }
      tableState.page = 0;
      renderTable();
    });
    cell.append(button);
    headRow.append(cell);
  });
  head.append(headRow);

  const filterRow = element("tr", "table-filter-row");
  columns.forEach((column) => {
    const cell = element("th");
    const active = tableState.columnFilters[column.key];
    if (column.pick) {
      const select = element("select", "column-filter");
      select.setAttribute("aria-label", `按${column.label}筛选`);
      const any = element("option", "", "全部");
      any.value = "";
      select.append(any);
      pickerOptions(column.key).forEach((value) => {
        const option = element("option", "", value);
        option.value = value;
        select.append(option);
      });
      select.value = active ? active.value : "";
      select.addEventListener("change", () => {
        if (select.value) tableState.columnFilters[column.key] = { kind: "pick", value: select.value };
        else delete tableState.columnFilters[column.key];
        tableState.page = 0;
        renderTable();
      });
      if (active) select.classList.add("is-active");
      cell.append(select);
    } else {
      const input = element("input", "column-filter");
      input.type = "search";
      input.placeholder = "筛选";
      input.setAttribute("aria-label", `按${column.label}筛选`);
      input.value = active ? active.value : "";
      input.addEventListener("input", () => {
        if (input.value.trim()) tableState.columnFilters[column.key] = { kind: "text", value: input.value.trim() };
        else delete tableState.columnFilters[column.key];
        tableState.page = 0;
        renderTable();
        const restored = head.querySelector(`[aria-label="按${column.label}筛选"]`);
        if (restored) { restored.focus(); restored.setSelectionRange(restored.value.length, restored.value.length); }
      });
      if (active) input.classList.add("is-active");
      cell.append(input);
    }
    filterRow.append(cell);
  });
  head.append(filterRow);

  const body = $("#table-body");
  body.replaceChildren();
  pageRows.forEach((row) => {
    const tr = element("tr");
    columns.forEach((column) => {
      const cell = element("td");
      const value = row[column.key];
      if (column.link && value) {
        try {
          const url = new URL(String(value), window.location.href);
          if (["http:", "https:"].includes(url.protocol)) {
            const link = element("a", "", url.hostname.replace(/^www\./, ""));
            link.href = url.href;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            link.title = url.href;
            cell.append(link);
          } else cell.textContent = "—";
        } catch (_) { cell.textContent = "—"; }
      } else {
        cell.textContent = value === undefined || value === "" ? "—" : String(value);
      }
      tr.append(cell);
    });
    body.append(tr);
  });
  if (!pageRows.length) {
    const tr = element("tr");
    const cell = element("td", "", "没有匹配的行");
    cell.colSpan = columns.length;
    tr.append(cell);
    body.append(tr);
  }
  const activeFilters = Object.keys(tableState.columnFilters).length;
  $("#table-count").textContent = activeFilters
    ? `${rows.length} 行 · ${activeFilters} 个列筛选`
    : `${rows.length} 行`;
  $("#clear-filters").hidden = activeFilters === 0;
  $("#table-page").textContent = `第 ${tableState.page + 1} / ${pageCount} 页`;
  $("#table-prev").disabled = tableState.page === 0;
  $("#table-next").disabled = tableState.page >= pageCount - 1;
}

function downloadFile(name, mime, text) {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function exportRows(format) {
  const columns = TABLE_COLUMNS[tableState.scope];
  const rows = tableRows();
  const stamp = state.data?.generated_at?.slice(0, 10) || "export";
  if (format === "json") {
    const payload = rows.map((row) => Object.fromEntries(
      columns.map((column) => [column.key, row[column.key] ?? ""])));
    downloadFile(`atlas-${tableState.scope}-${stamp}.json`, "application/json",
      JSON.stringify(payload, null, 1));
    return;
  }
  const escape = (value) => {
    const text = value === undefined || value === null ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [columns.map((column) => escape(column.label)).join(",")];
  rows.forEach((row) => lines.push(columns.map((column) => escape(row[column.key])).join(",")));
  // BOM so Excel opens the Chinese columns without mangling them.
  downloadFile(`atlas-${tableState.scope}-${stamp}.csv`, "text/csv", `﻿${lines.join("\n")}`);
}

function setView(view) {
  const isTable = view === "table";
  $("#world-map").hidden = isTable;
  $("#table-panel").hidden = !isTable;
  $("#zoom-reset").hidden = isTable;
  $("#directory-toggle").hidden = isTable;
  const status = $("#map-status");
  if (isTable) { status.dataset.wasHidden = String(status.hidden); status.hidden = true; }
  else if (status.dataset.wasHidden !== undefined) { status.hidden = status.dataset.wasHidden === "true"; }
  $(".map-heading p").textContent = isTable
    ? "同一份公开数据的表格视图。每一行都可点开官方链接核对；导出的是当前筛选与排序后的结果。"
    : "圆点定位到城市，不代表具体校区。每个根机构只显示一个点；同校部门与研究组在抽屉内下钻。";
  $("#view-map").classList.toggle("is-active", !isTable);
  $("#view-table").classList.toggle("is-active", isTable);
  $("#view-map").setAttribute("aria-selected", String(!isTable));
  $("#view-table").setAttribute("aria-selected", String(isTable));
  $("#map-title").textContent = isTable ? "完整表格" : "世界地图";
  if (isTable) renderTable();
  else scheduleMapLayout({ fit: false, animate: false });
}

function refreshViews() {
  renderMarkers();
  renderLinks();
  scheduleMapLayout({ fit: true });
  renderInstitutionList();
  if (!$("#table-panel").hidden) { tableState.page = 0; renderTable(); }
}

$("#search").addEventListener("input", refreshViews);
$$(".degree-filters input").forEach((input) => input.addEventListener("change", refreshViews));
$("#link-toggle").addEventListener("change", renderLinks);
$("#view-map").addEventListener("click", () => setView("map"));
$("#view-table").addEventListener("click", () => setView("table"));
$("#table-scope").addEventListener("change", (event) => {
  tableState.scope = event.target.value;
  tableState.sortKey = TABLE_COLUMNS[tableState.scope][0].key;
  tableState.sortDirection = 1;
  tableState.page = 0;
  tableState.columnFilters = {};
  renderTable();
});
$("#table-search").addEventListener("input", () => { tableState.page = 0; renderTable(); });
$("#table-page-size").addEventListener("change", () => { tableState.page = 0; renderTable(); });
$("#table-prev").addEventListener("click", () => { tableState.page -= 1; renderTable(); });
$("#table-next").addEventListener("click", () => { tableState.page += 1; renderTable(); });
$("#clear-filters").addEventListener("click", () => {
  tableState.columnFilters = {};
  tableState.page = 0;
  renderTable();
});
$("#export-csv").addEventListener("click", () => exportRows("csv"));
$("#export-json").addEventListener("click", () => exportRows("json"));
installMapNavigation();
const atlasShell = $(".atlas-shell");
const directoryToggle = $("#directory-toggle");
function setDirectoryCollapsed(collapsed) {
  const shouldCollapse = collapsed && !window.matchMedia("(max-width: 480px)").matches;
  atlasShell.classList.toggle("is-directory-collapsed", shouldCollapse);
  directoryToggle.setAttribute("aria-expanded", String(!shouldCollapse));
  directoryToggle.textContent = shouldCollapse ? "展开目录" : "收起目录";
  scheduleMapLayout({ fit: true, animate: false });
}
directoryToggle.addEventListener("click", () => {
  setDirectoryCollapsed(!atlasShell.classList.contains("is-directory-collapsed"));
});
window.addEventListener("resize", () => {
  window.clearTimeout(state.resizeTimer);
  state.resizeTimer = window.setTimeout(() => {
    if (window.matchMedia("(max-width: 480px)").matches) setDirectoryCollapsed(false);
    else scheduleMapLayout({ fit: true, animate: false });
  }, 100);
});
$("#data-guide-toggle").addEventListener("click", () => setDataGuideOpen($("#data-guide").hidden));
$("#data-guide-close").addEventListener("click", () => setDataGuideOpen(false));
$("#drawer-close").addEventListener("click", closeDrawer);
$("#drawer-scrim").addEventListener("click", closeDrawer);
const themeMeta = $('meta[name="color-scheme"]');
const themeToggle = $("#theme-toggle");
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeMeta.content = theme === "light" ? "only light" : "dark";
  themeToggle.setAttribute("aria-pressed", String(theme === "dark"));
}
themeToggle.addEventListener("click", () => {
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
});
applyTheme(window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!$("#data-guide").hidden) setDataGuideOpen(false);
  else closeDrawer();
});
start().catch((error) => {
  $("#map-status").textContent = error.message;
  $("#map-status").hidden = false;
});
