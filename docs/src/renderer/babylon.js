// src/renderer/babylon.js

export function mkMat(scene, name, color3, alpha = 1) {
  const mat = new BABYLON.StandardMaterial(name, scene);
  mat.diffuseColor = color3;
  mat.alpha = alpha;
  mat.specularColor = new BABYLON.Color3(0, 0, 0);
  return mat;
}

export function disposeAll(scene) {
  // Accept either a Babylon Scene or a ctx object { engine, scene, camera, materials }.
  const sc = (scene && scene.scene) ? scene.scene : scene;
  if (!sc || !sc.meshes) return;

  // Dispose meshes/materials created in previous renders for dynamic geometry.
  const toDispose = sc.meshes.filter(m => m.metadata && m.metadata.dynamic === true);
  toDispose.forEach(m => { if (!m.isDisposed()) m.dispose(false, true); });
}

export function boot(canvas) {
  const engine = new BABYLON.Engine(canvas, true);
  const scene = new BABYLON.Scene(engine);
  scene.clearColor = new BABYLON.Color4(0.96, 0.97, 0.98, 1);

  const camera = new BABYLON.ArcRotateCamera(
    'cam',
    -Math.PI / 4,
    Math.PI / 3,
    8,
    new BABYLON.Vector3(1.5, 0, 2),
    scene
  );
  camera.attachControl(canvas, true);

  // Slower, smoother zoom (reference values), plus rails
  if (camera.wheelDeltaPercentage !== undefined) {
    camera.wheelDeltaPercentage = 0.015;
    camera.pinchDeltaPercentage = 0.015;
  } else {
    camera.wheelPrecision = Math.max(120, camera.wheelPrecision || 100);
    camera.pinchPrecision = Math.max(120, camera.pinchPrecision || 100);
  }
  camera.inertia = 0.85;
  camera.lowerRadiusLimit = 0.5;
  camera.upperRadiusLimit = 200;

  new BABYLON.HemisphericLight('hemi', new BABYLON.Vector3(0, 1, 0), scene);

  const materials = {
    timber: mkMat(scene, 'timber', new BABYLON.Color3(0.55, 0.43, 0.33)),
    plate:  mkMat(scene, 'plate',  new BABYLON.Color3(0.45, 0.35, 0.27)),
    base:   mkMat(scene, 'base',   new BABYLON.Color3(0.2, 0.2, 0.2)),
    guide:  mkMat(scene, 'guide',  new BABYLON.Color3(0.7, 0.7, 0.7), 0.5),
  };

  engine.runRenderLoop(() => scene.render());
  window.addEventListener('resize', () => engine.resize());

  return { engine, scene, camera, materials };
}
