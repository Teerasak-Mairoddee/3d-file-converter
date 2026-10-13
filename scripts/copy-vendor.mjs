// Copies runtime WASM decoders into public/vendor so Vite serves them as static files.
import { cpSync, mkdirSync } from 'node:fs';

const out = 'public/vendor';
mkdirSync(`${out}/assimp`, { recursive: true });
mkdirSync(`${out}/draco`, { recursive: true });

for (const f of ['assimpjs.js', 'assimpjs.wasm']) {
  cpSync(`node_modules/assimpjs/dist/${f}`, `${out}/assimp/${f}`);
}
cpSync('node_modules/three/examples/jsm/libs/draco/gltf', `${out}/draco`, { recursive: true });
console.log('vendor files copied');
