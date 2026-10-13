import * as THREE from 'three';
import { collectFiles, findModels, formatBytes, stripExt } from './files.js';
import { loadModel } from './load.js';
import { convert, download, OUTPUT_FORMATS } from './export.js';
import { Viewer } from './viewer.js';

const $ = (id) => document.getElementById(id);

const state = {
  files: [],
  models: [],
  main: null,
  loaded: null, // result of loadModel
  wrapper: null, // Group holding the model with user transforms
};

const viewer = new Viewer($('viewer'));

for (const f of OUTPUT_FORMATS) $('formatSelect').add(new Option(f.label, f.id));

// ---------- input ----------

$('pickFiles').onclick = () => $('fileInput').click();
$('pickFolder').onclick = () => $('folderInput').click();
$('fileInput').onchange = (e) => addFiles([...e.target.files]);
$('folderInput').onchange = (e) => addFiles([...e.target.files]);
$('drop').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') $('fileInput').click(); });

const drop = $('drop');
['dragenter', 'dragover'].forEach((t) => document.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => document.addEventListener(t, (e) => {
  e.preventDefault();
  if (t === 'dragleave' && e.relatedTarget) return;
  drop.classList.remove('over');
}));
document.addEventListener('drop', async (e) => {
  const items = [...(e.dataTransfer.items || [])];
  const entries = items.map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (entries.length) addFiles(await readEntries(entries));
  else addFiles([...e.dataTransfer.files]);
});

async function readEntries(entries) {
  const out = [];
  async function walk(entry, prefix) {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      file.relativePath = prefix + file.name;
      out.push(file);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
      } while (batch.length);
    }
  }
  for (const entry of entries) await walk(entry, '');
  return out;
}

async function addFiles(fileArray) {
  if (!fileArray.length) return;
  setBusy('Reading files…');
  try {
    const added = await collectFiles(fileArray);
    const seen = new Set(state.files.map((f) => f.path));
    state.files.push(...added.filter((f) => !seen.has(f.path)));
    state.models = findModels(state.files);
    renderFiles();
    if (!state.models.length) {
      setBusy(null);
      showMessages([{ type: 'error', text: 'No 3D model found in those files. Supported: FBX, GLB, glTF, OBJ, DAE, 3DS, BLEND, STL, PLY, USDZ and more.' }]);
      return;
    }
    const keep = state.main && state.models.includes(state.main) ? state.main : state.models[0];
    await selectMain(keep, true);
  } catch (e) {
    console.error(e);
    showMessages([{ type: 'error', text: e.message }]);
  } finally {
    setBusy(null);
    $('fileInput').value = '';
    $('folderInput').value = '';
  }
}

$('clearBtn').onclick = () => {
  state.loaded?.resolver.dispose();
  Object.assign(state, { files: [], models: [], main: null, loaded: null, wrapper: null });
  viewer.setModel(null);
  renderFiles();
  $('info').hidden = true;
  $('empty').hidden = false;
  $('viewerTools').hidden = true;
  $('outputSection').hidden = true;
};

function renderFiles() {
  const list = $('fileList');
  list.innerHTML = '';
  $('fileSection').hidden = state.files.length === 0;
  for (const f of state.files) {
    const li = document.createElement('li');
    const isModel = state.models.includes(f);
    li.className = isModel ? 'model' : '';
    li.innerHTML = `<span class="tag">${f.ext || '?'}</span><span class="name"></span><span class="size">${formatBytes(f.data.byteLength)}</span>`;
    li.querySelector('.name').textContent = f.path;
    li.title = f.path;
    list.appendChild(li);
  }
  const sel = $('mainSelect');
  sel.innerHTML = '';
  state.models.forEach((m, i) => sel.add(new Option(m.path, i)));
  if (state.main) sel.value = state.models.indexOf(state.main);
  $('mainPick').hidden = state.models.length < 2;
}

$('mainSelect').onchange = (e) => selectMain(state.models[+e.target.value]);
$('engineSelect').onchange = () => state.main && selectMain(state.main);

// ---------- loading ----------

async function selectMain(model, fromAdd = false) {
  state.main = model;
  $('mainSelect').value = state.models.indexOf(model);
  setBusy(`Loading ${model.name}…`);
  try {
    state.loaded?.resolver.dispose();
    state.loaded = null;
    const loaded = await loadModel(model, state.files, $('engineSelect').value);
    state.loaded = loaded;
    state.wrapper = new THREE.Group();
    state.wrapper.name = stripExt(model.name);
    state.wrapper.add(loaded.root);
    applyTransform();
    viewer.setModel(state.wrapper);
    viewer.setWireframe($('wireCheck').checked);
    $('empty').hidden = true;
    $('viewerTools').hidden = false;
    $('outputSection').hidden = false;
    renderInfo();
  } catch (e) {
    console.error(e);
    viewer.setModel(null);
    $('empty').hidden = false;
    $('viewerTools').hidden = true;
    $('outputSection').hidden = true;
    showMessages([{ type: 'error', text: `Could not read ${model.name}: ${e.message}` }], true);
  } finally {
    if (!fromAdd) setBusy(null);
  }
}

function renderInfo(extra = []) {
  const { root, animations, engine, warnings, missing } = state.loaded;
  let meshes = 0, tris = 0, verts = 0;
  const mats = new Set();
  const textures = new Set();
  root.traverse((o) => {
    if (!o.isMesh) return;
    meshes++;
    const g = o.geometry;
    verts += g.attributes.position?.count ?? 0;
    tris += (g.index ? g.index.count : g.attributes.position?.count ?? 0) / 3;
    (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
      if (!m) return;
      mats.add(m);
      for (const k of ['map', 'normalMap', 'emissiveMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'alphaMap', 'specularMap', 'bumpMap']) {
        if (m[k]) textures.add(m[k].image ?? m[k]);
      }
    });
  });
  const size = new THREE.Box3().setFromObject(state.wrapper).getSize(new THREE.Vector3());
  const stats = [
    ['Meshes', meshes.toLocaleString()],
    ['Triangles', Math.round(tris).toLocaleString()],
    ['Vertices', verts.toLocaleString()],
    ['Materials', mats.size],
    ['Textures', textures.size],
    ['Animations', animations.length],
    ['Size (units)', `${fmt(size.x)} × ${fmt(size.y)} × ${fmt(size.z)}`],
    ['Read with', engine === 'three' ? 'three.js' : 'Assimp'],
  ];
  $('stats').innerHTML = stats.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  const msgs = [...extra];
  for (const w of warnings) msgs.push({ type: 'warn', text: w });
  if (missing.length) {
    msgs.push({ type: 'warn', text: `Missing texture file(s): ${missing.join(', ')}. Add them (or the whole folder/zip) to include them.` });
  }
  const maxDim = Math.max(size.x, size.y, size.z);
  if (maxDim > 100) msgs.push({ type: 'info', text: `The model is ${fmt(maxDim)} units across. If it was made in centimetres, use the cm → m preset so it is life-size in Unity.` });
  showMessages(msgs, false);
}

function fmt(n) {
  return n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toPrecision(2);
}

function showMessages(msgs, replaceStats = false) {
  $('info').hidden = false;
  if (replaceStats) $('stats').innerHTML = '';
  $('messages').innerHTML = '';
  for (const m of msgs) {
    const li = document.createElement('li');
    li.className = m.type;
    li.textContent = m.text;
    $('messages').appendChild(li);
  }
}

// ---------- transforms ----------

function applyTransform() {
  const w = state.wrapper;
  if (!w) return;
  const root = state.loaded.root;
  const s = parseFloat($('scaleInput').value);
  w.scale.setScalar(s > 0 ? s : 1);
  const rot = $('rotateSelect').value;
  w.rotation.set(rot === 'zup' ? -Math.PI / 2 : rot === 'yup' ? Math.PI / 2 : 0, rot === 'y180' ? Math.PI : 0, 0);
  root.position.set(0, 0, 0);
  w.position.set(0, 0, 0);
  if ($('centerCheck').checked) {
    w.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(w);
    const c = box.getCenter(new THREE.Vector3());
    w.position.set(-c.x, -box.min.y, -c.z);
  }
  w.updateMatrixWorld(true);
}

function onTransformChange() {
  if (!state.wrapper) return;
  applyTransform();
  viewer.frame();
  renderInfo();
}

$('scaleInput').oninput = onTransformChange;
$('rotateSelect').onchange = onTransformChange;
$('centerCheck').onchange = onTransformChange;
document.querySelectorAll('.chip[data-scale]').forEach((b) => {
  b.onclick = () => { $('scaleInput').value = b.dataset.scale; onTransformChange(); };
});
$('wireCheck').onchange = (e) => viewer.setWireframe(e.target.checked);
$('frameBtn').onclick = () => viewer.frame();
$('formatSelect').onchange = (e) => { $('unityTip').hidden = e.target.value !== 'obj'; };

// ---------- convert ----------

$('convertBtn').onclick = async () => {
  if (!state.loaded) return;
  const format = $('formatSelect').value;
  setBusy('Converting…');
  try {
    const wasWire = $('wireCheck').checked;
    if (wasWire) viewer.setWireframe(false);
    // Export from a parent-less clone of the wrapper's transform so the exporters see it.
    const exportRoot = state.wrapper;
    viewer.scene.remove(exportRoot);
    const { blob, filename, warnings } = await convert(exportRoot, format, {
      baseName: safeBase(state.main.name),
      animations: state.loaded.animations,
      uvFlipY: state.loaded.uvFlipY,
      resolver: state.loaded.resolver,
    });
    viewer.scene.add(exportRoot);
    if (wasWire) viewer.setWireframe(true);
    download(blob, filename);
    renderInfo([{ type: 'ok', text: `Saved ${filename} (${formatBytes(blob.size)}).` }, ...warnings.map((t) => ({ type: 'warn', text: t }))]);
  } catch (e) {
    console.error(e);
    if (!state.wrapper.parent) viewer.scene.add(state.wrapper);
    renderInfo([{ type: 'error', text: `Conversion failed: ${e.message}` }]);
  } finally {
    setBusy(null);
  }
};

function safeBase(name) {
  return stripExt(name).replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '') || 'model';
}

function setBusy(text) {
  $('busy').hidden = !text;
  if (text) $('busyText').textContent = text;
  $('convertBtn').disabled = !!text;
}
