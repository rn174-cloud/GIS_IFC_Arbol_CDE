/* app.js - RN174 Gemelo Digital Controller (Synchronized GIS ↔ IFC ↔ CDE ISO 19650 Tree) */

// 1. CONFIGURATION & CONSTANTS
const SUPABASE_URL = "https://olqajnownfxoxuyerrlh.supabase.co";
const ANON_KEY = window.SUPABASE_ANON_KEY || "sb_publishable_2A4_o3lb4Hl3-zYAP6EWYA_q-j4Vhhz";

const API_HEADERS = {
  "apikey": ANON_KEY,
  "Authorization": `Bearer ${ANON_KEY}`
};

// Global Application State
let gisMap = null;
let gisLayers = {}; 
let gisMarkers = {}; 
let selectedGisHighlight = null;

let threeScene, threeCamera, threeRenderer, threeControls;
let meshMap = {}; // ifc_global_id -> THREE.Mesh
let assetMeshMap = {}; // asset_id -> array of THREE.Mesh
let selectedMesh = null;
let selectedMeshOrigMat = null;

let allAssets = [];
let assetIndex = {};
let currentSelectedAsset = null;

// Materials Palette
const MATERIALS = {
  ASPHALT: new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.8 }),
  CONCRETE: new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.5 }),
  STEEL: new THREE.MeshStandardMaterial({ color: 0x64748b, metalness: 0.6, roughness: 0.3 }),
  PYLON: new THREE.MeshStandardMaterial({ color: 0xcbd5e1, roughness: 0.4 }),
  LIGHT: new THREE.MeshStandardMaterial({ color: 0xf59e0b, emissive: 0xd97706, emissiveIntensity: 0.4 }),
  SAFETY: new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.5 }),
  SIGN: new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.3, metalness: 0.2 }),
  // Selected Red Highlight for 3D IFC assets
  HIGHLIGHT: new THREE.MeshStandardMaterial({ 
    color: 0xdc2626, 
    emissive: 0xef4444, 
    emissiveIntensity: 0.9,
    roughness: 0.2 
  })
};

let currentEpoch = 'julio2026';
let accidentData = [];
let currentAccidentYearFilter = 'ALL';

// 2. INITIALIZATION
window.addEventListener('DOMContentLoaded', async () => {
  console.log("Initializing RN174 Synchronized Tri-View (GIS ↔ IFC ↔ CDE ISO 19650 Tree)...");

  // A) Initialize 3D Engine
  init3DViewer();

  // B) Initialize GIS Map
  initGISMap();

  // C) Load SSOT Assets & Accident Dataset
  await loadSupabaseAssets();
  await loadAccidentData();

  // D) Load 3D Geometry
  await load3DMeshData();

  // E) Render GIS layers with full interactive markers (combining DB + 3D assets + Siniestralidad)
  renderGISLayers();
  renderAccidentLayer();

  // F) Initialize Bottom Drawer Interactive Taxonomy & LRS Dropdowns
  initDrawerFilters();

  // G) Setup UI Event Handlers
  setupUIHandlers();

  // G) Recalculate Leaflet Map Size & Select RN0174-SV-00018 by default
  setTimeout(() => {
    if (gisMap) gisMap.invalidateSize();
    selectAssetById('RN0174-SV-00018', 'init');
  }, 400);
});

// 3. THREE.JS 3D VIEWER INITIALIZATION
function init3DViewer() {
  const container = document.querySelector('.panel-col:nth-child(2) .panel-body');
  const canvas = document.getElementById('bim-canvas');
  
  const width = container.clientWidth || 500;
  const height = container.clientHeight || 500;

  threeScene = new THREE.Scene();
  threeScene.background = new THREE.Color(0xf1f5f9);

  threeCamera = new THREE.PerspectiveCamera(45, width / height, 0.1, 5000);
  threeCamera.position.set(0, 15, 180);

  threeRenderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
  threeRenderer.setSize(width, height);
  threeRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  threeRenderer.shadowMap.enabled = true;

  threeControls = new THREE.OrbitControls(threeCamera, threeRenderer.domElement);
  threeControls.enableDamping = true;
  threeControls.dampingFactor = 0.05;

  // Lighting
  const hemiLight = new THREE.HemisphereLight(0xffffff, 0x94a3b8, 0.8);
  hemiLight.position.set(0, 300, 0);
  threeScene.add(hemiLight);

  const sunLight = new THREE.DirectionalLight(0xffffff, 0.9);
  sunLight.position.set(150, 250, 100);
  sunLight.castShadow = true;
  threeScene.add(sunLight);

  // Ground Plane
  const groundGeo = new THREE.PlaneGeometry(3000, 3000);
  const groundMat = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.9 });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -5;
  ground.receiveShadow = true;
  threeScene.add(ground);

  // Raycaster for 3D Element Selection (Mouse + Touch Screen Compatible)
  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();

  let ptrStartX = 0, ptrStartY = 0;

  function getIntersectableMeshes() {
    const meshes = [];
    if (threeScene) {
      threeScene.traverse((obj) => {
        if (obj.isMesh && obj !== ground && obj.geometry) {
          meshes.push(obj);
        }
      });
    }
    return meshes;
  }

  canvas.addEventListener('pointerdown', (e) => {
    ptrStartX = e.clientX;
    ptrStartY = e.clientY;
  });

  canvas.addEventListener('pointermove', (event) => {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouse, threeCamera);
    const intersects = raycaster.intersectObjects(getIntersectableMeshes());

    if (intersects.length > 0) {
      canvas.style.cursor = 'pointer';
    } else {
      canvas.style.cursor = 'default';
    }
  });

  canvas.addEventListener('pointerup', (event) => {
    const dist = Math.hypot(event.clientX - ptrStartX, event.clientY - ptrStartY);
    if (dist > 6) return; // Ignore drag/rotation gestures

    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouse, threeCamera);
    const intersects = raycaster.intersectObjects(getIntersectableMeshes());

    if (intersects.length > 0) {
      const hitMesh = intersects[0].object;
      console.log("[3D Raycaster] Hit element:", hitMesh.userData);
      select3DElement(hitMesh, hitMesh.userData, '3d_click');
    }
  });

  // Resize Listener
  window.addEventListener('resize', () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    threeCamera.aspect = w / h;
    threeCamera.updateProjectionMatrix();
    threeRenderer.setSize(w, h);
  });

  function animate() {
    requestAnimationFrame(animate);
    threeControls.update();
    threeRenderer.render(threeScene, threeCamera);
  }
  animate();
}

// 4. LEAFLET GIS MAP INITIALIZATION
function initGISMap() {
  gisMap = L.map('gis-map', {
    zoomControl: false,
    attributionControl: false
  }).setView([-32.87030, -60.68660], 15);

  L.control.zoom({ position: 'topright' }).addTo(gisMap);

  // Google Maps Hybrid Satellite Basemap (Exact 1:1 match with Google Maps coordinates)
  L.tileLayer('https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', {
    maxZoom: 20
  }).addTo(gisMap);

  gisLayers = {
    hitos: L.layerGroup(),
    puentes: L.layerGroup(),
    sen: L.layerGroup(),
    ilum: L.layerGroup(),
    corredor: L.layerGroup(),
    accidents: L.layerGroup()
  };

  // Prevent map drag & zoom propagation on layersCard WITHOUT calling preventDefault on click!
  const layersCard = document.querySelector('.gis-layers-card');
  if (layersCard) {
    ['mousedown', 'dblclick', 'touchstart', 'pointerdown'].forEach(evt => {
      layersCard.addEventListener(evt, (e) => {
        e.stopPropagation();
      });
    });
  }

  gisMap.on('click popupopen', () => {
    if (typeof collapseMobileGisLayers === 'function') collapseMobileGisLayers();
  });
}

// 5. FETCH ASSETS FROM DATABASE
async function loadSupabaseAssets() {
  try {
    const url = `${SUPABASE_URL}/rest/v1/v_activos_semaforo?select=*&limit=3000`;
    const res = await fetch(url, { headers: API_HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    allAssets = await res.json();
    console.log(`[Database] Loaded ${allAssets.length} SSOT assets.`);

    allAssets.forEach(a => {
      if (a.asset_id) assetIndex[a.asset_id.trim()] = a;
      if (a.business_code) assetIndex[a.business_code.trim()] = a;
    });

  } catch (err) {
    console.error("[Database Load Error]", err);
  }
}

// 5.5 LOAD 3D MESH GEOMETRY
async function load3DMeshData() {
  try {
    console.log("[3D Mesh] Loading bridge_3d_mesh.json...");
    const res = await fetch("./dist/bridge_3d_mesh.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const elements = await res.json();
    console.log(`[3D Mesh] Loaded ${elements.length} 3D elements.`);

    meshMap = {};
    assetMeshMap = {};

    elements.forEach(el => {
      if (!el.verts || el.verts.length === 0 || !el.faces || el.faces.length === 0) return;

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(el.verts, 3));
      geometry.setIndex(el.faces);
      geometry.computeVertexNormals();

      // Determine material based on class/familia/name
      let material = MATERIALS.CONCRETE;
      const cls = (el.ifc_class || '').toUpperCase();
      const fam = (el.pset_aim_asset?.familia || el.name || '').toUpperCase();
      const name = (el.name || '').toUpperCase();

      if (cls.includes('SLAB') || cls.includes('PLATE') || fam.includes('PAVIMENT')) {
        material = MATERIALS.ASPHALT;
      } else if (cls.includes('COLUMN') || cls.includes('BEAM') || cls.includes('PIER') || fam.includes('PILA')) {
        material = MATERIALS.PYLON;
      } else if (cls.includes('SIGN') || fam.includes('SEÑAL') || fam.includes('SENAL') || name.includes('-SV-')) {
        material = MATERIALS.SIGN;
      } else if (cls.includes('RAILING') || fam.includes('DEFENSA') || name.includes('-DEF-')) {
        material = MATERIALS.STEEL;
      } else if (cls.includes('LIGHT') || fam.includes('ILUM') || name.includes('-ILU-')) {
        material = MATERIALS.LIGHT;
      }

      const mesh = new THREE.Mesh(geometry, material);
      mesh.userData = el;

      if (el.ifc_global_id) meshMap[el.ifc_global_id] = mesh;
      
      const assetId = el.asset_id || el.business_code;
      if (assetId) {
        if (!assetMeshMap[assetId]) assetMeshMap[assetId] = [];
        assetMeshMap[assetId].push(mesh);
      }

      threeScene.add(mesh);
    });

    console.log(`[3D Engine] Successfully rendered ${Object.keys(meshMap).length} meshes in 3D scene.`);

  } catch (err) {
    console.error("[3D Mesh Load Error]", err);
  }
}

// 6. RENDER ALL GIS LAYERS (COMBINING DB + 3D MODEL ELEMENTS)
function renderGISLayers() {
  if (!gisMap) return;

  Object.values(gisLayers).forEach(lg => lg.clearLayers());
  gisMarkers = {};

  // Traza Corredor RN174 (Yellow Ground-Truth Alignment Polyline matching Google Maps)
  const corridorCoords = [
    [-32.874570, -60.702460],
    [-32.872340, -60.699110],
    [-32.870890, -60.691240],
    [-32.870410, -60.687323], // Pila 42 Torre Principal Rosario (Google Maps Ground-Truth)
    [-32.869934, -60.683608], // Pila 43 Torre Principal Victoria (Google Maps Ground-Truth)
    [-32.869800, -60.682500], // PK 1+900 Señal R.23
    [-32.869600, -60.680900],
    [-32.864000, -60.650000],
    [-32.862000, -60.635000]
  ];
  L.polyline(corridorCoords, {
    color: '#facc15',
    weight: 5,
    opacity: 0.95
  }).addTo(gisLayers.corredor);

  // Hito BIM Principal Marker
  const bridgeMarker = L.circleMarker([-32.87030, -60.68660], {
    radius: 10,
    fillColor: '#facc15',
    color: '#dc2626',
    weight: 4,
    opacity: 1,
    fillOpacity: 1
  }).addTo(gisLayers.hitos);

  bridgeMarker.bindPopup(`
    <div class="popup-card">
      <div class="popup-header">
        <span><i class="fa-solid fa-bridge" style="color:#0284c7;"></i> RN0174-OA-00001</span>
        <span class="tag">BIM SSOT</span>
      </div>
      <table class="popup-table">
        <tr><td class="lbl">ID de activo:</td><td class="val" style="font-family:var(--font-mono); color:#0284c7; font-weight:800;">RN0174-OA-00001</td></tr>
        <tr><td class="lbl">Nombre:</td><td class="val">Puente Principal Atirantado</td></tr>
        <tr><td class="lbl">Progresiva (PK):</td><td class="val">PK 1+706 (1.706 km)</td></tr>
        <tr><td class="lbl">Estado físico:</td><td class="val" style="color:#16a34a; font-weight:800;">VERIFICADO</td></tr>
        <tr><td class="lbl">Trazabilidad doc.:</td><td class="val" style="color:#16a34a; font-weight:800;">CONFORME / CERRADA</td></tr>
      </table>
    </div>
  `, { minWidth: 320, maxWidth: 350 });
  gisMarkers['RN0174-OA-00001'] = bridgeMarker;

  // Combine unique assets from Database and 3D Model
  const combinedMap = {};

  allAssets.forEach(a => {
    if (a.asset_id) combinedMap[a.asset_id] = a;
  });

  Object.values(meshMap).forEach(mesh => {
    const el = mesh.userData;
    if (el && el.asset_id && !combinedMap[el.asset_id]) {
      combinedMap[el.asset_id] = el;
    }
  });

  const uniqueAssets = Object.values(combinedMap);
  
  // Filter for clear, representative GIS markers (prevents cluttered "pegote")
  const gisRepresentativeAssets = uniqueAssets.filter(asset => {
    const assetId = (asset.asset_id || asset.business_code || '').toUpperCase();
    const name = (asset.name || asset.familia || '').toUpperCase();
    const cls = (asset.ifc_class || '').toUpperCase();

    // Skip minor internal geometries
    if (cls.includes('PLATE') || cls.includes('FASTENER') || cls.includes('MEMBER')) return false;

    return assetId.startsWith('RN') || name.includes('PILA') || name.includes('ESTRIBO') || 
           assetId.includes('-SV-') || assetId.includes('-ILU-') || assetId.includes('-DEF-') ||
           name.includes('SEÑAL') || name.includes('ILUM') || name.includes('DEFENSA');
  });

  console.log(`[GIS Layers] Rendering ${gisRepresentativeAssets.length} representative GIS markers for Epoch: ${currentEpoch}...`);

  gisRepresentativeAssets.forEach(asset => {
    const assetId = asset.asset_id || asset.business_code;
    if (!assetId || assetId === 'RN0174-OA-00001') return;

    const info = getElementInfo(assetId, asset);
    const [lat, lon] = getGisCoordsForAsset(assetId, info, asset);

    if (lat && lon) {
      const fam = (info.familia || '').toUpperCase();
      let targetGroup = gisLayers.puentes;
      let markerColor = '#0284c7';
      const isR23 = (assetId === 'RN0174-SV-00018' || assetId.includes('001900'));
      let estadoFisicoText = 'VERIFICADO';
      let estadoFisicoColor = '#16a34a';

      if (fam.includes('ILUM') || assetId.includes('-ILU-')) {
        targetGroup = gisLayers.ilum;
        markerColor = '#f59e0b';
      } else if (fam.includes('SEÑAL') || fam.includes('SENAL') || assetId.includes('-SV-')) {
        targetGroup = gisLayers.sen;
        
        if (currentEpoch === 'marzo2026') {
          if (isR23) {
            markerColor = '#dc2626'; // Bright Red for missing signal in March 2026
            estadoFisicoText = '🛑 FALTA (02/03/2026)';
            estadoFisicoColor = '#dc2626';
          } else {
            markerColor = '#10b981'; // Green for ok signals in March 2026
            estadoFisicoText = '🟢 CONFORME (02/03/2026)';
            estadoFisicoColor = '#16a34a';
          }
        } else {
          // Julio 2026 - All signals verified in field
          markerColor = '#10b981';
          estadoFisicoText = '🟢 VERIFICADO (Julio 2026)';
          estadoFisicoColor = '#16a34a';
        }
      } else if (fam.includes('DEFENSA') || fam.includes('CONTENCI') || assetId.includes('-DEF-')) {
        targetGroup = gisLayers.puentes;
        markerColor = '#eab308';
      } else if (fam.includes('ESTRUCTURA') || assetId.includes('PIL') || assetId.includes('BIM')) {
        targetGroup = gisLayers.hitos;
        markerColor = '#0284c7';
      }

      const marker = L.circleMarker([lat, lon], {
        radius: (fam.includes('SEÑAL') && isR23 && currentEpoch === 'marzo2026') ? 9 : 7,
        fillColor: markerColor,
        color: '#ffffff',
        weight: 2,
        fillOpacity: 0.9
      }).addTo(targetGroup);

      marker.bindPopup(`
        <div class="popup-card">
          <div class="popup-header">
            <span><i class="fa-solid fa-cube" style="color:#0284c7;"></i> ${assetId}</span>
            <span class="tag">GIS · ${currentEpoch === 'marzo2026' ? 'Marzo 2026' : 'Julio 2026'}</span>
          </div>
          <table class="popup-table">
            <tr><td class="lbl">ID de activo:</td><td class="val" style="font-family:var(--font-mono); color:#0284c7; font-weight:800;">${info.assetId}</td></tr>
            <tr><td class="lbl">Nombre:</td><td class="val">${info.name}</td></tr>
            <tr><td class="lbl">Progresiva (PK):</td><td class="val">${info.pk}</td></tr>
            <tr><td class="lbl">Familia:</td><td class="val">${info.familia}</td></tr>
            <tr><td class="lbl">Estado físico:</td><td class="val" style="color:${estadoFisicoColor}; font-weight:800;">${estadoFisicoText}</td></tr>
            <tr><td class="lbl">Trazabilidad doc.:</td><td class="val" style="color:${isR23 ? '#b45309' : '#16a34a'}; font-weight:800;">${isR23 ? 'ABIERTA — evidencia pendiente' : 'CONFORME / CERRADA'}</td></tr>
          </table>
          <a href="#" class="popup-link" onclick="selectAssetById('${assetId}', 'gis'); return false;" style="margin-top:6px; font-weight:700; color:#0284c7; font-size:10.5px; display:inline-block; text-decoration:none;">Ver en 3D IFC & CDE &gt;</a>
        </div>
      `, { minWidth: 320, maxWidth: 350 });

      marker.on('click', (e) => {
        selectAssetById(assetId, 'gis');
      });

      gisMarkers[assetId] = marker;
    }
  });

  // Sync layer groups with checkbox states
  ['hitos', 'puentes', 'sen', 'ilum', 'corredor'].forEach(name => {
    const chk = document.getElementById(`chk-${name}`);
    if (chk) toggleGisLayer(name, chk.checked);
  });

  console.log(`[GIS Layers] Successfully rendered ${Object.keys(gisMarkers).length} GIS markers.`);
}

function setTemporalEpoch(epoch) {
  currentEpoch = epoch;
  console.log(`[Temporal Epoch] Switched to epoch: ${epoch}`);
  
  const radMarzo = document.getElementById('rad-epoch-marzo');
  const radJulio = document.getElementById('rad-epoch-julio');
  if (radMarzo && epoch === 'marzo2026') radMarzo.checked = true;
  if (radJulio && epoch === 'julio2026') radJulio.checked = true;

  // Re-render GIS layers with updated temporal colors
  renderGISLayers();

  // If asset selected, refresh bitacora timeline
  if (currentSelectedAsset) {
    renderBitacoraTimeline(currentSelectedAsset);
  }
}

function toggleSenSubOptions(isChecked) {
  const subOptions = document.getElementById('sub-sen-options');
  if (subOptions) {
    subOptions.style.display = isChecked ? 'flex' : 'none';
  }
}

// 6.5 ACCIDENT DATASET LOADING & RENDERING (SINIESTRALIDAD 2003-2024)
async function loadAccidentData() {
  if (window.IS_PUBLIC_DEMO) {
    console.log("[Public Demo Mode] Siniestralidad dataset disabled for public QR access.");
    accidentData = [];
    return;
  }
  try {
    const res = await fetch('./evidencias_cde/SINIESTRALIDAD_HISTORICA_2003_2024.json');
    if (!res.ok) return;
    accidentData = await res.json();
    console.log(`[Siniestralidad] Loaded ${accidentData.length} historical accident records.`);
  } catch (err) {
    console.error("[Siniestralidad Load Error]", err);
  }
}

function renderAccidentLayer() {
  if (!gisMap || !gisLayers.accidents) return;
  gisLayers.accidents.clearLayers();

  if (accidentData.length === 0) return;

  const filtered = accidentData.filter(acc => {
    if (currentAccidentYearFilter === 'ALL') return true;
    if (currentAccidentYearFilter === '2020-2024') return acc.ano >= 2020 && acc.ano <= 2024;
    return String(acc.ano) === String(currentAccidentYearFilter);
  });

  console.log(`[Siniestralidad] Rendering ${filtered.length} accident markers for filter: ${currentAccidentYearFilter}`);

  filtered.forEach(acc => {
    const [lat, lon] = getGisCoordsForAsset(null, { pk: acc.pk_km }, null);

    const marker = L.circleMarker([lat, lon], {
      radius: acc.gravedad === 'FATAL' ? 8 : (acc.gravedad === 'GRAVE' ? 7 : 5),
      fillColor: acc.color,
      color: '#ffffff',
      weight: 1.5,
      fillOpacity: 0.9
    }).addTo(gisLayers.accidents);

    marker.bindPopup(`
      <div class="popup-card">
        <div class="popup-header" style="border-bottom-color:#dc2626;">
          <span><i class="fa-solid fa-triangle-exclamation" style="color:#dc2626;"></i> ${acc.id}</span>
          <span class="tag" style="background:#fee2e2; color:#dc2626;">Año ${acc.ano}</span>
        </div>
        <table class="popup-table">
          <tr><td class="lbl">Año / Progresiva:</td><td class="val" style="font-weight:800;">${acc.ano} · ${acc.pk_km}</td></tr>
          <tr><td class="lbl">Gravedad:</td><td class="val" style="color:${acc.color}; font-weight:800;">${acc.gravedad}</td></tr>
          <tr><td class="lbl">Víctimas / Heridos:</td><td class="val">Fatales: ${acc.victimas_fatales} · Heridos: ${acc.heridos_graves + acc.heridos_leves}</td></tr>
          <tr><td class="lbl">Vehículos:</td><td class="val">${acc.vehiculos_afectados} vehículo(s) (${acc.sentido})</td></tr>
          <tr><td class="lbl">Clima / Calzada:</td><td class="val">${acc.clima || 'Bueno'} · ${acc.estado_calzada || 'Bueno'}</td></tr>
          <tr><td class="lbl">Detalle / Causa:</td><td class="val">${acc.observaciones}</td></tr>
        </table>
      </div>
    `, { minWidth: 320, maxWidth: 350 });
  });
}

function toggleAccidentSubOptions(isChecked) {
  const subOptions = document.getElementById('sub-accidents-options');
  if (subOptions) {
    subOptions.style.display = isChecked ? 'flex' : 'none';
  }
}

function setAccidentYearFilter(yearVal) {
  currentAccidentYearFilter = yearVal;
  console.log(`[Accident Year Filter] Switched to: ${yearVal}`);
  renderAccidentLayer();
}

// INLINE GIS LAYER TOGGLE (DIRECT & INSTANT)
function toggleGisLayer(layerName, isChecked) {
  if (!gisMap || !gisLayers) return;
  const layerGroup = gisLayers[layerName];
  if (!layerGroup) return;

  if (isChecked) {
    if (!gisMap.hasLayer(layerGroup)) gisMap.addLayer(layerGroup);
  } else {
    if (gisMap.hasLayer(layerGroup)) gisMap.removeLayer(layerGroup);
  }
  console.log(`[GIS Layer Toggle] Layer '${layerName}' -> ${isChecked ? 'VISIBLE' : 'HIDDEN'}`);
}

function parsePkToKm(pkVal) {
  if (typeof pkVal === 'number') return pkVal;
  if (!pkVal) return NaN;
  const str = String(pkVal).trim();
  const plusMatch = str.match(/(\d+)\+(\d+)/);
  if (plusMatch) {
    return parseFloat(plusMatch[1]) + (parseFloat(plusMatch[2]) / 1000.0);
  }
  const decMatch = str.match(/(\d+\.\d+)/);
  if (decMatch) {
    return parseFloat(decMatch[1]);
  }
  return NaN;
}

// 7. GROUND-TRUTH LRS GIS COORDINATE INTERPOLATION (EXACT POSTGIS DB ALIGNMENT)
function getGisCoordsForAsset(assetId, assetInfo, elementData) {
  const nameStr = (assetInfo?.name || elementData?.name || assetId || '').toUpperCase();
  const busCodeStr = (assetInfo?.busCode || elementData?.business_code || '').toUpperCase();
  const cleanId = (assetId || '').toUpperCase();

  // 1. Explicit canonical overrides for key BIM bridge assets & signals
  if (cleanId === 'RN0174-SV-00018' || busCodeStr.includes('SV-R23-001900') || nameStr.includes('1900.00_R23')) {
    return [-32.869800, -60.682500];
  }
  if (nameStr.includes('PILA_42') || nameStr.includes('PILA 42') || cleanId.includes('PILA-00042') || busCodeStr.includes('PILA-00042')) {
    return [-32.870410, -60.687323];
  }
  if (nameStr.includes('PILA_43') || nameStr.includes('PILA 43') || cleanId.includes('PILA-00043') || busCodeStr.includes('PILA-00043')) {
    return [-32.869934, -60.683608];
  }

  // 2. Compute PK km
  let pk = parsePkToKm(assetInfo ? assetInfo.pk : null);

  if (isNaN(pk) && elementData && elementData.progresiva_km !== undefined) {
    pk = parsePkToKm(elementData.progresiva_km);
  }
  if (isNaN(pk) && elementData && elementData.centroid && Array.isArray(elementData.centroid)) {
    const xMeters = elementData.centroid[0];
    // 3D local origin X=0 is Pila 42 at PK 1+706
    pk = 1.706 + (xMeters / 1000.0);
  }
  if (isNaN(pk) && assetInfo && assetInfo.busCode) {
    const m = assetInfo.busCode.match(/(\d{6})/);
    if (m) pk = parseFloat(m[1]) / 1000.0;
  }
  if (isNaN(pk)) pk = 1.900;

  // Calibrated ground-truth PostGIS keypoints matching Google Maps satellite highway centerline
  const keypoints = [
    { pk: 0.000, lat: -32.874570, lon: -60.702460 },
    { pk: 0.544, lat: -32.872340, lon: -60.699110 },
    { pk: 1.272, lat: -32.870890, lon: -60.691240 },
    { pk: 1.706, lat: -32.870410, lon: -60.687323 }, // Pila 42 Torre Principal Rosario (Google Maps Match)
    { pk: 1.790, lat: -32.869934, lon: -60.683608 }, // Pila 43 Torre Principal Victoria (Google Maps Match)
    { pk: 1.900, lat: -32.869800, lon: -60.682500 }, // PK 1+900 Señal R.23
    { pk: 2.127, lat: -32.869600, lon: -60.680900 },
    { pk: 3.428, lat: -32.864000, lon: -60.650000 },
    { pk: 4.500, lat: -32.862000, lon: -60.635000 }
  ];

  if (pk <= keypoints[0].pk) return [keypoints[0].lat, keypoints[0].lon];
  if (pk >= keypoints[keypoints.length - 1].pk) {
    const last = keypoints[keypoints.length - 1];
    return [last.lat, last.lon];
  }

  for (let i = 0; i < keypoints.length - 1; i++) {
    const k1 = keypoints[i];
    const k2 = keypoints[i + 1];
    if (pk >= k1.pk && pk <= k2.pk) {
      const t = (pk - k1.pk) / (k2.pk - k1.pk);
      const lat = k1.lat + t * (k2.lat - k1.lat);
      const lon = k1.lon + t * (k2.lon - k1.lon);
      return [lat, lon];
    }
  }

  return [-32.86986, -60.68303];
}

// 8. DYNAMIC METADATA EXTRACTION & NORMALIZATION
function getElementInfo(assetId, elementData) {
  if (!assetId && elementData && elementData.asset_id) {
    assetId = elementData.asset_id;
  }
  if (!assetId && elementData && elementData.business_code) {
    assetId = elementData.business_code;
  }

  const asset = (assetId && assetIndex[assetId]) ? assetIndex[assetId] : {};
  const pset = (elementData && elementData.pset_aim_asset) ? elementData.pset_aim_asset : {};

  const name = elementData.name || pset.name || asset.familia || assetId || "Activo RN174";
  const busCode = pset.business_code || asset.business_code || elementData.business_code || assetId;

  // Explicit AIM SSOT Overrides for Señal R.23 (RN0174-SV-00018)
  if (assetId === 'RN0174-SV-00018' || (busCode && busCode.includes('SV-R23-001900')) || (name && name.includes('1900.00_R23'))) {
    return {
      assetId: 'RN0174-SV-00018',
      busCode: 'RN0174-TC-Z01-SV-R23-001900-I',
      guid: '0EQTL3TJHexxoj8ZK_UwLp',
      ifcEntity: 'IfcSign',
      name: 'Senal_Vertical_PK_1900.00_R23',
      normativo: 'R.23 — Camiones circulan por la derecha',
      concesion: '46',
      dimensiones: '0,90 × 0,90 m',
      estadoOp: 'OPERATIVO',
      estadoVerif: 'VERIFICADO',
      familia: 'Señalización Vertical',
      subsistema: 'Señalización vial',
      fuente: 'Evidencias vinculadas: plano / inventario / relevamiento / verificación',
      margen: 'Margen izquierda — columna New Jersey central',
      plano: 'RVA_L-C-DT-020',
      pk: 'PK 1+900 (1.900 km)',
      lat: -32.86980,
      lon: -60.68303,
      revCde: 'P01.01',
      estadoCde: 'PUBLISHED',
      emisionFicha: '13/09/2026',
      ultActualizacion: 'Julio 2026',
      ultEvidencia: 'RN0174-SV-00018_Evidencia_Julio_2026.jpg'
    };
  }

  // Extract raw text for categorization
  let rawFam = (asset.familia || pset.familia || elementData.familia || name || assetId || '').toUpperCase();
  let rawSub = (asset.subsistema || pset.subsistema || elementData.subsistema || '').toUpperCase();
  let rawCls = (elementData.ifc_class || '').toUpperCase();
  let rawId = (assetId || '').toUpperCase();

  let familia = 'Estructuras de Puente';
  let subsistema = 'Estructuras y Obras de Arte';
  let plano = 'RVA_O-C-IM-601 / GE-600';
  let normativo = pset.codigo_normativo || asset.codigo_normativo || '-';
  let concesion = pset.concesion_item || asset.concesion_item || '-';
  let dimensiones = pset.dimensiones || asset.dimensiones || '-';
  let estadoOp = pset.estado_operativo || asset.estado_operativo || 'OPERATIVO';
  let estadoVerif = 'VERIFICADO';
  let margen = pset.margen || asset.margen || 'Margen derecha';

  if (rawFam.includes('DEFENSA') || rawFam.includes('CONTENCI') || rawSub.includes('CONTENCI') || rawSub.includes('LATERAL') || rawId.includes('-DEF-')) {
    familia = 'Defensas y Contención';
    subsistema = 'Sistemas de Contención Lateral';
    plano = rawId.includes('P42') ? 'RVA_D-C-EA-251/68 / O-C-EN-301/306' : 'RVA_L-C-TP-003';
  } else if (rawFam.includes('SEÑAL') || rawFam.includes('SENAL') || rawFam.includes('VERT') || rawSub.includes('SEÑAL') || rawSub.includes('SENAL') || rawCls.includes('SIGN') || rawId.includes('-SV-')) {
    familia = 'Señalización Vertical';
    subsistema = 'Señalización Vial';
    plano = 'RVA_L-C-DT-020';
  } else if (rawFam.includes('ILUM') || rawFam.includes('BALIZ') || rawSub.includes('ILUM') || rawSub.includes('ELÉCTR') || rawSub.includes('ELECTR') || rawCls.includes('LIGHT') || rawId.includes('-ILU-')) {
    familia = 'Iluminación Vial';
    subsistema = 'Sistemas Eléctricos e Iluminación';
    plano = 'RVA_ELE_ILU_01';
  } else if (rawFam.includes('PAVIMENT') || rawFam.includes('CALZADA') || rawSub.includes('CALZADA') || rawCls.includes('SLAB') || rawId.includes('-PAV-')) {
    familia = 'Pavimento Flexible';
    subsistema = 'Infraestructura de Calzada';
    plano = 'RVA_LCTP502';
  } else {
    familia = 'Estructuras de Puente';
    subsistema = 'Estructuras y Obras de Arte';
    plano = pset.plano_conforme_obra || asset.plano_conforme_obra || 'RVA_O-C-IM-601 / GE-600';
  }

  // Extract progresiva_km
  let pk = asset.progresiva_km;
  if (pk === undefined || pk === null) pk = pset.progresiva_km;
  if (pk === undefined || pk === null) pk = elementData.progresiva_km;
  if (pk === undefined || pk === null) {
    if (elementData && elementData.centroid) {
      pk = 0.544 + (elementData.centroid[0] / 1000.0);
    } else {
      const m = (busCode || '').match(/(\d{6})/);
      if (m) pk = parseFloat(m[1]) / 1000.0;
      else pk = 1.500;
    }
  }
  if (typeof pk === 'number') {
    pk = `PK ${pk.toFixed(3)}`;
  }

  return { assetId, busCode, name, familia, subsistema, pk, plano, normativo, concesion, dimensiones, estadoOp, estadoVerif, margen };
}

// 9. GIS PANNING & HIGHLIGHTING (SMOOTH LRS FLYTO FOR ALL ASSETS)
function panGisToAsset(assetId, assetInfo) {
  if (!gisMap) return;

  gisMap.invalidateSize();

  const info = assetInfo || getElementInfo(assetId);
  const mesh = findMeshForAsset(assetId);
  const elementData = mesh ? mesh.userData : info;

  let lat, lon;
  if (assetId && gisMarkers[assetId]) {
    const latLng = gisMarkers[assetId].getLatLng();
    lat = latLng.lat;
    lon = latLng.lng;
  } else {
    [lat, lon] = getGisCoordsForAsset(assetId, info, elementData);
  }

  if (!lat || !lon) return;

  console.log(`[GIS FlyTo] Flying to position Lat: ${lat.toFixed(5)}, Lon: ${lon.toFixed(5)} for Asset: ${assetId} (${info.pk})`);

  gisMap.flyTo([lat, lon], 17, {
    animate: true,
    duration: 1.0
  });

  if (selectedGisHighlight) {
    selectedGisHighlight.setLatLng([lat, lon]);
  } else {
    selectedGisHighlight = L.circleMarker([lat, lon], {
      radius: 12,
      fillColor: '#ef4444',
      color: '#991b1b',
      weight: 3,
      opacity: 1,
      fillOpacity: 0.95
    }).addTo(gisMap);
  }

  const isR23 = (info.assetId === 'RN0174-SV-00018' || (info.busCode && info.busCode.includes('001900')));
  const trazabilityStatusHtml = isR23 
    ? '<span style="color:#b45309; font-weight:800;">ABIERTA — evidencia pendiente</span>'
    : '<span style="color:#16a34a; font-weight:800;">CONFORME / CERRADA</span>';

  selectedGisHighlight.bindPopup(`
    <div class="popup-card">
      <div class="popup-header">
        <span><i class="fa-solid fa-cube" style="color:#0284c7;"></i> ${info.assetId}</span>
        <span class="tag">AIM · GIS</span>
      </div>
      <table class="popup-table">
        <tr><td class="lbl">ID de activo:</td><td class="val" style="font-family:var(--font-mono); color:#0284c7; font-weight:800;">${info.assetId}</td></tr>
        <tr><td class="lbl">Nombre:</td><td class="val">${info.name || info.assetId}</td></tr>
        <tr><td class="lbl">Progresiva (PK):</td><td class="val">${info.pk}</td></tr>
        <tr><td class="lbl">Coordenadas:</td><td class="val" style="font-family:var(--font-mono);">WGS84 — Lat.: ${lat.toFixed(5)} · Lon.: ${lon.toFixed(5)}</td></tr>
        <tr><td class="lbl">Ubicación:</td><td class="val">${info.margen}</td></tr>
        <tr><td class="lbl">Estado físico:</td><td class="val" style="color:#16a34a; font-weight:800;">VERIFICADO</td></tr>
        <tr><td class="lbl">Trazabilidad doc.:</td><td class="val">${trazabilityStatusHtml}</td></tr>
      </table>
    </div>
  `, { minWidth: 300, maxWidth: 350 }).openPopup();

  if (assetId && gisMarkers[assetId]) {
    gisMarkers[assetId].openPopup();
  }
}

// HELPER FOR FINDING 3D MESH AND FLYING CAMERA
function findMeshForAsset(assetId) {
  if (!assetId) return null;
  const cleanId = assetId.trim().toUpperCase();

  if (assetMeshMap[assetId] && assetMeshMap[assetId].length > 0) return assetMeshMap[assetId][0];
  if (assetMeshMap[cleanId] && assetMeshMap[cleanId].length > 0) return assetMeshMap[cleanId][0];

  const indexed = assetIndex[assetId] || assetIndex[cleanId];
  if (indexed) {
    if (indexed.asset_id && assetMeshMap[indexed.asset_id]) return assetMeshMap[indexed.asset_id][0];
    if (indexed.business_code && assetMeshMap[indexed.business_code]) return assetMeshMap[indexed.business_code][0];
  }

  for (const mesh of Object.values(meshMap)) {
    const ud = mesh.userData || {};
    const mId = (ud.asset_id || '').trim().toUpperCase();
    const mBcode = (ud.business_code || '').trim().toUpperCase();
    const mGuid = (ud.ifc_global_id || '').trim().toUpperCase();
    const mName = (ud.name || '').trim().toUpperCase();

    if (mId === cleanId || mBcode === cleanId || mGuid === cleanId || (cleanId.length > 5 && mName.includes(cleanId))) {
      return mesh;
    }
  }
  return null;
}

function fly3DCameraTo(cx, cy, cz) {
  if (!threeCamera || !threeControls) return;
  threeControls.target.set(cx, cy, cz);
  threeCamera.position.set(cx + 25, cy + 18, cz + 30);
  threeControls.update();
}

// 9. SELECTING 3D ELEMENT (EXACT ATTRIBUTES SYNC, NO STUCK FALLBACKS)
function select3DElement(mesh, data, source) {
  try {
    if (selectedMesh && selectedMeshOrigMat) {
      selectedMesh.material = selectedMeshOrigMat;
      selectedMesh = null;
      selectedMeshOrigMat = null;
    }

    // Highlight Mesh in Bright Yellow (#facc15)
    selectedMesh = mesh;
    selectedMeshOrigMat = mesh.material;
    mesh.material = MATERIALS.HIGHLIGHT;

    if (data && data.centroid && source !== 'walk') {
      const [cx, cy, cz] = data.centroid;
      fly3DCameraTo(cx, cy, cz);
    }

    const info = getElementInfo(data ? data.asset_id : null, data || {});
    currentSelectedAsset = info;

    console.log(`[3D Element Clicked] Asset: ${info.assetId} | Code: ${info.busCode} | PK: ${info.pk} | Familia: ${info.familia}`);

    // Update Bottom Drawer FIRST so metadata updates immediately regardless of secondary calls
    updateBottomDrawer(info);

    // PAN GIS MAP
    try { panGisToAsset(info.assetId, info); } catch(e) { console.error("Error in panGisToAsset:", e); }

    // UPDATE CDE TREE & BITÁCORA
    try { renderCDETree(info, data); } catch(e) { console.error("Error in renderCDETree:", e); }
    try { renderBitacoraTimeline(info); } catch(e) { console.error("Error in renderBitacoraTimeline:", e); }

  } catch (err) {
    console.error("Error in select3DElement:", err);
  }
}

function selectAssetById(assetId, source) {
  try {
    console.log(`[selectAssetById] Selecting asset: ${assetId} from source: ${source}`);
    const info = getElementInfo(assetId, assetIndex[assetId] || {});
    currentSelectedAsset = info;

    // Update Bottom Drawer FIRST
    updateBottomDrawer(info);

    const mesh = findMeshForAsset(assetId);
    if (mesh) {
      if (selectedMesh && selectedMeshOrigMat) {
        selectedMesh.material = selectedMeshOrigMat;
      }
      selectedMesh = mesh;
      selectedMeshOrigMat = mesh.material;
      mesh.material = MATERIALS.HIGHLIGHT;

      if (mesh.userData && mesh.userData.centroid && source !== 'walk') {
        const [cx, cy, cz] = mesh.userData.centroid;
        fly3DCameraTo(cx, cy, cz);
      }
    } else {
      console.warn(`[selectAssetById] No 3D mesh found for asset: ${assetId}`);
    }

    try { panGisToAsset(assetId, info); } catch(e) { console.error("Error in panGisToAsset:", e); }
    try { renderCDETree(info, info); } catch(e) { console.error("Error in renderCDETree:", e); }
    try { renderBitacoraTimeline(info); } catch(e) { console.error("Error in renderBitacoraTimeline:", e); }

  } catch (err) {
    console.error("Error in selectAssetById:", err);
  }
}

// RENDER CDE TREE WITH ISO 19650 SSOT STRUCTURE
function renderCDETree(info, elementData) {
  const container = document.getElementById('cde-tree-root');
  if (!container) return;

  const assetId = info.assetId;
  const plano = info.plano;
  const cdeUrl = (elementData && elementData.cde_url) ? elementData.cde_url : 'https://drive.google.com/file/d/11GxFWMQTU6iCbS7Lpi8X9JL5v_E7Cq8d/view?usp=drivesdk';
  const isR23 = (info.assetId === 'RN0174-SV-00018' || (info.busCode && info.busCode.includes('001900')));

  const assetFolderFiles = isR23 ? `
    <div class="cde-file selected" onclick="openCDEDocument('${cdeUrl}', 'Ficha_Tecnica_${assetId}.pdf', '${assetId}', event)">
      <div class="file-name"><i class="fa-solid fa-file-lines" style="color:#0284c7;"></i> Ficha_Tecnica_${assetId}.pdf</div>
      <div class="file-state">Publicado</div>
    </div>
    <div class="cde-file" onclick="openCDEDocument('${cdeUrl}', '${assetId}_Foto_Relevamiento_FALTA_Marzo_2026.jpg', '${assetId}', event)">
      <div class="file-name"><i class="fa-solid fa-image" style="color:#dc2626;"></i> ${assetId}_Foto_Relevamiento_FALTA_Marzo_2026.jpg</div>
      <div class="file-state" style="background:#fee2e2; color:#dc2626;">FALTA</div>
    </div>
    <div class="cde-file" onclick="openCDEDocument('${cdeUrl}', '${assetId}_Evidencia_Julio_2026.jpg', '${assetId}', event)">
      <div class="file-name"><i class="fa-solid fa-image" style="color:#10b981;"></i> ${assetId}_Evidencia_Julio_2026.jpg</div>
      <div class="file-state">Verificado</div>
    </div>
  ` : `
    <div class="cde-file selected" onclick="openCDEDocument('${cdeUrl}', 'Ficha_Tecnica_${assetId}.pdf', '${assetId}', event)">
      <div class="file-name"><i class="fa-solid fa-file-lines" style="color:#0284c7;"></i> Ficha_Tecnica_${assetId}.pdf</div>
      <div class="file-state">Publicado</div>
    </div>
    <div class="cde-file" onclick="openCDEDocument('${cdeUrl}', '${assetId}_Plano_Conforme_Obra.pdf', '${assetId}', event)">
      <div class="file-name"><i class="fa-solid fa-file-pdf" style="color:#ef4444;"></i> ${assetId}_Plano_Conforme_Obra.pdf</div>
      <div class="file-state">Aprobado</div>
    </div>
    <div class="cde-file" onclick="openCDEDocument('${cdeUrl}', '${assetId}_Inspeccion_Campo_2026.jpg', '${assetId}', event)">
      <div class="file-name"><i class="fa-solid fa-image" style="color:#10b981;"></i> ${assetId}_Inspeccion_Campo_2026.jpg</div>
      <div class="file-state">Verificado</div>
    </div>
  `;

  const html = `
    <div class="cde-folder">
      <i class="fa-solid fa-folder-open" style="color:#eab308;"></i> 📁 CDE_RN174_MASTER
    </div>
    
    <div class="cde-subfolder-list">
      
      <!-- 01 MODELOS BIM -->
      <div class="cde-folder">
        <i class="fa-solid fa-folder-open" style="color:#38bdf8;"></i> 📁 01_MODELOS_BIM (PUBLISHED)
      </div>
      <div class="cde-subfolder-list">
        <div class="cde-file" onclick="openCDEDocument('${cdeUrl}', 'RN174_GEMELO_DIGITAL_PUENTE_COMPLETO.ifc', '${assetId}', event)">
          <div class="file-name"><i class="fa-solid fa-cube" style="color:#0284c7;"></i> RN174_GEMELO_DIGITAL_PUENTE_COMPLETO.ifc</div>
          <div class="file-state">IFC4.3</div>
        </div>
      </div>

      <!-- 02 PROYECTO Y CONFORME A OBRA -->
      <div class="cde-folder">
        <i class="fa-solid fa-folder-open" style="color:#38bdf8;"></i> 📁 02_PROYECTO_Y_CONFORME_A_OBRA
      </div>
      <div class="cde-subfolder-list">
        <div class="cde-file" onclick="openCDEDocument('${cdeUrl}', 'RVA_0-C-IM-601_GE-600_Plano_Conforme_Obra.pdf', '${assetId}', event)">
          <div class="file-name"><i class="fa-solid fa-file-pdf" style="color:#ef4444;"></i> RVA_0-C-IM-601 / GE-600_Plano_Conforme_Obra.pdf</div>
          <div class="file-state">PDF</div>
        </div>
        <div class="cde-file" onclick="openCDEDocument('${cdeUrl}', '${plano}_Plano_Senalizacion.pdf', '${assetId}', event)">
          <div class="file-name"><i class="fa-solid fa-file-pdf" style="color:#ef4444;"></i> ${plano}_Plano_Senalizacion.pdf</div>
          <div class="file-state">PDF</div>
        </div>
      </div>

      <!-- 03 RELEVAMIENTOS E INVENTARIOS -->
      <div class="cde-folder">
        <i class="fa-solid fa-folder-open" style="color:#38bdf8;"></i> 📁 03_RELEVAMIENTOS_INVENTARIOS
      </div>
      <div class="cde-subfolder-list">
        <div class="cde-file" onclick="openCDEDocument('${cdeUrl}', 'Inventario_Vial_Faltantes_Marzo_2026.xlsx', '${assetId}', event)">
          <div class="file-name"><i class="fa-solid fa-file-excel" style="color:#16a34a;"></i> Inventario_Vial_Faltantes_Marzo_2026.xlsx</div>
          <div class="file-state" style="background:#e2e8f0; color:#475569;">INVENTARIO</div>
        </div>
      </div>

      <!-- 04 CARPETAS DE ACTIVOS -->
      <div class="cde-folder" style="background:#e0f2fe; border-radius:4px;">
        <i class="fa-solid fa-folder-open" style="color:#0284c7;"></i> 📁 04_CARPETAS_DE_ACTIVOS / 📂 ${assetId}
      </div>
      <div class="cde-subfolder-list">
        ${assetFolderFiles}
      </div>

    </div>
  `;

  container.innerHTML = html;

  // Render initial default document (Ficha Técnica)
  renderCDEDocViewer(`Ficha_Tecnica_${assetId}.pdf`, info);
}

// RENDER BITÁCORA TIMELINE (5 STAGES FOR AUDIT ASSETS VS 4 STAGES FOR STANDARD ASSETS)
function renderBitacoraTimeline(info) {
  const container = document.getElementById('bitacora-container');
  if (!container) return;

  const isR23 = (info.assetId === 'RN0174-SV-00018' || (info.busCode && info.busCode.includes('001900')));

  let html = '';

  if (isR23) {
    // 5-STAGE AUDIT TIMELINE FOR SEÑAL R.23
    html = `
      <div class="bitacora-title">
        <span><i class="fa-solid fa-clock-rotate-left" style="color:#0284c7;"></i> CRONOLOGÍA DE TRAZABILIDAD DE LA INFORMACIÓN DEL ACTIVO</span>
        <span class="bitacora-subtitle">Activo: RN0174-SV-00018 · PK 1+900 (Caso de Auditoría CDE)</span>
      </div>
      
      <div class="bitacora-timeline">
        
        <!-- ETAPA 1 -->
        <div class="bitacora-step active-ok">
          <div class="step-number">1</div>
          <div class="step-content">
            <div class="step-header">
              <span>1. Proyecto</span>
              <span class="badge-status-ok">REQUERIDO</span>
            </div>
            <div class="step-desc">El plano de proyecto establece la instalación de una señal R.23 en PK 1+900.</div>
            <div class="step-evidence"><i class="fa-solid fa-file-pdf" style="color:#ef4444;"></i> Evidencia: Plano de proyecto RVA_L-C-DT-020</div>
          </div>
        </div>

        <!-- ETAPA 2 -->
        <div class="bitacora-step">
          <div class="step-number">2</div>
          <div class="step-content">
            <div class="step-header">
              <span>2. Inventario vial 2025</span>
              <span style="color:#dc2626; font-weight:700; font-size:9px;">NO REGISTRADO</span>
            </div>
            <div class="step-desc">La señal no figura registrada como activo en el inventario vial 2025.</div>
            <div class="step-evidence"><i class="fa-solid fa-table" style="color:#64748b;"></i> Evidencia: Inventario Vial RN174 2025</div>
          </div>
        </div>

        <!-- ETAPA 3 -->
        <div class="bitacora-step active-falta">
          <div class="step-number">3</div>
          <div class="step-content">
            <div class="step-header">
              <span>3. Relevamiento 02/03/2026</span>
              <span class="badge-status-falta">FALTA</span>
            </div>
            <div class="step-desc">Relevamiento de campo: se verifica la ausencia de la señal R.23 en la columna New Jersey central.</div>
            <div class="step-evidence"><i class="fa-solid fa-file-excel" style="color:#16a34a;"></i> Evidencia: Inventario_Vial_Faltantes_Marzo_2026.xlsx</div>
          </div>
        </div>

        <!-- ETAPA 4 -->
        <div class="bitacora-step">
          <div class="step-number">4</div>
          <div class="step-content">
            <div class="step-header">
              <span>4. Modificación física / Intervención</span>
              <span style="background:#fef3c7; color:#b45309; font-weight:800; font-size:9px; padding:2px 6px; border-radius:4px; border:1px solid #fde68a;">
                <i class="fa-solid fa-triangle-exclamation"></i> PENDIENTE DE VINCULAR
              </span>
            </div>
            <div class="step-desc">La comparación entre los relevamientos de marzo y julio evidencia una modificación física del activo. La documentación de la intervención aún no se encuentra vinculada en el CDE.</div>
            <div class="step-evidence"><i class="fa-solid fa-file-circle-exclamation" style="color:#d97706;"></i> Evidencia documental de intervención: pendiente de vincular</div>
          </div>
        </div>

        <!-- ETAPA 5 -->
        <div class="bitacora-step active-ok">
          <div class="step-number">5</div>
          <div class="step-content">
            <div class="step-header">
              <span>5. Verificación</span>
              <span class="badge-status-ok">VERIFICADO</span>
            </div>
            <div class="step-desc">La señal R.23 se observa instalada y es verificada visualmente en campo.</div>
            <div class="step-evidence"><i class="fa-solid fa-camera" style="color:#0284c7;"></i> Evidencia: RN0174-SV-00018_Evidencia_Julio_2026.jpg</div>
          </div>
        </div>

      </div>

      <!-- 4 INDEPENDENT VARIABLE FINAL STATUS BLOCK -->
      <div class="bitacora-summary-bar" style="display:grid; grid-template-columns:1fr 1fr; gap:6px;">
        <div class="bitacora-summary-box summary-box-fisico">
          <i class="fa-solid fa-circle-check"></i> Estado físico: VERIFICADO · Estado operativo: OPERATIVO
        </div>
        <div class="bitacora-summary-box summary-box-doc">
          <i class="fa-solid fa-folder-open"></i> Estado de trazabilidad: ABIERTA — evidencia documental pendiente de vincular
        </div>
      </div>
    `;
  } else {
    // 4-STAGE COMPLIANT TIMELINE FOR ALL STANDARD ASSETS
    html = `
      <div class="bitacora-title">
        <span><i class="fa-solid fa-clock-rotate-left" style="color:#0284c7;"></i> CRONOLOGÍA DE TRAZABILIDAD DE LA INFORMACIÓN DEL ACTIVO</span>
        <span class="bitacora-subtitle">Activo: ${info.assetId} · ${info.pk} · ${info.familia}</span>
      </div>
      
      <div class="bitacora-timeline">
        
        <!-- ETAPA 1 -->
        <div class="bitacora-step active-ok">
          <div class="step-number">1</div>
          <div class="step-content">
            <div class="step-header">
              <span>1. Proyecto Ejecutivo / Diseño</span>
              <span class="badge-status-ok">CONFORME</span>
            </div>
            <div class="step-desc">Diseño original registrado y acotado según especificaciones técnicas de la traza RN174.</div>
            <div class="step-evidence"><i class="fa-solid fa-file-pdf" style="color:#ef4444;"></i> Evidencia: ${info.plano}</div>
          </div>
        </div>

        <!-- ETAPA 2 -->
        <div class="bitacora-step active-ok">
          <div class="step-number">2</div>
          <div class="step-content">
            <div class="step-header">
              <span>2. Conforme a Obra</span>
              <span class="badge-status-ok">APROBADO</span>
            </div>
            <div class="step-desc">Construcción y recepción técnica registrada en plano Conforme a Obra oficial.</div>
            <div class="step-evidence"><i class="fa-solid fa-file-pdf" style="color:#ef4444;"></i> Evidencia: Plano Conforme a Obra CDE</div>
          </div>
        </div>

        <!-- ETAPA 3 -->
        <div class="bitacora-step active-ok">
          <div class="step-number">3</div>
          <div class="step-content">
            <div class="step-header">
              <span>3. Inventario Vial Registrado 2025</span>
              <span class="badge-status-ok">REGISTRADO</span>
            </div>
            <div class="step-desc">Activo catalogado y codificado correctamente en la base de datos de gestión de activos AIM.</div>
            <div class="step-evidence"><i class="fa-solid fa-database" style="color:#0284c7;"></i> Evidencia: Base de Datos de Activos RN174 SSOT</div>
          </div>
        </div>

        <!-- ETAPA 4 -->
        <div class="bitacora-step active-ok">
          <div class="step-number">4</div>
          <div class="step-content">
            <div class="step-header">
              <span>4. Inspección y Verificación Campo 2026</span>
              <span class="badge-status-ok">VERIFICADO</span>
            </div>
            <div class="step-desc">Inspección periódica de campo realizada sin observaciones críticas. Integridad física y operativa confirmada.</div>
            <div class="step-evidence"><i class="fa-solid fa-camera" style="color:#10b981;"></i> Evidencia: Relevamiento_Inspeccion_Campo_2026.jpg</div>
          </div>
        </div>

      </div>

      <!-- 4 INDEPENDENT VARIABLE FINAL STATUS BLOCK -->
      <div class="bitacora-summary-bar" style="display:grid; grid-template-columns:1fr 1fr; gap:6px;">
        <div class="bitacora-summary-box summary-box-fisico">
          <i class="fa-solid fa-circle-check"></i> Estado físico: VERIFICADO · Estado operativo: OPERATIVO
        </div>
        <div class="bitacora-summary-box summary-box-doc" style="background:#f0fdf4; border-color:#bbf7d0; color:#166534;">
          <i class="fa-solid fa-circle-check" style="color:#16a34a;"></i> Estado de trazabilidad: CONFORME / CERRADA (100% Documentado)
        </div>
      </div>
    `;
  }

  container.innerHTML = html;
}

function openCDEDocument(url, docName, assetId, event) {
  const info = currentSelectedAsset || getElementInfo(assetId || 'RN0174-SV-00018');
  
  if (event && event.currentTarget) {
    document.querySelectorAll('.cde-file').forEach(el => el.classList.remove('selected'));
    event.currentTarget.classList.add('selected');
  }

  renderCDEDocViewer(docName, info);
}

function renderCDEDocViewer(docName, info) {
  const viewer = document.getElementById('cde-doc-viewer');
  const nameEl = document.getElementById('cde-doc-name');
  const containerEl = document.getElementById('cde-doc-container');
  const assetEl = document.getElementById('cde-doc-asset');

  if (!viewer) return;

  if (nameEl) nameEl.textContent = docName;
  if (assetEl) assetEl.textContent = info.assetId;

  const isR23 = (info.assetId === 'RN0174-SV-00018' || (info.busCode && info.busCode.includes('001900')));
  const isFalta = docName.toUpperCase().includes('FALTA') || docName.toUpperCase().includes('MARZO_2026');
  const isExcel = docName.toUpperCase().includes('XLSX') || docName.toUpperCase().includes('INVENTARIO');
  const isFicha = docName.toUpperCase().includes('FICHA');
  const isEvidencia = docName.toUpperCase().includes('EVIDENCIA') || docName.toUpperCase().includes('JULIO_2026');
  const isInspeccionCampo = docName.toUpperCase().includes('INSPECCION_CAMPO');
  const isConformeObra = docName.toUpperCase().includes('PLANO_CONFORME_OBRA');

  if (isFicha) {
    if (containerEl) containerEl.textContent = 'Estado CDE: PUBLISHED / Carpetas de Activos';
    const trazabilityVal = isR23 
      ? 'ABIERTA — evidencia documental de la intervención pendiente de vincular'
      : 'CONFORME / CERRADA — 100% trazabilidad documental vinculada en CDE';
    const trazabilityColor = isR23 ? '#b45309' : '#16a34a';

    viewer.innerHTML = `
      <div class="cde-ficha-sheet">
        <div class="ficha-header">
          <div class="gov-title"><i class="fa-solid fa-building-columns" style="color:#0284c7;"></i> DNV · FICHA TÉCNICA DEL ACTIVO · AIM</div>
          <div class="doc-type">AIM · CDE · Gestión de Información</div>
        </div>

        <table class="ficha-table">
          <tr><td class="lbl">ID de activo:</td><td class="val" style="font-family:var(--font-mono); color:#0284c7; font-weight:800;">${info.assetId}</td></tr>
          <tr><td class="lbl">Código de negocio:</td><td class="val" style="font-family:var(--font-mono);">${info.busCode}</td></tr>
          <tr><td class="lbl">Familia / Subtipo:</td><td class="val">${info.familia}</td></tr>
          <tr><td class="lbl">Progresiva (PK):</td><td class="val">${info.pk}</td></tr>
          <tr><td class="lbl">Ubicación:</td><td class="val">${info.margen}</td></tr>
          <tr><td class="lbl">Norma / Código:</td><td class="val">${info.normativo}</td></tr>
          <tr><td class="lbl">Plano de referencia / proyecto:</td><td class="val">${info.plano}</td></tr>
          <tr><td class="lbl">Estado físico:</td><td class="val" style="color:#16a34a; font-weight:800;">VERIFICADO</td></tr>
          <tr><td class="lbl">Estado operativo:</td><td class="val" style="color:#16a34a; font-weight:800;">OPERATIVO</td></tr>
          <tr><td class="lbl">Estado de verificación:</td><td class="val" style="color:#16a34a; font-weight:800;">VERIFICADO</td></tr>
          <tr><td class="lbl">Estado de trazabilidad:</td><td class="val" style="color:${trazabilityColor}; font-weight:800;">
            ${trazabilityVal}
          </td></tr>
          <tr><td class="lbl">Evidencias vinculadas:</td><td class="val">plano / inventario / relevamiento / verificación</td></tr>
        </table>

        ${isR23 ? `
        <a href="evidencias_cde/Ficha_Tecnica_RN0174-SV-00018.pdf" target="_blank" download class="ficha-btn-download">
          <i class="fa-solid fa-file-pdf"></i> Descargar Ficha AIM Publicada
        </a>` : ''}
      </div>
    `;
  } else if (isExcel) {
    if (containerEl) containerEl.textContent = 'Estado CDE: SHARED / Auditoría e Inventarios de Faltantes';
    viewer.innerHTML = `
      <div class="cde-excel-container">
        <div class="excel-tab-bar">
          <span><i class="fa-solid fa-file-excel"></i> Inventario_Vial_Faltantes_Marzo_2026.xlsx</span>
          <span>Hoja: Relevamiento_Faltantes</span>
        </div>
        <table class="cde-excel-table">
          <colgroup>
            <col style="width: 20%;" />
            <col style="width: 10%;" />
            <col style="width: 11%;" />
            <col style="width: 9%;" />
            <col style="width: 17%;" />
            <col style="width: 15%;" />
            <col style="width: 18%;" />
          </colgroup>
          <thead>
            <tr>
              <th>ID Activo</th>
              <th>Norma</th>
              <th>PK</th>
              <th>Margen</th>
              <th>Inv. 2025</th>
              <th>Campo Mar 2026</th>
              <th>Acción Requerida</th>
            </tr>
          </thead>
          <tbody>
            <tr class="row-ok">
              <td>SV-00016</td>
              <td>R.23</td>
              <td>1+500</td>
              <td>IZQ</td>
              <td>EXISTENTE</td>
              <td>🟢 CONFORME</td>
              <td>Ninguna</td>
            </tr>
            <tr class="row-ok">
              <td>SV-00017</td>
              <td>R.23</td>
              <td>1+700</td>
              <td>IZQ</td>
              <td>EXISTENTE</td>
              <td>🟢 CONFORME</td>
              <td>Ninguna</td>
            </tr>
            <tr class="row-falta">
              <td>RN0174-SV-00018</td>
              <td>R.23</td>
              <td>1+900</td>
              <td>IZQ</td>
              <td>NO REGISTRADO</td>
              <td>🛑 FALTA</td>
              <td>INSTALAR SEÑAL R.23 EN COLUMNA NJ</td>
            </tr>
            <tr class="row-ok">
              <td>SV-00019</td>
              <td>R.23</td>
              <td>2+100</td>
              <td>IZQ</td>
              <td>EXISTENTE</td>
              <td>🟢 CONFORME</td>
              <td>Ninguna</td>
            </tr>
          </tbody>
        </table>
      </div>
    `;
  } else if (isFalta) {
    if (containerEl) containerEl.textContent = 'Estado CDE: WORK IN PROGRESS / Relevamiento de Faltantes';
    viewer.innerHTML = `
      <div class="photo-frame-container">
        <img src="foto_relevamiento_marzo_2026_falta.png" alt="Relevamiento FALTA Marzo 2026" />
        <div class="stamp-overlay-falta">
          <i class="fa-solid fa-triangle-exclamation"></i> 🛑 FALTA (02/03/2026)
        </div>
      </div>
      <div style="font-size:10px; color:#991b1b; background:#fee2e2; padding:6px; border-radius:4px; font-weight:700; border:1px solid #fca5a5; margin-top:4px;">
        <i class="fa-solid fa-triangle-exclamation"></i> Relevamiento 02/03/2026: se verifica la ausencia de la señal R.23 en la columna New Jersey central en PK 1+900.
      </div>
    `;
  } else if (isEvidencia) {
    if (containerEl) containerEl.textContent = 'Estado CDE: PUBLISHED / Evidencias Fotográficas MMS';
    viewer.innerHTML = `
      <div class="photo-frame-container">
        <img src="foto_evidencia_julio_2026_ok.png" alt="Evidencia Julio 2026" />
        <div class="stamp-overlay-ok">
          <i class="fa-solid fa-circle-check"></i> 🟢 JULIO 2026 (INSTALADO)
        </div>
      </div>
      <div style="font-size:10px; color:#166534; background:#dcfce7; padding:6px; border-radius:4px; font-weight:700; border:1px solid #86efac; margin-top:4px;">
        <i class="fa-solid fa-circle-check"></i> Verificación visual Julio 2026: La señal R.23 se observa instalada y es verificada visualmente en campo en PK 1+900.
      </div>
    `;
  } else {
    if (containerEl) containerEl.textContent = 'Estado CDE: PUBLISHED / Planos Conforme a Obra';
    viewer.innerHTML = `
      <div class="cde-ficha-sheet">
        <div class="ficha-header">
          <div class="gov-title"><i class="fa-solid fa-map" style="color:#0284c7;"></i> PLANO DE REFERENCIA / PROYECTO · SEÑALIZACIÓN VIAL</div>
          <div class="doc-type">PDF / CAD</div>
        </div>
        <p style="font-size:10px; color:#334155;"><strong>Documento:</strong> ${docName}</p>
        <p style="font-size:10px; color:#334155;"><strong>Plano:</strong> ${info.plano} - Detalle de Señalización Vertical en PK 1+900</p>
        <div style="background:#0f172a; color:#38bdf8; padding:12px; border-radius:4px; font-family:var(--font-mono); font-size:10px; text-align:center;">
          [ VISTA PREVIA PLANO CAD: DETALLE INSTALACIÓN SEÑAL R.23 SOBRE COLUMNA NJ CENTRAL PK 1+900 ]
        </div>
      </div>
    `;
  }
}

// UPDATE BOTTOM DRAWER WITH ALL PSET_AIM_ASSET PROPERTIES
function updateBottomDrawer(info) {
  document.getElementById('drawer-asset-title').innerHTML = `<i class="fa-solid fa-cube" style="color:#0284c7;"></i> ${info.assetId}`;
  document.getElementById('drawer-asset-code').textContent = info.busCode;
  
  if (document.getElementById('drawer-pk')) document.getElementById('drawer-pk').textContent = info.pk || 'PK 1+900';
  if (document.getElementById('drawer-normativo')) document.getElementById('drawer-normativo').textContent = info.normativo || 'R.23 — Prohibición camiones';
  if (document.getElementById('drawer-concesion')) document.getElementById('drawer-concesion').textContent = info.concesion || '46';
  if (document.getElementById('drawer-estado-op')) document.getElementById('drawer-estado-op').textContent = info.estadoOp || 'OPERATIVO';
  if (document.getElementById('drawer-estado-verif')) document.getElementById('drawer-estado-verif').textContent = info.estadoVerif || 'VERIFICADO';
  if (document.getElementById('drawer-margen')) document.getElementById('drawer-margen').textContent = info.margen || 'Margen izquierda — columna NJ central';
  if (document.getElementById('drawer-dimensiones')) document.getElementById('drawer-dimensiones').textContent = info.dimensiones || '0,90 × 0,90 m';
  if (document.getElementById('drawer-plano')) document.getElementById('drawer-plano').textContent = info.plano || 'RVA_L-C-DT-020';
  if (document.getElementById('drawer-familia')) document.getElementById('drawer-familia').textContent = info.familia;
}

// 10. UI HANDLERS
function setupLayerToggle(id, layerGroup) {
  const el = document.getElementById(id);
  if (!el || !gisMap || !layerGroup) return;
  el.addEventListener('change', (e) => {
    if (e.target.checked) {
      if (!gisMap.hasLayer(layerGroup)) gisMap.addLayer(layerGroup);
    } else {
      if (gisMap.hasLayer(layerGroup)) gisMap.removeLayer(layerGroup);
    }
  });
}

function setupUIHandlers() {
  if (document.getElementById('btn-view-3d')) document.getElementById('btn-view-3d').addEventListener('click', () => set3DView('3d'));
  if (document.getElementById('btn-view-walk')) document.getElementById('btn-view-walk').addEventListener('click', () => set3DView('walk'));
  if (document.getElementById('btn-view-top')) document.getElementById('btn-view-top').addEventListener('click', () => set3DView('top'));
  if (document.getElementById('btn-view-front')) document.getElementById('btn-view-front').addEventListener('click', () => set3DView('front'));
  if (document.getElementById('btn-view-side')) document.getElementById('btn-view-side').addEventListener('click', () => set3DView('side'));

  const focusBtn = document.getElementById('btn-focus-3d');
  if (focusBtn) {
    focusBtn.addEventListener('click', () => {
      if (currentSelectedAsset) {
        selectAssetById(currentSelectedAsset.assetId || currentSelectedAsset.asset_id, 'action_btn');
      }
    });
  }

  // Layer Checkboxes
  setupLayerToggle('chk-hitos', gisLayers.hitos);
  setupLayerToggle('chk-puentes', gisLayers.puentes);
  setupLayerToggle('chk-sen', gisLayers.sen);
  setupLayerToggle('chk-ilum', gisLayers.ilum);
  setupLayerToggle('chk-corredor', gisLayers.corredor);

  // Global Search Input & Magnifying Glass Icon Click Handler
  const searchInput = document.getElementById('global-search');
  const searchIcon = document.querySelector('.top-center-search i');

  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      performGlobalSearch(e.target.value);
    });

    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        performGlobalSearch(searchInput.value, true);
      }
    });

    searchInput.addEventListener('focus', (e) => {
      if (e.target.value.trim()) performGlobalSearch(e.target.value);
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.top-center-search')) {
        hideSearchResults();
      }
    });
  }

  if (searchIcon) {
    searchIcon.style.cursor = 'pointer';
    searchIcon.addEventListener('click', () => {
      if (searchInput) performGlobalSearch(searchInput.value, true);
    });
  }
}

function performGlobalSearch(q, forceSelect = false) {
  if (!q) {
    hideSearchResults();
    return;
  }

  const query = q.toLowerCase().trim();
  const results = [];
  const addedIds = new Set();

  // 1. Search in Database AllAssets
  allAssets.forEach(a => {
    const id = a.asset_id || a.business_code || '';
    const name = a.nombre || a.name || '';
    const busCode = a.business_code || '';
    const fam = a.familia || '';
    const pk = a.progresiva_km ? String(a.progresiva_km) : '';

    if (id && !addedIds.has(id.toUpperCase())) {
      if (id.toLowerCase().includes(query) || name.toLowerCase().includes(query) || busCode.toLowerCase().includes(query) || fam.toLowerCase().includes(query) || pk.includes(query)) {
        addedIds.add(id.toUpperCase());
        results.push({
          id: id,
          title: id,
          name: name || id,
          subtitle: `PK ${pk ? 'PK ' + pk : '1+900'} · ${fam || 'Activo AIM'}`
        });
      }
    }
  });

  // 2. Search in 3D Mesh Elements
  Object.values(meshMap).forEach(m => {
    const ud = m.userData || {};
    const id = ud.asset_id || ud.business_code || ud.ifc_global_id || '';
    const name = ud.name || '';
    const busCode = ud.business_code || '';

    if (id && !addedIds.has(id.toUpperCase())) {
      if (id.toLowerCase().includes(query) || name.toLowerCase().includes(query) || busCode.toLowerCase().includes(query)) {
        addedIds.add(id.toUpperCase());
        results.push({
          id: id,
          title: id,
          name: name || id,
          subtitle: `3D IFC · ${ud.ifc_class || 'Elemento 3D'}`
        });
      }
    }
  });

  console.log(`[Global Search] Found ${results.length} matches for '${query}'`);

  if (results.length === 0) {
    hideSearchResults();
    return;
  }

  if (forceSelect && results.length > 0) {
    selectAssetById(results[0].id, 'search');
    hideSearchResults();
    return;
  }

  showSearchResults(results);
}

function showSearchResults(results) {
  let menu = document.getElementById('search-results-dropdown');
  const container = document.querySelector('.top-center-search');
  if (!container) return;

  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'search-results-dropdown';
    menu.className = 'search-results-menu';
    container.appendChild(menu);
  }

  let html = '';
  results.slice(0, 8).forEach(r => {
    html += `
      <div class="search-item" onclick="selectAssetById('${r.id}', 'search'); hideSearchResults();">
        <div>
          <span class="s-id"><i class="fa-solid fa-cube"></i> ${r.id}</span>
          <span style="display:block; font-size:10px; color:#cbd5e1;">${r.name}</span>
        </div>
        <span class="s-sub">${r.subtitle}</span>
      </div>
    `;
  });

  menu.innerHTML = html;
  menu.style.display = 'block';
}

function hideSearchResults() {
  const menu = document.getElementById('search-results-dropdown');
  if (menu) menu.style.display = 'none';
}

function normalizeStr(str) {
  if (!str) return '';
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().trim();
}

// 11. INTELLIGENT CASCADING FILTER CHAIN FOR BOTTOM DRAWER (OPTIMIZED O(N) & ENCODING-ROBUST)
function initDrawerFilters() {
  const subSel = document.getElementById('filter-subsistema');
  const famSel = document.getElementById('filter-familia');
  const pkSel = document.getElementById('filter-pk');
  const assetSel = document.getElementById('filter-asset-select');

  if (!subSel || !famSel || !pkSel || !assetSel) return;

  const assets = Object.values(meshMap).map(m => getElementInfo(m.userData ? m.userData.asset_id : null, m.userData || {}));

  const subsistemas = Array.from(new Set(assets.map(a => a.subsistema).filter(Boolean))).sort();
  let subHtml = '<option value="ALL">-- Todos los Subsistemas --</option>';
  subsistemas.forEach(s => {
    subHtml += `<option value="${s}">${s}</option>`;
  });
  subSel.innerHTML = subHtml;

  onSubsistemaChange();
}

function onSubsistemaChange() {
  const subVal = document.getElementById('filter-subsistema') ? document.getElementById('filter-subsistema').value : 'ALL';
  const famSel = document.getElementById('filter-familia');

  if (!famSel) return;

  const assets = Object.values(meshMap).map(m => getElementInfo(m.userData ? m.userData.asset_id : null, m.userData || {}));

  let matchingAssets = assets;
  if (subVal !== 'ALL') {
    const targetNorm = normalizeStr(subVal);
    matchingAssets = assets.filter(a => normalizeStr(a.subsistema) === targetNorm);
  }

  const familias = Array.from(new Set(matchingAssets.map(a => a.familia).filter(Boolean))).sort();
  let famHtml = '<option value="ALL">-- Todas las Familias --</option>';
  familias.forEach(f => {
    famHtml += `<option value="${f}">${f}</option>`;
  });
  famSel.innerHTML = famHtml;

  onFamiliaChange();
}

function onFamiliaChange() {
  const subVal = document.getElementById('filter-subsistema') ? document.getElementById('filter-subsistema').value : 'ALL';
  const famVal = document.getElementById('filter-familia') ? document.getElementById('filter-familia').value : 'ALL';
  const pkSel = document.getElementById('filter-pk');

  if (!pkSel) return;

  const assets = Object.values(meshMap).map(m => getElementInfo(m.userData ? m.userData.asset_id : null, m.userData || {}));

  let matchingAssets = assets;
  if (subVal !== 'ALL') {
    const subNorm = normalizeStr(subVal);
    matchingAssets = matchingAssets.filter(a => normalizeStr(a.subsistema) === subNorm);
  }
  if (famVal !== 'ALL') {
    const famNorm = normalizeStr(famVal);
    matchingAssets = matchingAssets.filter(a => normalizeStr(a.familia) === famNorm);
  }

  const pks = Array.from(new Set(matchingAssets.map(a => a.pk).filter(Boolean)))
    .sort((a, b) => parseFloat(a) - parseFloat(b));

  let pkHtml = '<option value="ALL">-- Todas las PKs --</option>';
  pks.forEach(p => {
    pkHtml += `<option value="${p}">PK ${p} km</option>`;
  });
  pkSel.innerHTML = pkHtml;

  onPkChange();
}

function onPkChange() {
  populateDrawerAssetSelect();
}

function populateDrawerAssetSelect() {
  const subVal = document.getElementById('filter-subsistema') ? document.getElementById('filter-subsistema').value : 'ALL';
  const famVal = document.getElementById('filter-familia') ? document.getElementById('filter-familia').value : 'ALL';
  const pkVal = document.getElementById('filter-pk') ? document.getElementById('filter-pk').value : 'ALL';
  const assetSel = document.getElementById('filter-asset-select');

  if (!assetSel) return;

  const filtered = [];
  const processedIds = new Set();
  const subNorm = normalizeStr(subVal);
  const famNorm = normalizeStr(famVal);

  Object.values(meshMap).forEach(m => {
    const el = m.userData || {};
    const info = getElementInfo(el.asset_id || el.business_code, el);
    const aId = info.assetId;

    if (!aId || processedIds.has(aId)) return;

    if (subVal !== 'ALL' && normalizeStr(info.subsistema) !== subNorm) return;
    if (famVal !== 'ALL' && normalizeStr(info.familia) !== famNorm) return;
    if (pkVal !== 'ALL' && info.pk !== pkVal) return;

    processedIds.add(aId);
    filtered.push(info);
  });

  filtered.sort((a, b) => a.assetId.localeCompare(b.assetId));

  let assetHtml = `<option value="">-- Seleccionar Activo (${filtered.length}) --</option>`;
  for (let i = 0; i < filtered.length; i++) {
    const info = filtered[i];
    assetHtml += `<option value="${info.assetId}">${info.assetId} - ${info.name}</option>`;
  }

  assetSel.innerHTML = assetHtml;
}

function onDrawerAssetSelect() {
  const assetSel = document.getElementById('filter-asset-select');
  if (!assetSel) return;
  const selectedAssetId = assetSel.value;

  if (selectedAssetId) {
    console.log(`[Drawer Cascading Select] Selected Asset: ${selectedAssetId}`);
    selectAssetById(selectedAssetId, 'drawer_dropdown');
  }
}

function set3DView(mode) {
  const projBtns = document.querySelectorAll('.proj-btn');
  projBtns.forEach(b => b.classList.remove('active'));
  
  const targetBtn = document.getElementById(`btn-view-${mode}`);
  if (targetBtn) targetBtn.classList.add('active');

  if (mode === 'walk') {
    threeCamera.position.set(0, 10, 160);
    threeControls.target.set(0, 12, -200);
  } else if (mode === 'top') {
    threeCamera.position.set(0, 300, 0.1);
    threeControls.target.set(0, 0, 0);
  } else if (mode === 'front') {
    threeCamera.position.set(0, 15, 300);
    threeControls.target.set(0, 15, 0);
  } else if (mode === 'side') {
    threeCamera.position.set(300, 15, 0);
    threeControls.target.set(0, 15, 0);
  } else {
    threeCamera.position.set(120, 80, 160);
    threeControls.target.set(0, 10, 0);
  }

  threeControls.update();
}

// 12. MOBILE RESPONSIVE TAB SWITCHER (Propuesta A)
function switchMobileTab(tabNum) {
  if (window.innerWidth > 768) return;

  const panels = document.querySelectorAll('.tri-split-workspace .panel-col');
  const tabs = document.querySelectorAll('.mobile-nav-tab');

  panels.forEach((p, idx) => {
    if (idx === (tabNum - 1)) {
      p.classList.add('mobile-active');
    } else {
      p.classList.remove('mobile-active');
    }
  });

  tabs.forEach((t) => {
    const tVal = parseInt(t.getAttribute('data-tab') || '1', 10);
    if (tVal === tabNum) {
      t.classList.add('active');
    } else {
      t.classList.remove('active');
    }
  });

  // Force map / 3D canvas resize trigger
  if (tabNum === 1 && gisMap) {
    setTimeout(() => gisMap.invalidateSize(), 150);
  } else if (tabNum === 2 && threeRenderer && threeCamera) {
    setTimeout(() => {
      const container = document.querySelector('.panel-col:nth-child(2) .panel-body');
      if (container) {
        const w = container.clientWidth || 350;
        const h = container.clientHeight || 450;
        threeCamera.aspect = w / h;
        threeCamera.updateProjectionMatrix();
        threeRenderer.setSize(w, h);
      }
    }, 150);
  }
}

// Mobile Initial tab trigger
window.addEventListener('load', () => {
  if (window.innerWidth <= 768) {
    switchMobileTab(1);
  }
});

window.addEventListener('resize', () => {
  if (window.innerWidth <= 768) {
    const activeTab = document.querySelector('.mobile-nav-tab.active');
    const tabNum = activeTab ? parseInt(activeTab.getAttribute('data-tab') || '1', 10) : 1;
    switchMobileTab(tabNum);
  } else {
    // Reset desktop panels
    document.querySelectorAll('.tri-split-workspace .panel-col').forEach(p => {
      p.classList.remove('mobile-active');
    });
  }
});

function toggleMobileGisLayers(e) {
  if (e) e.stopPropagation();
  const card = document.querySelector('.gis-layers-card');
  const chevron = document.getElementById('icon-chevron-layers');
  if (!card) return;

  card.classList.toggle('mobile-expanded');
  const isExpanded = card.classList.contains('mobile-expanded');

  if (chevron) {
    chevron.className = isExpanded ? 'fa-solid fa-chevron-up' : 'fa-solid fa-chevron-down';
  }
}

function collapseMobileGisLayers() {
  if (window.innerWidth > 768) return;
  const card = document.querySelector('.gis-layers-card');
  const chevron = document.getElementById('icon-chevron-layers');
  if (card && card.classList.contains('mobile-expanded')) {
    card.classList.remove('mobile-expanded');
    if (chevron) chevron.className = 'fa-solid fa-chevron-down';
  }
}


