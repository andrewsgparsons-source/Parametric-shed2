// FILE: docs/instances.js
//
// Built-in, repo-shipped presets (read-only).
// These are NOT written into localStorage by default.
// They exist to provide a realistic first-load experience and a future-safe path to server-backed presets.
//

export function getBuiltInPresets() {
  return [
    {
      id: "preset.garden_shed.v1",
      name: "Garden Shed",
      category: "Garden Shed",
      description: "Default starter shed with a door and a window.",
      // State patch merged onto DEFAULTS via deepMerge(DEFAULTS, state)
      state: {
        roof: { style: "apex" },
        walls: {
          // One door + one window on front wall (typical starter layout)
          openings: [
            {
              id: "doorSeed1",
              wall: "front",
              type: "door",
              enabled: true,
              x_mm: 1075,       // centred for 3050-ish wall length: (3050 - 900)/2
              width_mm: 900,
              height_mm: 2000
            },
            {
              id: "winSeed1",
              wall: "front",
              type: "window",
              enabled: true,
              x_mm: 1075,       // align with door centreline by default
              y_mm: 900,
              width_mm: 900,
              height_mm: 600
            }
          ]
        }
      }
    }
  ];
}

export function getDefaultBuiltInPresetId() {
  return "preset.garden_shed.v1";
}

export function findBuiltInPresetById(id) {
  var list = [];
  try { list = getBuiltInPresets() || []; } catch (e) { list = []; }
  var want = String(id || "");
  for (var i = 0; i < list.length; i++) {
    var p = list[i];
    if (p && String(p.id || "") === want) return p;
  }
  return null;
}
