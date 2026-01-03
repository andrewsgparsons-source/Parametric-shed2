// FILE: docs/src/renderer/babylon.js

export function mkMat(scene, name, color3, alpha = 1) {
  const mat = new BABYLON.StandardMaterial(name, scene);
  mat.diffuseColor = color3;
  mat.alpha = alpha;
  mat.specularColor = new BABYLON.Color3(0, 0, 0);
  return mat;
}

export function disposeAll(scene) {
  // Dispose meshes/materials created in previous renders for dynamic geometry.
  const toDispose = scene.meshes.filter(m => m.metadata && m.metadata.dynamic === true);
  toDispose.forEach(m => { if (!m.isDisposed()) m.dispose(false, true); });
}

export function boot(canvas) {
  const engine = new BABYLON.Engine(canvas, true);
  const scene = new BABYLON.Scene(engine);
  scene.clearColor = new BABYLON.Color4(0.96, 0.97, 0.98, 1);

  // DEV-ONLY: Babylon Inspector toggle via URL flag (?inspector=1)
  // Remove this block in one step after debugging.
  try {
    const qs = new URLSearchParams(String(window.location && window.location.search || ""));
    if (qs.get("inspector") === "1") {
      if (scene.debugLayer && scene.debugLayer.show) {
        scene.debugLayer.show({ embedMode: true });
      } else {
        console.warn("Inspector requested (?inspector=1) but scene.debugLayer is unavailable (inspector bundle not loaded).");
      }
    }
  } catch (e) {}

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

  // Cladding diagnostic v0.1: one-time post-first-render scan (no geometry changes)
  let __cladScanOnce = false;

  engine.runRenderLoop(() => {
    scene.render();

    if (!__cladScanOnce) {
      __cladScanOnce = true;

      try {
        window.__dbg = window.__dbg || {};
        window.__dbg.__cladScanDone = true;
        window.__dbg.cladMeshNames = scene.meshes
          .filter(m => m && !m.isDisposed() && typeof m.name === "string" &&
            (m.name.startsWith("clad-") || m.name.includes("clad") || m.name.includes("-c"))
          )
          .map(m => ({
            name: m.name,
            parent: m.parent ? m.parent.name : null,
            minY_mm: m.getBoundingInfo ? (m.getBoundingInfo().boundingBox.minimumWorld.y * 1000) : null,
            maxY_mm: m.getBoundingInfo ? (m.getBoundingInfo().boundingBox.maximumWorld.y * 1000) : null,
            meta: m.metadata || null
          }));

        console.log("CLAD_SCAN", window.__dbg.cladMeshNames.length);
      } catch (e) {}
    }
  });

  window.addEventListener('resize', () => engine.resize());

  return { engine, scene, camera, materials };
}
