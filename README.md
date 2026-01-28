# Parametric Shed Configurator

A 3D parametric building configurator for timber-framed garden buildings, built with [Babylon.js](https://www.babylonjs.com/).

Design sheds, workshops, and garden rooms in the browser — adjust dimensions, add doors and windows, choose roof styles, and generate a full cutting list with real timber sections.

> **What makes this different?** This isn't a "pick a size" dropdown. The model generates actual construction geometry — every stud, every rafter, every board. Change a dimension and see exactly what needs to be cut.

## 🔗 Live Demo

**[Try it here →](https://andrewsgparsons-source.github.io/Parametric-shed2/?profile=admin)**

## ✨ Features

### Building Design
- **Parametric dimensions** — Width and depth from 1m to 8m, height adjustable
- **Two roof styles** — Apex (gabled) or pent (lean-to) with configurable pitch
- **Doors & windows** — Place openings on any wall with drag positioning
- **Internal dividers** — Partition the space, with optional doorways
- **Building attachments** — Add lean-to or apex-roofed extensions on any side

### True Construction Geometry
- **Real timber sections** — 50×75mm studs, 100×50mm rafters, actual sizes
- **Proper framing** — Headers, sills, cripple studs, corner posts
- **Accurate joinery** — Plates, bird's mouths, proper truss geometry
- **Insulation option** — PIR boards between studs with plywood lining

### Output
- **Bill of Materials** — Full cutting list with quantities and dimensions
- **Shareable URLs** — Encode your design in the URL to share or bookmark
- **Multiple profiles** — Admin (full control), Customer (simplified), Viewer (read-only)

### Technical
- Pure vanilla JavaScript — no build step, no framework
- ES modules for clean code organisation
- CSG operations for accurate door/window cutouts

## 🚀 Getting Started

### Quick Start

Just open `docs/index.html` in a browser. The app runs entirely client-side.

For local development:

```bash
# Clone the repo
git clone https://github.com/andrewsgparsons-source/Parametric-shed2.git
cd Parametric-shed2

# Serve locally (any static server works)
npx serve docs
# or
python -m http.server 8000 --directory docs
```

### Profiles

Add `?profile=<name>` to the URL:

| Profile | Use Case |
|---------|----------|
| `admin` | Full access to all controls (default) |
| `customer` | Simplified view for end users |
| `viewer` | Read-only, for sharing completed designs |

## 📐 How It Works

The configurator uses a **state-driven rebuild** approach:

1. User changes a control (e.g., building width)
2. State store is updated
3. All 3D geometry is disposed and rebuilt
4. BOM is recalculated

This "destroy and rebuild" approach is simpler than incremental updates and guarantees consistency between the visual model and the cutting list.

### Coordinate System

```
        Y (up)
        │
        │
        └───────── X (width)
       /
      Z (depth)
```

All internal calculations use **millimetres**. The model represents what would actually be built.

For more details, see [ARCHITECTURE.md](docs/ARCHITECTURE.md).

## 📁 Project Structure

```
docs/
├── index.html          # Application entry point
├── profiles.json       # Profile definitions (UI customisation)
├── instances.js        # Preset building configurations
├── ARCHITECTURE.md     # Technical architecture guide
└── src/
    ├── index.js        # Main orchestrator
    ├── state.js        # Reactive state store
    ├── params.js       # Defaults and timber dimensions
    ├── elements/       # 3D building components
    │   ├── walls.js    # Wall framing and cladding
    │   ├── roof.js     # Apex and pent roofs
    │   ├── doors.js    # Door openings
    │   ├── windows.js  # Window openings
    │   ├── dividers.js # Internal partitions
    │   └── attachments.js  # Secondary buildings
    ├── bom/            # Bill of Materials
    └── ui/             # UI utilities
```

## 🤝 Contributing

Contributions welcome! See our approach:

1. **Fork and branch** — Create a feature branch from `main`
2. **Test thoroughly** — Try different building configurations
3. **Document changes** — Update JSDoc comments for public functions
4. **Keep PRs focused** — One feature or fix per PR

### Code Style

- Use JSDoc comments for exported functions
- Keep `console.log` debugging minimal in committed code
- Follow existing patterns for mesh naming and metadata

### Branches

- `main` — Production, stable
- `apex-roof-fix` — Current development work
- `clawdbot-experiments` — AI-assisted development

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.

---

*Built for designing real garden buildings by people who actually build them.*
