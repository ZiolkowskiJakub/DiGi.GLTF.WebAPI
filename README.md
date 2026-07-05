# DiGi.GLTF.WebAPI

Generic, reusable 3D visualization engine for the DiGi platform — strictly decoupled from any domain logic.

The solution provides two reusable components:

## 1. Web API extension (backend)

The assembly is loaded as an extension by the `DiGi.WebAPI.WindowsService` host (from its `extensions` directory) and exposes domain-agnostic endpoints operating exclusively on `DiGi.GLTF` payloads:

- `POST gltf/gltfscene/fromobjects` — composes a `GLTFScene` from serialized generic objects (`GLTFNode` instances or raw `DiGi.Geometry` spatial geometry), translating all geometry to a local origin (0, 0, 0) with the offset preserved in `GLTFScene.ReferencePoint` (required to avoid floating-point precision issues in WebGL rendering of large coordinates).
- `POST gltf/gltfscene/glb` — converts a serialized `GLTFScene` into a binary glTF (`.glb`) payload.

Domain objects (buildings, GIS entities, analytical models) must be converted into `GLTFNode` instances by the consuming application before calling these endpoints. For example, `DiGi.GIS.WebAPI.UI` converts `Building2D`, `BuildingModel` and `UrbanModel` objects itself and passes only generic glTF objects to this engine.

## 2. Viewer engine (frontend)

`wwwroot/js/gltf-viewer-core.js` is a reusable ES module (three.js based) rendering `GLTFScene` payloads:

- WebGL rendering pipeline with ground grid, shadows and automatic camera framing.
- Revit-style navigation: middle mouse pans, Shift + middle mouse orbits, scroll wheel zooms.
- Selection: left click selects a single object; left drag performs a directional marquee (left-to-right window selection with a solid rectangle, right-to-left crossing selection with a dashed rectangle).
- Integration contract: the engine dispatches `gltf-ready` and `gltf-selectionchanged` (generic object references) events on its container element and exposes a lighting/camera API (`setSun`, `setSunIntensity`, `setAmbientIntensity`, `frameScene`, `clearSelection`, `getUserData`). Consuming applications provide the container and build their own domain UI (for example properties panels) around these events.

Consumers synchronize the module into their static assets at build time (see the `CopyGLTFViewerCore` MSBuild target in `DiGi.GIS.WebAPI.UI`).

## Dependencies

- `DiGi.GLTF` — glTF data model and SharpGLTF-based GLB export.
- `DiGi.Core` / `DiGi.Geometry` — serialization framework and generic spatial geometry.
- `DiGi.WebAPI` — shared Web API infrastructure.
