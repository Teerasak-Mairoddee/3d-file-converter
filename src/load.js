import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { ColladaLoader } from 'three/addons/loaders/ColladaLoader.js';
import { TDSLoader } from 'three/addons/loaders/TDSLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { USDLoader } from 'three/addons/loaders/USDLoader.js';
import { VRMLLoader } from 'three/addons/loaders/VRMLLoader.js';
import { AMFLoader } from 'three/addons/loaders/AMFLoader.js';
import { LWOLoader } from 'three/addons/loaders/LWOLoader.js';
import { VTKLoader } from 'three/addons/loaders/VTKLoader.js';
import { PCDLoader } from 'three/addons/loaders/PCDLoader.js';
import { XYZLoader } from 'three/addons/loaders/XYZLoader.js';
import { KMZLoader } from 'three/addons/loaders/KMZLoader.js';
import { VOXLoader, VOXMesh } from 'three/addons/loaders/VOXLoader.js';
import { TGALoader } from 'three/addons/loaders/TGALoader.js';
import { DDSLoader } from 'three/addons/loaders/DDSLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { baseName, extOf, MODEL_EXTS, textureSources, textureUrls } from './files.js';

// Record the URL each texture was requested with, so the exporter knows a texture's
// original file name even when the image failed to load.
const originalTextureLoad = THREE.TextureLoader.prototype.load;
THREE.TextureLoader.prototype.load = function (url, ...rest) {
  const texture = originalTextureLoad.call(this, url, ...rest);
  textureUrls.set(texture, (this.path || '') + url);
  return texture;
};

const VENDOR = new URL('vendor/', document.baseURI).href;

// Formats three.js reads natively. Everything else goes through Assimp (WASM).
const THREE_FORMATS = new Set([
  'glb', 'gltf', 'fbx', 'obj', 'dae', '3ds', 'stl', 'ply', '3mf', 'usdz', 'usda', 'usdc', 'usd',
  'wrl', 'vrml', 'amf', 'lwo', 'vtk', 'vtp', 'pcd', 'xyz', 'kmz', 'vox',
]);
// Formats Assimp can also read, used as a fallback when the three.js loader fails.
const ASSIMP_FALLBACK = new Set(['fbx', 'obj', 'dae', '3ds', 'stl', 'ply', '3mf', 'lwo', 'glb', 'gltf', 'amf']);

/**
 * Builds a resolver that maps any URL a loader asks for to one of the uploaded files,
 * matching by file name (case-insensitive), since store models often reference
 * textures with absolute paths from the author's machine.
 */
class FileResolver {
  constructor(files) {
    this.byName = new Map();
    this.urls = [];
    this.urlToFile = new Map();
    this.missing = new Set();
    for (const f of files) {
      const key = f.name.toLowerCase();
      if (this.byName.has(key)) continue;
      const url = URL.createObjectURL(new Blob([f.data]));
      this.byName.set(key, { file: f, url });
      this.byNameNoExt ??= new Map();
      this.byNameNoExt.set(key.replace(/\.[^.]+$/, ''), { file: f, url });
      this.urlToFile.set(url, f);
      this.urls.push(url);
    }
  }

  resolve(url) {
    if (url.startsWith('data:')) return url;
    if (url.startsWith('blob:') && this.urlToFile.has(url)) return url;
    let name = baseName(decodeURIComponent(url.split(/[?#]/)[0]));
    const hit = this.byName.get(name.toLowerCase());
    if (hit) return hit.url;
    // Same texture name with a different extension (e.g. .tga referenced, .png supplied)
    const alt = this.byNameNoExt?.get(name.toLowerCase().replace(/\.[^.]+$/, ''));
    if (alt && !MODEL_EXTS.includes(alt.file.ext)) return alt.url;
    if (url.startsWith('blob:')) return url; // created by a loader itself (embedded textures)
    this.missing.add(name);
    return url;
  }

  dispose() {
    for (const u of this.urls) URL.revokeObjectURL(u);
  }
}

function makeManager(resolver) {
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => resolver.resolve(url));
  manager.addHandler(/\.tga$/i, new TGALoader(manager));
  manager.addHandler(/\.dds$/i, new DDSLoader(manager));
  return manager;
}

/** Counts in-flight requests so we can wait for textures that loaders fetch asynchronously. */
function trackRequests(manager) {
  let pending = 0;
  let waiters = [];
  const start = manager.itemStart.bind(manager);
  const end = manager.itemEnd.bind(manager);
  manager.itemStart = (url) => { pending++; start(url); };
  manager.itemEnd = (url) => {
    end(url);
    pending--;
    if (pending <= 0) { waiters.forEach((w) => w()); waiters = []; }
  };
  return () => new Promise((resolve) => {
    if (pending <= 0) return resolve();
    waiters.push(resolve);
    setTimeout(resolve, 30000);
  });
}

function text(data) {
  return new TextDecoder().decode(data);
}

function buf(data) {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
}

function gltfLoader(manager) {
  const draco = new DRACOLoader(manager).setDecoderPath(`${VENDOR}draco/`);
  return new GLTFLoader(manager).setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder);
}

function geometryToMesh(geometry) {
  if (!geometry.attributes.normal && geometry.index !== null) geometry.computeVertexNormals();
  const hasColors = !!geometry.attributes.color;
  const hasFaces = geometry.index ? geometry.index.count >= 3 : geometry.attributes.position.count % 3 === 0;
  if (!hasFaces) {
    return new THREE.Points(geometry, new THREE.PointsMaterial({ size: 0.01, vertexColors: hasColors }));
  }
  if (!geometry.attributes.normal) geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: hasColors ? 0xffffff : 0xb8b8b8, vertexColors: hasColors, roughness: 0.7 }));
}

/** Remembers which uploaded image each glTF texture came from, so exports can reuse the original file. */
function tagGltfTextures(gltf, files) {
  const { json, associations } = gltf.parser;
  for (const [obj, assoc] of associations) {
    if (!obj?.isTexture || assoc?.textures === undefined) continue;
    const texDef = json.textures?.[assoc.textures];
    const source = texDef?.source ?? texDef?.extensions?.EXT_texture_webp?.source;
    const uri = json.images?.[source]?.uri;
    if (!uri || uri.startsWith('data:')) continue;
    const name = baseName(decodeURIComponent(uri)).toLowerCase();
    const file = files.find((f) => f.name.toLowerCase() === name);
    if (file) textureSources.set(obj, file);
  }
}

async function loadWithThree(main, files, manager) {
  const ext = main.ext;
  let root;
  let animations = [];
  let uvFlipY = true;

  switch (ext) {
    case 'glb':
    case 'gltf': {
      const gltf = await gltfLoader(manager).parseAsync(buf(main.data), '');
      tagGltfTextures(gltf, files);
      root = gltf.scene;
      animations = gltf.animations;
      uvFlipY = false;
      break;
    }
    case 'fbx': {
      root = new FBXLoader(manager).parse(buf(main.data), '');
      animations = root.animations ?? [];
      break;
    }
    case 'obj': {
      const src = text(main.data);
      const loader = new OBJLoader(manager);
      const mtlNames = [...src.matchAll(/^\s*mtllib\s+(.+?)\s*$/gm)].map((m) => baseName(m[1]).toLowerCase());
      let mtlFile = files.find((f) => mtlNames.includes(f.name.toLowerCase()));
      if (!mtlFile) mtlFile = files.find((f) => f.ext === 'mtl');
      if (mtlFile) {
        const materials = new MTLLoader(manager).parse(text(mtlFile.data), '');
        materials.preload();
        loader.setMaterials(materials);
      }
      root = loader.parse(src);
      break;
    }
    case 'dae': {
      const collada = new ColladaLoader(manager).parse(text(main.data), '');
      root = collada.scene;
      animations = collada.scene.animations ?? [];
      break;
    }
    case '3ds':
      root = new TDSLoader(manager).parse(buf(main.data), '');
      break;
    case 'stl':
      root = geometryToMesh(new STLLoader(manager).parse(buf(main.data)));
      break;
    case 'ply':
      root = geometryToMesh(new PLYLoader(manager).parse(buf(main.data)));
      break;
    case 'vtk':
    case 'vtp':
      root = geometryToMesh(new VTKLoader(manager).parse(buf(main.data), ''));
      break;
    case 'xyz':
      root = geometryToMesh(new XYZLoader(manager).parse(text(main.data)));
      break;
    case 'pcd':
      root = new PCDLoader(manager).parse(buf(main.data));
      break;
    case '3mf':
      root = new ThreeMFLoader(manager).parse(buf(main.data));
      break;
    case 'amf':
      root = new AMFLoader(manager).parse(buf(main.data));
      break;
    case 'kmz':
      root = new KMZLoader(manager).parse(buf(main.data)).scene;
      break;
    case 'wrl':
    case 'vrml':
      root = new VRMLLoader(manager).parse(text(main.data), '');
      break;
    case 'lwo': {
      const lwo = new LWOLoader(manager).parse(buf(main.data), '', main.name);
      root = new THREE.Group();
      lwo.meshes.forEach((m) => root.add(m));
      break;
    }
    case 'vox': {
      const chunks = new VOXLoader(manager).parse(buf(main.data));
      root = new THREE.Group();
      const list = Array.isArray(chunks) ? chunks : chunks.chunks ?? [chunks];
      for (const c of list) root.add(new VOXMesh(c));
      break;
    }
    case 'usdz':
    case 'usda':
    case 'usdc':
    case 'usd':
      root = new USDLoader(manager).parse(buf(main.data), '');
      break;
    default:
      throw new Error(`No three.js loader for .${ext}`);
  }
  return { root, animations, uvFlipY };
}

let assimpPromise = null;
function getAssimp() {
  if (!assimpPromise) {
    assimpPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = `${VENDOR}assimp/assimpjs.js`;
      s.onload = () => window.assimpjs({ locateFile: (f) => `${VENDOR}assimp/${f}` }).then(resolve, reject);
      s.onerror = () => reject(new Error('Could not load the Assimp converter'));
      document.head.appendChild(s);
    }).catch((e) => { assimpPromise = null; throw e; });
  }
  return assimpPromise;
}

async function loadWithAssimp(main, files, manager) {
  const ajs = await getAssimp();
  const list = new ajs.FileList();
  list.AddFile(main.name, main.data);
  // Give Assimp the companion files (textures, .mtl, .bin...) but not other models,
  // so it does not pick the wrong one as the main file.
  for (const f of files) {
    if (f === main || MODEL_EXTS.includes(f.ext)) continue;
    list.AddFile(f.name, f.data);
  }
  const result = ajs.ConvertFileList(list, 'glb2');
  if (!result.IsSuccess() || result.FileCount() === 0) {
    throw new Error(`Assimp could not read ${main.name} (${result.GetErrorCode()})`);
  }
  const glb = result.GetFile(0).GetContent();
  const gltf = await gltfLoader(manager).parseAsync(buf(glb), '');
  return { root: gltf.scene, animations: gltf.animations, uvFlipY: false };
}

function isEmpty(root) {
  let n = 0;
  root.traverse((o) => { if (o.isMesh || o.isPoints || o.isLine) n++; });
  return n === 0;
}

/**
 * Loads `main` (with the other uploaded files available for textures etc.).
 * engine: 'auto' | 'three' | 'assimp'
 */
export async function loadModel(main, files, engine = 'auto') {
  const resolver = new FileResolver(files);
  const warnings = [];
  const attempts = [];
  if (engine === 'three' || (engine === 'auto' && THREE_FORMATS.has(main.ext))) attempts.push('three');
  if (engine === 'assimp' || (engine === 'auto' && (!THREE_FORMATS.has(main.ext) || ASSIMP_FALLBACK.has(main.ext)))) attempts.push('assimp');
  if (attempts.length === 0) attempts.push('assimp');

  let lastError;
  for (const which of attempts) {
    const manager = makeManager(resolver);
    const idle = trackRequests(manager);
    try {
      const res = which === 'three'
        ? await loadWithThree(main, files, manager)
        : await loadWithAssimp(main, files, manager);
      await new Promise((r) => setTimeout(r, 0));
      await idle();
      if (isEmpty(res.root)) throw new Error('The file loaded but contains no geometry');
      if (lastError) warnings.push(`The three.js reader failed (${lastError.message}), so Assimp was used instead.`);
      res.root.name ||= main.name.replace(/\.[^.]+$/, '');
      return {
        ...res,
        engine: which,
        warnings,
        missing: [...resolver.missing],
        resolver,
      };
    } catch (e) {
      console.error(e);
      lastError = e;
    }
  }
  resolver.dispose();
  throw lastError;
}

export { extOf };
