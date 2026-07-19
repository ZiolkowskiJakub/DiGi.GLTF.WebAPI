// DiGi.GLTF.WebAPI — generic, reusable 3D glTF viewer engine.
// Renders a GLTFScene payload (scene JSON + binary glTF) without any domain knowledge:
// - Rendering pipeline: WebGL canvas, ground plane + grid at world elevation Z = 0, shadows,
//   autoframing camera, frustum culling.
// - Batched payload support: geometry produced by the DiGi.GLTF batching pipeline arrives as one
//   merged mesh per alpha mode with per-vertex object ids (_OBJECTID) and an objectMap in the
//   scene extras. Individual objects are picked by decoding the id attribute at the raycast hit
//   and are highlighted by tinting their contiguous vertex color range - the whole scene renders
//   with one or two draw calls regardless of the object count.
// - Legacy payload support: scenes with one glTF node per object keep working unchanged.
// - Revit-style navigation: middle mouse pans, Shift + middle mouse orbits, scroll wheel zooms.
// - Selection: left click selects a single object; left drag performs a directional marquee
//   (left-to-right = window selection of fully enclosed objects with a solid rectangle,
//   right-to-left = crossing selection of intersecting objects with a dashed rectangle).
//   While dragging, the objects the marquee would select are live-highlighted with the
//   selection tint; the preview updates on every pointer move for both directions.
// - Raycasting is accelerated with three-mesh-bvh when the optional module resolves; without it,
//   hover picking is throttled to keep the frame rate stable on large merged meshes.
// - ViewCube: a Revit-style navigation gizmo in the bottom-right corner. Its orientation mirrors
//   the main camera in real time; hovering highlights the face/edge/corner regions and clicking
//   one smoothly aligns the camera to that direction around the current orbit target.
// - Settings panel: built-in environment controls — "Show gizmo" and "Show ground" checkboxes
//   (both checked by default), a "Fog" slider (default 0.2) driving an exponential distance fog,
//   and a "View range" slider + numeric input (default 2000 m) that hides every object whose
//   center lies further from the scene center than the given radius (batched payloads are culled
//   by rebuilding the merged index buffer from the per-object contiguous index ranges; legacy
//   payloads toggle mesh visibility). The controls mount into a host-provided '#gltf-settings'
//   element when the page has one (the host owns the surrounding card/title/theming); otherwise
//   the engine creates its own collapsible panel docked to the left edge titled "Settings".
// - Status terminal: a read-only task log docked to the bottom edge of the container, attached
//   by default for every view. One line (the most recent task) is visible; a snapping splitter
//   above the text area reveals earlier entries one full line per step, and a vertical scrollbar
//   appears once the area is expanded beyond three lines. Any code reports the current task via
//   the exported reportStatus(message) (or the 'gltf-status' document event); the boolean flag
//   data-status-terminal="false" on the container removes the text area and splitter entirely.
// - Scope box: a Revit-style manipulable clipping cuboid ("Scope Box" / "Scope Box visible"
//   checkboxes in the Settings panel). When enabled, six GPU clipping planes restrict rendering
//   to the box interior and geometry crossing the boundary is cut live (open cross-sections,
//   like a plain clipped view). Dragging an edge moves
//   the box, clicking an edge reveals per-face push/pull arrows and a rotate handle (rotation
//   is about the vertical axis, like Revit). Hiding the box (visible = false) keeps the
//   clipping and the caps active. The default box is centered on the scene; the container
//   attribute data-scope-box-size="halfX;halfY;zMin;zMax" (DiGi coordinates) overrides the
//   bounds-fit default per view.
// Integration contract for consuming applications:
// - Events dispatched on the container element:
//   'gltf-ready'            detail: { objectCount }
//   'gltf-selectionchanged' detail: { references: string[] } (generic object identifiers)
//   'gltf-terminalresize'   detail: { height } (status terminal height in CSS pixels; 0 = hidden)
//   'gltf-scopeboxchanged'  detail: { enabled, visible, center, size, rotation } (DiGi coordinates)
// - Public API: frameScene(), frameSelection(), clearSelection(), getSunState(),
//   setSun(azimuth, altitude), setSunIntensity(value), setAmbientIntensity(value),
//   getUserData(reference), alignViewToDirection(direction), getEnvironmentState(),
//   setGizmoVisible(visible), setGroundVisible(visible), setFog(value), setViewRange(meters),
//   setScopeBoxEnabled(enabled), setScopeBoxVisible(visible), getScopeBoxState().
// - Right-click context menu: built-in default behavior with "Fit view", "Fit selection"
//   (enabled only while objects are selected) and "Clear selection". Consuming applications may
//   extend the `contextMenuItems` array ({ label, action(), isEnabled() }) before the first open.
// DiGi geometry is Z-up while three.js is Y-up: the loaded model is rotated -90deg
// around X, and any DiGi vector (x, y, z) maps to three.js world (x, z, -y).

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const LIGHT_TYPE = { UNDEFINED: 0, AMBIENT: 1, DIRECTIONAL: 2, POINT: 3 };

const HOVER_TINT = { color: [96, 150, 255], strength: 0.35 };
const SELECTED_TINT = { color: [30, 107, 214], strength: 0.6 };
const HOVER_EMISSIVE = new THREE.Color(0x2c3e50);
const SELECTED_EMISSIVE = new THREE.Color(0x1e6bd6);

// Minimum pointer travel in pixels before a left drag becomes a marquee instead of a click.
const MARQUEE_THRESHOLD = 5;

// Edge overlays are skipped above this triangle count to avoid blocking the main thread.
const EDGES_TRIANGLE_LIMIT = 400000;

// Hover raycasts are throttled to this interval when BVH acceleration is unavailable.
const HOVER_THROTTLE_MS = 40;

// ViewCube gizmo: canvas size and viewport margin in CSS pixels, click-to-align tween duration,
// and the hover highlight (the marquee/selection accent so the whole viewer chrome matches).
const VIEW_CUBE_SIZE = 112;
const VIEW_CUBE_MARGIN = 12;
const VIEW_CUBE_ALIGN_MS = 600;
const VIEW_CUBE_HIGHLIGHT = 0x4d90fe;
const VIEW_CUBE_HOVER_OPACITY = 0.4;

// Ground plane at the DiGi world elevation Z = 0: a visible plate with the line grid and a
// transparent shadow catcher stacked above it. The small Y offsets prevent z-fighting with
// geometry that sits exactly on the ground. The plate color is a neutral dark gray kept clearly
// lighter than the scene background so the ground reads as a solid surface.
const GROUND_COLOR = 0x44464c;
const GROUND_OFFSET = 0.06;
const GROUND_SHADOW_OFFSET = 0.04;
const GROUND_GRID_OFFSET = 0.02;

// Settings panel defaults. The view range hides objects whose center lies further from the
// scene center than the given radius in meters; fog is a normalized 0..1 slider value.
const VIEW_RANGE_DEFAULT = 2000;
const VIEW_RANGE_MIN = 100;
const VIEW_RANGE_MAX = 10000;

// FogExp2 factor exp(-(density * depth)^2) falls under ~1% at density * depth ≈ 2.15, so a fog
// slider value of 1 places the fully fogged distance at the scene radius.
const FOG_FALLOFF = 2.15;
const FOG_DEFAULT = 0.1;

// Debounce for rebuilding the raycast BVH and edge overlays after a view-range change; the
// index rebuild itself is cheap and runs live while the slider moves.
const CULL_REBUILD_DELAY_MS = 300;

// Scope box: the Revit-style clipping cuboid. Cyan wireframe/handles, a screen-relative handle
// scale (fraction of the vertical view extent at the handle distance), a minimum face-to-face
// size in meters and the pick-proxy thickness of the edges as a fraction of the box diagonal.
const SCOPE_BOX_COLOR = 0x00e0e0;
const SCOPE_BOX_HANDLE_SIZE = 0.025;
const SCOPE_BOX_MIN_SIZE = 0.5;
const SCOPE_BOX_EDGE_PICK_RATIO = 0.015;

// The six box faces as [axis, sign] pairs in box-local coordinates (axis 0 = x, 1 = y, 2 = z).
// The order fixes the mapping between faces, clipping planes, handles and cap quads.
const SCOPE_BOX_FACES = [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1]];

// Status terminal: height of one log line and of the splitter bar in CSS pixels, the visible
// line count above which the vertical scrollbar appears, the share of the container height the
// terminal may grow to, and the number of retained log entries.
const STATUS_LINE_HEIGHT = 20;
const STATUS_SPLITTER_HEIGHT = 6;
const STATUS_SCROLLBAR_LINES = 3;
const STATUS_MAX_HEIGHT_RATIO = 0.5;
const STATUS_HISTORY_LIMIT = 200;

export function readSceneData(elementId) {
    const element = document.getElementById(elementId);
    if (!element) {
        return null;
    }
    try {
        return JSON.parse(element.textContent);
    } catch {
        return null;
    }
}

// Fetches a binary glTF payload from a streamed endpoint. Preferred over embedded base64:
// the payload transfers as raw binary (no base64 overhead), can be cached by the browser
// and never touches the main thread for decoding.
export async function fetchGlbBytes(url) {
    if (!url) {
        return null;
    }
    try {
        const response = await fetch(url);
        if (!response.ok || response.status === 204) {
            return null;
        }
        const buffer = await response.arrayBuffer();
        return buffer.byteLength > 0 ? buffer : null;
    } catch {
        return null;
    }
}

// Decodes the embedded base64 GLB payload asynchronously: the browser's native data-URL fetch
// decoder avoids a blocking JavaScript character loop on multi-megabyte payloads.
export async function readGlbBytes(elementId) {
    const element = document.getElementById(elementId);
    if (!element) {
        return null;
    }
    const base64 = element.textContent.trim();
    if (!base64) {
        return null;
    }
    try {
        const response = await fetch('data:application/octet-stream;base64,' + base64);
        return await response.arrayBuffer();
    } catch {
        // Fallback: synchronous decode.
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes.buffer;
    }
}

// DiGi Z-up vector/point -> three.js Y-up world.
function toThree(value) {
    return new THREE.Vector3(value.X, value.Z, -value.Y);
}

function lightTypeOf(light) {
    const value = light.LightType;
    if (typeof value === 'string') {
        return LIGHT_TYPE[value.toUpperCase()] ?? LIGHT_TYPE.UNDEFINED;
    }
    return value ?? LIGHT_TYPE.UNDEFINED;
}

function lightColorOf(light) {
    const color = light.Color;
    if (!color) {
        return new THREE.Color(0xffffff);
    }
    return new THREE.Color(color.Red / 255, color.Green / 255, color.Blue / 255);
}

function objectIdAttributeOf(geometry) {
    return geometry.getAttribute('_objectid') ?? geometry.getAttribute('_OBJECTID') ?? null;
}

// ---------------------------------------------------------------------------------------------
// Status terminal: a generic, read-only task log docked to the bottom edge of the viewer
// container. Any code anywhere in the application reports the current or completed task through
// reportStatus(message) - or, without importing this module, by dispatching the 'gltf-status'
// CustomEvent on document - and every attached terminal appends the message as a new line,
// always keeping the most recent one in view. Messages reported before a terminal exists are
// buffered and replayed on attach, so early tasks (e.g. "Loading...") are never lost.
// ---------------------------------------------------------------------------------------------

const statusHistory = [];

export function reportStatus(message) {
    if (message === undefined || message === null || message === '') {
        return;
    }

    const entry = { time: new Date(), text: String(message) };
    statusHistory.push(entry);
    if (statusHistory.length > STATUS_HISTORY_LIMIT) {
        statusHistory.shift();
    }

    document.dispatchEvent(new CustomEvent('gltf-status', { detail: { message: entry.text, time: entry.time } }));
}

export function updateLastStatus(message) {
    if (message === undefined || message === null || message === '') {
        return;
    }

    const text = String(message);
    if (statusHistory.length > 0) {
        statusHistory[statusHistory.length - 1].text = text;
    }

    document.dispatchEvent(new CustomEvent('gltf-status-update', { detail: { message: text } }));
}

export function formatElapsed(startTime) {
    const elapsed = (performance.now() - startTime) / 1000;
    if (elapsed < 60) {
        return `${elapsed.toFixed(1)}s`;
    }
    const minutes = Math.floor(elapsed / 60);
    const seconds = Math.floor(elapsed % 60);
    return `${minutes}m ${seconds}s`;
}

export class GltfStatusTerminal {
    // One terminal per container: repeated attach calls return the existing instance. The boolean
    // visibility flag disables the feature entirely - data-status-terminal="false" on the
    // container (or attach(container, { enabled: false })) yields no text area and no splitter.
    static attach(container, options = {}) {
        if (!container) {
            return null;
        }
        if (container.gltfStatusTerminal !== undefined) {
            return container.gltfStatusTerminal;
        }

        const enabled = options.enabled ?? (container.dataset.statusTerminal !== 'false');
        container.gltfStatusTerminal = enabled ? new GltfStatusTerminal(container) : null;
        return container.gltfStatusTerminal;
    }

    constructor(container) {
        this.container = container;
        this.visibleLines = 1;
        this.hidden = false;

        this.wrapper = document.createElement('div');
        Object.assign(this.wrapper.style, {
            position: 'absolute', left: '0', right: '0', bottom: '0', zIndex: '9',
            display: 'flex', flexDirection: 'column'
        });

        // The splitter reveals earlier entries in whole-line steps (see the pointerdown handler).
        this.splitter = document.createElement('div');
        this.splitter.title = 'Drag up to show earlier entries; double-click to reset';
        Object.assign(this.splitter.style, {
            height: `${STATUS_SPLITTER_HEIGHT}px`, flex: '0 0 auto', cursor: 'row-resize',
            touchAction: 'none', background: 'rgba(255, 255, 255, 0.08)'
        });
        this.splitter.addEventListener('pointerenter', () => {
            this.splitter.style.background = 'rgba(77, 144, 254, 0.45)';
        });
        this.splitter.addEventListener('pointerleave', () => {
            if (!this.dragging) {
                this.splitter.style.background = 'rgba(255, 255, 255, 0.08)';
            }
        });
        this.wrapper.appendChild(this.splitter);

        this.textArea = document.createElement('div');
        this.textArea.setAttribute('role', 'log');
        this.textArea.setAttribute('aria-live', 'polite');
        Object.assign(this.textArea.style, {
            height: `${STATUS_LINE_HEIGHT}px`, overflowY: 'hidden', overflowX: 'hidden',
            padding: '2px 10px', background: 'rgba(20, 24, 32, 0.85)', color: '#e6e9ef',
            fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace', fontSize: '0.75rem',
            lineHeight: `${STATUS_LINE_HEIGHT}px`, userSelect: 'text', cursor: 'default',
            scrollbarWidth: 'thin', scrollbarColor: 'rgba(255, 255, 255, 0.25) transparent'
        });
        this.wrapper.appendChild(this.textArea);

        this.container.appendChild(this.wrapper);

        this.initSplitterDrag();

        this.statusListener = (event) => this.appendLine({
            time: event.detail?.time ?? new Date(),
            text: event.detail?.message ?? ''
        });
        document.addEventListener('gltf-status', this.statusListener);

        this.statusUpdateListener = (event) => this.updateLastLine(event.detail?.message ?? '');
        document.addEventListener('gltf-status-update', this.statusUpdateListener);

        for (const entry of statusHistory) {
            this.appendLine(entry);
        }

        this.dispatchResize();
    }

    initSplitterDrag() {
        this.dragging = false;

        this.splitter.addEventListener('pointerdown', (event) => {
            event.preventDefault();
            try {
                this.splitter.setPointerCapture(event.pointerId);
            } catch {
                // Capture keeps the drag alive outside the window but is not required: the move
                // and up listeners live on document, so the drag works either way.
            }
            this.dragging = true;

            const startY = event.clientY;
            const startLines = this.visibleLines;

            const onPointerMove = (moveEvent) => {
                // Stepped resize: the height snaps to whole text lines instead of following the
                // pointer continuously - one full line is revealed or hidden per step.
                this.setVisibleLines(startLines + Math.round((startY - moveEvent.clientY) / STATUS_LINE_HEIGHT));
            };

            const onPointerUp = () => {
                this.dragging = false;
                this.splitter.style.background = 'rgba(255, 255, 255, 0.08)';
                document.removeEventListener('pointermove', onPointerMove);
                document.removeEventListener('pointerup', onPointerUp);
            };

            document.addEventListener('pointermove', onPointerMove);
            document.addEventListener('pointerup', onPointerUp);
        });

        this.splitter.addEventListener('dblclick', () => this.setVisibleLines(1));
    }

    // Appends one log line and keeps the most recent entry in view.
    appendLine(entry) {
        if (!entry.text) {
            return;
        }

        const line = document.createElement('div');
        line.title = entry.text;
        Object.assign(line.style, {
            height: `${STATUS_LINE_HEIGHT}px`, whiteSpace: 'nowrap',
            overflow: 'hidden', textOverflow: 'ellipsis'
        });

        const time = document.createElement('span');
        time.textContent = `${entry.time.toTimeString().slice(0, 8)}  `;
        time.style.color = '#5d6570';
        line.appendChild(time);

        const text = document.createElement('span');
        text.textContent = entry.text;
        line.appendChild(text);

        this.textArea.appendChild(line);
        while (this.textArea.childElementCount > STATUS_HISTORY_LIMIT) {
            this.textArea.removeChild(this.textArea.firstElementChild);
        }

        this.textArea.scrollTop = this.textArea.scrollHeight;
    }

    updateLastLine(text) {
        if (!text) {
            return;
        }

        const lastLine = this.textArea.lastElementChild;
        if (!lastLine) {
            this.appendLine({ time: new Date(), text });
            return;
        }

        const textSpan = lastLine.lastElementChild;
        if (textSpan) {
            textSpan.textContent = text;
        }
        lastLine.title = text;
    }

    // Reports a task status to this terminal only; reportStatus() broadcasts to all terminals.
    log(message) {
        if (message !== undefined && message !== null && message !== '') {
            this.appendLine({ time: new Date(), text: String(message) });
        }
    }

    setVisibleLines(value) {
        const maximum = Math.max(1, Math.floor((this.container.clientHeight * STATUS_MAX_HEIGHT_RATIO) / STATUS_LINE_HEIGHT));
        const lines = Math.max(1, Math.min(maximum, Math.round(value)));
        if (lines === this.visibleLines) {
            return;
        }

        this.visibleLines = lines;
        this.textArea.style.height = `${lines * STATUS_LINE_HEIGHT}px`;
        // The scrollbar appears on the right side once the area shows more than three lines;
        // below that the area stays pinned to the latest entry.
        this.textArea.style.overflowY = lines > STATUS_SCROLLBAR_LINES ? 'auto' : 'hidden';
        this.textArea.scrollTop = this.textArea.scrollHeight;
        this.dispatchResize();
    }

    // Runtime counterpart of the data-status-terminal flag: hides or shows the whole overlay.
    setVisible(visible) {
        this.hidden = !visible;
        this.wrapper.style.display = visible ? 'flex' : 'none';
        this.dispatchResize();
    }

    // Lets the viewer (and any other bottom-docked overlay owner) stay above the terminal.
    dispatchResize() {
        const height = this.hidden ? 0 : this.wrapper.getBoundingClientRect().height;
        this.container.dispatchEvent(new CustomEvent('gltf-terminalresize', { detail: { height } }));
    }

    dispose() {
        document.removeEventListener('gltf-status', this.statusListener);
        document.removeEventListener('gltf-status-update', this.statusUpdateListener);
        this.wrapper.remove();
        this.hidden = true;
        this.dispatchResize();
        delete this.container.gltfStatusTerminal;
    }
}

export class GltfViewer {
    constructor(container, sceneData, glbBuffer) {
        this.container = container;
        this.sceneData = sceneData ?? {};
        this.glbBuffer = glbBuffer;

        // Unified selectable object model: one item per selectable object, its index is the
        // object id for batched payloads. { reference, name, properties, mesh, vertexStart, vertexCount }
        this.objects = [];
        this.batched = false;
        this.batchMeshes = [];
        this.originalColors = new Map();      // mesh -> Uint8Array copy of COLOR_0
        this.meshObjects = new Map();         // legacy: mesh -> object index

        this.hoveredId = null;
        this.selectedIds = new Set();
        this.center = new THREE.Vector3();
        this.radius = 10;
        this.sunState = { azimuth: 144, altitude: 49, intensity: 2.4, ambientIntensity: 0.6 };
        this.lastHoverTime = 0;
        this.bvh = null;

        // Environment settings driven by the built-in Settings panel (and the public setters).
        this.environmentState = { gizmoVisible: true, groundVisible: true, terminalVisible: true, fog: FOG_DEFAULT, viewRange: VIEW_RANGE_DEFAULT, scopeBoxEnabled: false, scopeBoxVisible: true };
        this.groundGroup = null;

        // Scope box: the six shared clipping planes are created once and mutated in place, so
        // every clipped material follows box drags without per-material updates. The box state
        // { center, halfExtents, quaternion } (three.js world space) is the single source of
        // truth for the visuals, the pick proxies, the caps and the planes; it stays null until
        // the first activation and survives disable/enable cycles.
        this.scopeBoxState = null;
        this.scopeBoxPlanes = [...Array(6)].map(() => new THREE.Plane());
        this.scopeBoxGroup = null;            // wireframe + handles + pick proxies (box transform)
        this.scopeBoxHandles = [];            // face push/pull arrow sprites
        this.scopeBoxRotateHandle = null;
        this.scopeBoxProxies = [];            // invisible raycast targets (edges, handle spheres)
        this.scopeBoxDrag = null;             // active drag descriptor, null when idle
        this.scopeBoxSelected = false;        // face/rotate gizmos revealed
        this.scopeBoxPending = false;         // enabled before the GLB finished loading
        this.hiddenIds = new Set();           // objects culled by the view range
        this.cullingReady = false;            // per-object centers/index ranges are computed
        this.cullRebuildTimer = null;
        this.originalIndices = new Map();     // mesh -> TypedArray copy of the full index buffer
        this.meshObjectIds = new Map();       // mesh -> object ids in index-buffer order (batched)
        this.edgeOverlays = new Map();        // mesh -> LineSegments edge overlay

        // Default right-click context menu; consuming applications may extend this array before
        // the first open. Item shape: { label, action(), isEnabled() } — isEnabled is evaluated
        // each time the menu opens.
        this.contextMenuItems = [
            { label: 'Fit view', action: () => this.frameScene(), isEnabled: () => true },
            { label: 'Fit selection', action: () => this.frameSelection(), isEnabled: () => this.selectedIds.size > 0 },
            { label: 'Clear selection', action: () => this.clearSelection(), isEnabled: () => true }
        ];

        this.initRenderer();
        this.initOverlays();
        this.initScene();
        this.initCameraAndControls();
        this.initContextMenu();
        // Scope box listeners register before the picking listeners on the same canvas so a box
        // interaction can consume the event (stopImmediatePropagation) before picking sees it.
        this.initScopeBox();
        this.initPicking();
        this.initViewCube();
        this.initStatusTerminal();
        this.initSettingsPanel();
        this.loadGlb();
        this.animate();
    }

    // Status terminal attached by default for every view; a host page opts out with
    // data-status-terminal="false" on the container, or reuses an instance it attached earlier
    // (e.g. to report statuses while the payload is still being fetched).
    initStatusTerminal() {
        this.container.addEventListener('gltf-terminalresize', (event) => {
            // Keep the other bottom-docked overlays above the terminal.
            const offset = Math.max(0, event.detail?.height ?? 0);
            this.hoverLabel.style.bottom = `${offset + 10}px`;
            this.viewCubeRenderer.domElement.style.bottom = `${offset + VIEW_CUBE_MARGIN}px`;
        });

        this.statusTerminal = GltfStatusTerminal.attach(this.container);
        this.statusTerminal?.dispatchResize();
    }

    initRenderer() {
        // Local clipping (scope box) is free while no material carries clipping planes.
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.localClippingEnabled = true;
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.container.appendChild(this.renderer.domElement);

        new ResizeObserver(() => this.onResize()).observe(this.container);
    }

    // The viewer creates its own overlay elements so consuming applications only provide a container.
    initOverlays() {
        this.hoverLabel = document.createElement('div');
        Object.assign(this.hoverLabel.style, {
            position: 'absolute', left: '10px', bottom: '10px', pointerEvents: 'none', zIndex: '6',
            padding: '3px 10px', borderRadius: '4px', background: 'rgba(20, 24, 32, 0.75)',
            color: '#e6e9ef', fontSize: '0.75rem', display: 'none', whiteSpace: 'nowrap'
        });
        this.container.appendChild(this.hoverLabel);

        this.marquee = document.createElement('div');
        Object.assign(this.marquee.style, {
            position: 'absolute', zIndex: '7', pointerEvents: 'none', display: 'none',
            border: '1px solid #4d90fe', background: 'rgba(77, 144, 254, 0.12)'
        });
        this.container.appendChild(this.marquee);

        this.marqueeStart = null;
        this.marqueeCurrent = null;
        this.marqueePreviewIds = new Set();
        this.marqueeBounds = null;
    }

    initScene() {
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x171a21);
    }

    initCameraAndControls() {
        const cameraData = this.sceneData.Camera ?? {};
        const fov = cameraData.FieldOfView ?? 50;

        this.camera = new THREE.PerspectiveCamera(fov, this.aspect(), 0.1, 100000);
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;

        // Revit-style navigation: middle mouse pans, Shift + middle mouse orbits,
        // the scroll wheel zooms. The left button is reserved for selection.
        this.controls.mouseButtons = {
            LEFT: null,
            MIDDLE: THREE.MOUSE.PAN,
            RIGHT: null
        };

        window.addEventListener('keydown', (event) => {
            if (event.key === 'Shift') {
                this.controls.mouseButtons.MIDDLE = THREE.MOUSE.ROTATE;
            }
        });

        window.addEventListener('keyup', (event) => {
            if (event.key === 'Shift') {
                this.controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
            }
        });

        // Prevent the browser autoscroll behavior on middle mouse drag.
        this.renderer.domElement.addEventListener('mousedown', (event) => {
            if (event.button === 1) {
                event.preventDefault();
            }
        });
    }

    // Built-in right-click context menu. The right mouse button is free (OrbitControls maps it to
    // null and picking only reacts to button 0), so the browser menu is replaced with the viewer
    // menu built from `contextMenuItems`. Styling is inline like the other overlays, so the menu
    // works in any host application without stylesheet support.
    initContextMenu() {
        this.contextMenu = document.createElement('div');
        Object.assign(this.contextMenu.style, {
            position: 'absolute', zIndex: '8', display: 'none', minWidth: '160px',
            padding: '4px 0', borderRadius: '6px', background: 'rgba(20, 24, 32, 0.95)',
            border: '1px solid rgba(255, 255, 255, 0.08)', boxShadow: '0 4px 16px rgba(0, 0, 0, 0.45)',
            color: '#e6e9ef', fontSize: '0.85rem', whiteSpace: 'nowrap', userSelect: 'none'
        });
        this.contextMenu.addEventListener('contextmenu', (event) => event.preventDefault());
        this.container.appendChild(this.contextMenu);

        this.renderer.domElement.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            this.openContextMenu(event);
        });

        // Any pointer press outside the menu closes it: left click, middle-mouse pan start, or a
        // right click elsewhere (which then reopens the menu at the new position).
        document.addEventListener('pointerdown', (event) => {
            if (this.contextMenu.style.display !== 'none' && !this.contextMenu.contains(event.target)) {
                this.closeContextMenu();
            }
        }, true);

        window.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && this.contextMenu.style.display !== 'none') {
                this.closeContextMenu();
            }
        });

        // Wheel zoom is a camera interaction that bypasses pointerdown.
        this.renderer.domElement.addEventListener('wheel', () => this.closeContextMenu());
    }

    openContextMenu(event) {
        // Items are rebuilt on each open so the enabled state reflects the current selection.
        this.contextMenu.innerHTML = '';
        for (const item of this.contextMenuItems) {
            const element = document.createElement('div');
            element.textContent = item.label;
            Object.assign(element.style, { padding: '6px 14px' });

            if (item.isEnabled()) {
                element.style.cursor = 'pointer';
                element.addEventListener('pointerenter', () => {
                    element.style.background = 'rgba(77, 144, 254, 0.18)';
                });
                element.addEventListener('pointerleave', () => {
                    element.style.background = 'transparent';
                });
                element.addEventListener('click', () => {
                    this.closeContextMenu();
                    item.action();
                });
            } else {
                element.style.color = '#5d6570';
                element.style.cursor = 'default';
            }

            this.contextMenu.appendChild(element);
        }

        // Measure hidden, then clamp so the menu never overflows the container.
        const position = this.containerPosition(event);
        this.contextMenu.style.visibility = 'hidden';
        this.contextMenu.style.display = 'block';
        const left = Math.max(4, Math.min(position.x, this.container.clientWidth - this.contextMenu.offsetWidth - 4));
        const top = Math.max(4, Math.min(position.y, this.container.clientHeight - this.contextMenu.offsetHeight - 4));
        this.contextMenu.style.left = `${left}px`;
        this.contextMenu.style.top = `${top}px`;
        this.contextMenu.style.visibility = 'visible';
    }

    closeContextMenu() {
        this.contextMenu.style.display = 'none';
    }

    aspect() {
        return this.container.clientWidth / Math.max(1, this.container.clientHeight);
    }

    onResize() {
        this.camera.aspect = this.aspect();
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    }

    async loadGlb() {
        if (!this.glbBuffer) {
            return;
        }

        // Optional raycast acceleration; the viewer works without it (throttled hover picking).
        try {
            this.bvh = await import('three-mesh-bvh');
            THREE.BufferGeometry.prototype.computeBoundsTree = this.bvh.computeBoundsTree;
            THREE.BufferGeometry.prototype.disposeBoundsTree = this.bvh.disposeBoundsTree;
            THREE.Mesh.prototype.raycast = this.bvh.acceleratedRaycast;
        } catch {
            this.bvh = null;
        }

        new GLTFLoader().parse(this.glbBuffer, '', (gltf) => {
            this.root = gltf.scene;
            // DiGi geometry is Z-up; rotate to the three.js Y-up convention.
            this.root.rotation.x = -Math.PI / 2;
            this.scene.add(this.root);
            this.root.updateMatrixWorld(true);

            // Streamed payloads are fully self-describing: the scene configuration (reference
            // point, lights, camera) travels in the scene extras. Values provided by the host
            // page take precedence over the embedded configuration.
            const configuration = gltf.scene?.userData?.sceneConfiguration;
            if (configuration) {
                this.sceneData = { ...configuration, ...this.sceneData };
                const fov = this.sceneData.Camera?.FieldOfView;
                if (fov) {
                    this.camera.fov = fov;
                    this.camera.updateProjectionMatrix();
                }
            }

            this.prepareMeshes(gltf);
            this.computeBounds();

            // The scope box was enabled before the payload arrived: the default box needs the
            // scene bounds, so the activation completes here.
            if (this.scopeBoxPending) {
                this.scopeBoxPending = false;
                this.setScopeBoxEnabled(true);
            }

            this.addGroundAndGrid();
            this.setupLights();
            this.applyFog();
            this.frameScene();

            this.container.dispatchEvent(new CustomEvent('gltf-ready', {
                detail: {
                    objectCount: this.objects.length,
                    referencePoint: this.sceneData.ReferencePoint ?? null,
                    name: this.sceneData.Name ?? null
                }
            }));

            // Deferred heavy work: edge overlays and raycast acceleration structures are built
            // after the first frame is presented so the UI never freezes on load.
            setTimeout(() => this.buildDeferredStructures(), 0);
        });
    }

    prepareMeshes(gltf) {
        const objectMap = gltf.scene?.userData?.objectMap ?? null;
        const meshes = [];
        this.root.traverse((object) => {
            if (object.isMesh) {
                meshes.push(object);
            }
        });

        const batchedMeshes = meshes.filter((mesh) => objectIdAttributeOf(mesh.geometry) !== null);
        this.batched = objectMap !== null && batchedMeshes.length > 0;

        if (this.batched) {
            this.batchMeshes = batchedMeshes;
            for (const mesh of this.batchMeshes) {
                mesh.castShadow = true;
                mesh.receiveShadow = true;
                mesh.frustumCulled = true;
                mesh.geometry.computeBoundingBox();
                mesh.geometry.computeBoundingSphere();

                // Original colors are kept so per-object highlight tints can be reverted exactly.
                const colorAttribute = mesh.geometry.getAttribute('color');
                if (colorAttribute) {
                    this.originalColors.set(mesh, new Uint8Array(colorAttribute.array));
                }
            }

            for (const entry of objectMap) {
                this.objects.push({
                    reference: entry.reference ?? '',
                    name: entry.name ?? '',
                    properties: entry.properties ?? null,
                    mesh: this.batchMeshes[entry.batchIndex] ?? null,
                    vertexStart: entry.vertexStart ?? 0,
                    vertexCount: entry.vertexCount ?? 0,
                    // Culling metadata, filled by buildCullingData in the deferred pass.
                    center: null,
                    indexStart: 0,
                    indexCount: 0
                });
            }
            return;
        }

        // Legacy payload: one glTF node per object.
        for (const mesh of meshes) {
            // Clone materials so highlighting one object does not affect others sharing the material.
            mesh.material = mesh.material.clone();
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            mesh.frustumCulled = true;

            let userData = mesh.userData && Object.keys(mesh.userData).length > 0 ? mesh.userData : null;
            if (!userData && mesh.parent && mesh.parent.userData && Object.keys(mesh.parent.userData).length > 0) {
                userData = mesh.parent.userData;
            }

            this.meshObjects.set(mesh, this.objects.length);
            this.objects.push({
                reference: mesh.name || '',
                name: mesh.name || '',
                properties: userData,
                mesh: mesh,
                vertexStart: 0,
                vertexCount: mesh.geometry.getAttribute('position')?.count ?? 0,
                center: null,
                indexStart: 0,
                indexCount: 0
            });
        }
    }

    // Deferred heavy work after the first presented frame: culling metadata, the initial view
    // range application, then the raycast BVH and edge overlays (built last so they reflect the
    // culled index buffers).
    buildDeferredStructures() {
        this.buildCullingData();
        this.applyCulling();
        this.rebuildAcceleration();
    }

    // Precomputes the per-object view-range culling metadata: the world-space center of every
    // object (its bounding-box middle) and, for batched payloads, the contiguous index-buffer
    // range of every object plus a copy of the full index buffer to rebuild filtered indices from.
    buildCullingData() {
        const vertex = new THREE.Vector3();

        if (this.batched) {
            for (const mesh of this.batchMeshes) {
                const index = mesh.geometry.index;
                const idAttribute = objectIdAttributeOf(mesh.geometry);
                if (!index || !idAttribute) {
                    continue;
                }

                this.originalIndices.set(mesh, index.array.slice());

                // Objects occupy contiguous index ranges, so one pass over the triangles collecting
                // the id runs yields every object's index range in buffer order.
                const ids = [];
                const array = index.array;
                let runId = -1;
                for (let i = 0; i < array.length; i += 3) {
                    const id = Math.round(idAttribute.getX(array[i]));
                    const object = this.objects[id];
                    if (!object) {
                        runId = -1;
                        continue;
                    }
                    if (id !== runId) {
                        ids.push(id);
                        object.indexStart = i;
                        object.indexCount = 0;
                        runId = id;
                    }
                    object.indexCount += 3;
                }
                this.meshObjectIds.set(mesh, ids);
            }
        }

        for (const object of this.objects) {
            const mesh = object.mesh;
            if (!mesh) {
                continue;
            }

            if (this.batched) {
                const position = mesh.geometry.getAttribute('position');
                if (!position || object.vertexCount === 0) {
                    continue;
                }
                mesh.updateWorldMatrix(true, false);
                const box = new THREE.Box3();
                const end = object.vertexStart + object.vertexCount;
                for (let i = object.vertexStart; i < end; i++) {
                    vertex.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
                    box.expandByPoint(vertex);
                }
                object.center = box.getCenter(new THREE.Vector3());
            } else {
                object.center = new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3());
            }
        }

        this.cullingReady = true;
    }

    // Applies the current view range: objects whose center lies further from the scene center
    // than the range (horizontal distance — DiGi XY maps to three.js XZ) are hidden. Batched
    // meshes are culled by rebuilding their index buffer from the visible objects' contiguous
    // index ranges; legacy meshes simply toggle visibility. Hidden objects leave the selection
    // and lose their hover state. Returns whether the hidden set changed.
    applyCulling() {
        if (!this.cullingReady) {
            return false;
        }

        const range = this.environmentState.viewRange;
        const hidden = new Set();
        for (let id = 0; id < this.objects.length; id++) {
            const center = this.objects[id].center;
            if (center && Math.hypot(center.x - this.center.x, center.z - this.center.z) > range) {
                hidden.add(id);
            }
        }

        let changed = hidden.size !== this.hiddenIds.size;
        if (!changed) {
            for (const id of hidden) {
                if (!this.hiddenIds.has(id)) {
                    changed = true;
                    break;
                }
            }
        }
        if (!changed) {
            return false;
        }

        this.hiddenIds = hidden;

        if (this.hoveredId !== null && hidden.has(this.hoveredId)) {
            this.applyHighlight(this.hoveredId);
            this.hoveredId = null;
            this.hoverLabel.style.display = 'none';
        }

        if (this.batched) {
            for (const mesh of this.batchMeshes) {
                this.rebuildBatchIndex(mesh);
            }
        } else {
            for (let id = 0; id < this.objects.length; id++) {
                const mesh = this.objects[id].mesh;
                if (mesh) {
                    mesh.visible = !hidden.has(id);
                }
            }
        }

        if ([...this.selectedIds].some((id) => hidden.has(id))) {
            this.select([...this.selectedIds].filter((id) => !hidden.has(id)));
        }

        return true;
    }

    // Rebuilds the merged index buffer of one batched mesh so it only contains the triangles of
    // visible objects. The stale BVH is dropped immediately (the accelerated raycast falls back
    // to the plain path until rebuildAcceleration recomputes it).
    rebuildBatchIndex(mesh) {
        const original = this.originalIndices.get(mesh);
        const ids = this.meshObjectIds.get(mesh);
        if (!original || !ids) {
            return;
        }

        let count = 0;
        for (const id of ids) {
            if (!this.hiddenIds.has(id)) {
                count += this.objects[id].indexCount;
            }
        }

        const filtered = new original.constructor(count);
        let offset = 0;
        for (const id of ids) {
            if (this.hiddenIds.has(id)) {
                continue;
            }
            const object = this.objects[id];
            filtered.set(original.subarray(object.indexStart, object.indexStart + object.indexCount), offset);
            offset += object.indexCount;
        }

        mesh.geometry.setIndex(new THREE.BufferAttribute(filtered, 1));
        if (mesh.geometry.boundsTree) {
            mesh.geometry.disposeBoundsTree();
        }
    }

    // (Re)builds the raycast BVH and the edge overlays from the current (possibly culled) index
    // buffers. Runs deferred after load and debounced after view-range changes.
    rebuildAcceleration() {
        const pickables = this.batched ? this.batchMeshes : this.objects.map((o) => o.mesh);

        // Raycast acceleration (BVH) for large merged meshes.
        if (this.bvh) {
            for (const mesh of pickables) {
                if (mesh?.geometry && !mesh.geometry.boundsTree) {
                    mesh.geometry.computeBoundsTree();
                }
            }
        }

        this.buildEdgeOverlays(pickables);
    }

    // Edge overlays for visual quality, skipped for extreme triangle counts. Existing overlays
    // are disposed first so the edges always match the current index buffers.
    buildEdgeOverlays(meshes) {
        for (const [mesh, edges] of this.edgeOverlays) {
            mesh.remove(edges);
            edges.geometry.dispose();
            edges.material.dispose();
        }
        this.edgeOverlays.clear();

        let totalTriangles = 0;
        for (const mesh of meshes) {
            if (mesh?.geometry?.index) {
                totalTriangles += mesh.geometry.index.count / 3;
            }
        }
        if (totalTriangles > EDGES_TRIANGLE_LIMIT) {
            return;
        }

        for (const mesh of meshes) {
            if (!mesh?.geometry) {
                continue;
            }
            const edges = new THREE.LineSegments(
                new THREE.EdgesGeometry(mesh.geometry, 25),
                new THREE.LineBasicMaterial({ color: 0x11141b, transparent: true, opacity: 0.55 }));
            edges.raycast = () => { };
            mesh.add(edges);
            this.edgeOverlays.set(mesh, edges);
        }

        // Overlays are rebuilt after view-range changes; the fresh line materials must pick up
        // the current scope box clipping state (a no-op null assignment when disabled).
        this.applyScopeBoxClipping();
    }

    computeBounds() {
        const box = new THREE.Box3().setFromObject(this.root);
        if (box.isEmpty()) {
            return;
        }
        box.getCenter(this.center);
        this.radius = Math.max(1, box.getSize(new THREE.Vector3()).length() / 2);
    }

    // Ground group at the DiGi world elevation Z = 0: a visible ground plate, the line grid and a
    // transparent shadow catcher. The scene is translated by the reference point and rotated to
    // Y-up, so world Z = 0 sits at three.js y = -ReferencePoint.Z. Everything lives in one group
    // toggled by the "Show ground" setting; none of it is pickable (only this.root meshes are).
    addGroundAndGrid() {
        const size = this.radius * 8;
        const elevation = -(this.sceneData.ReferencePoint?.Z ?? 0);

        this.groundGroup = new THREE.Group();
        this.groundGroup.visible = this.environmentState.groundVisible;

        const ground = new THREE.Mesh(
            new THREE.PlaneGeometry(size, size),
            new THREE.MeshLambertMaterial({ color: GROUND_COLOR }));
        ground.rotation.x = -Math.PI / 2;
        ground.position.set(this.center.x, elevation - GROUND_OFFSET, this.center.z);
        ground.receiveShadow = true;
        this.groundGroup.add(ground);

        const grid = new THREE.GridHelper(size, 40, 0x39404f, 0x232833);
        grid.position.set(this.center.x, elevation - GROUND_GRID_OFFSET, this.center.z);
        this.groundGroup.add(grid);

        const shadowCatcher = new THREE.Mesh(
            new THREE.PlaneGeometry(size, size),
            new THREE.ShadowMaterial({ opacity: 0.35 }));
        shadowCatcher.rotation.x = -Math.PI / 2;
        shadowCatcher.position.set(this.center.x, elevation - GROUND_SHADOW_OFFSET, this.center.z);
        shadowCatcher.receiveShadow = true;
        this.groundGroup.add(shadowCatcher);

        this.scene.add(this.groundGroup);
    }

    setupLights() {
        const lights = this.sceneData.Lights ?? [];

        let sunDirection = new THREE.Vector3(-0.5, -1, 0.7).normalize();
        let sunColor = new THREE.Color(0xffffff);
        let ambientColor = new THREE.Color(0xffffff);

        for (const light of lights) {
            const type = lightTypeOf(light);
            if (type === LIGHT_TYPE.AMBIENT) {
                this.sunState.ambientIntensity = light.Intensity ?? this.sunState.ambientIntensity;
                ambientColor = lightColorOf(light);
            } else if (type === LIGHT_TYPE.DIRECTIONAL) {
                this.sunState.intensity = light.Intensity ?? this.sunState.intensity;
                sunColor = lightColorOf(light);
                if (light.Direction) {
                    sunDirection = toThree(light.Direction).normalize();
                }
            } else if (type === LIGHT_TYPE.POINT) {
                const pointLight = new THREE.PointLight(lightColorOf(light), light.Intensity ?? 1);
                if (light.Position) {
                    pointLight.position.copy(toThree(light.Position));
                }
                this.scene.add(pointLight);
            }
        }

        this.ambientLight = new THREE.AmbientLight(ambientColor, this.sunState.ambientIntensity);
        this.scene.add(this.ambientLight);

        this.sunLight = new THREE.DirectionalLight(sunColor, this.sunState.intensity);
        this.sunLight.castShadow = true;
        const shadowExtent = this.radius * 2;
        this.sunLight.shadow.camera.left = -shadowExtent;
        this.sunLight.shadow.camera.right = shadowExtent;
        this.sunLight.shadow.camera.top = shadowExtent;
        this.sunLight.shadow.camera.bottom = -shadowExtent;
        this.sunLight.shadow.camera.far = this.radius * 10;
        this.sunLight.shadow.mapSize.set(2048, 2048);
        this.sunLight.target.position.copy(this.center);
        this.scene.add(this.sunLight);
        this.scene.add(this.sunLight.target);

        // Derive the initial azimuth/altitude from the scene sun direction (from-sun vector).
        const toSun = sunDirection.clone().multiplyScalar(-1);
        this.sunState.altitude = Math.max(2, THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(toSun.y, -1, 1))));
        let azimuth = THREE.MathUtils.radToDeg(Math.atan2(toSun.x, toSun.z));
        if (azimuth < 0) {
            azimuth += 360;
        }
        this.sunState.azimuth = azimuth;

        this.applySunState();
    }

    // The sun position is driven by azimuth/altitude so it can later follow the real
    // sun path during the day (solar simulation): both values map directly to a solar position.
    applySunState() {
        if (!this.sunLight) {
            return;
        }

        const azimuthRad = THREE.MathUtils.degToRad(this.sunState.azimuth);
        const altitudeRad = THREE.MathUtils.degToRad(this.sunState.altitude);

        const distance = this.radius * 4;
        this.sunLight.position.set(
            this.center.x + distance * Math.cos(altitudeRad) * Math.sin(azimuthRad),
            this.center.y + distance * Math.sin(altitudeRad),
            this.center.z + distance * Math.cos(altitudeRad) * Math.cos(azimuthRad));
        this.sunLight.target.position.copy(this.center);
        this.sunLight.intensity = this.sunState.intensity;
        this.ambientLight.intensity = this.sunState.ambientIntensity;
    }

    getSunState() {
        return { ...this.sunState };
    }

    setSun(azimuth, altitude) {
        this.sunState.azimuth = azimuth;
        this.sunState.altitude = altitude;
        this.applySunState();
    }

    setSunIntensity(intensity) {
        this.sunState.intensity = intensity;
        this.applySunState();
    }

    setAmbientIntensity(intensity) {
        this.sunState.ambientIntensity = intensity;
        this.applySunState();
    }

    getEnvironmentState() {
        return { ...this.environmentState };
    }

    setGizmoVisible(visible) {
        this.environmentState.gizmoVisible = !!visible;
        if (this.viewCubeRenderer) {
            this.viewCubeRenderer.domElement.style.display = this.environmentState.gizmoVisible ? 'block' : 'none';
        }
    }

    setGroundVisible(visible) {
        this.environmentState.groundVisible = !!visible;
        if (this.groundGroup) {
            this.groundGroup.visible = this.environmentState.groundVisible;
        }
    }

    // Normalized fog control: 0 disables the fog, 1 places the fully fogged distance at the
    // scene radius. The fog color matches the scene background so distant areas dissolve into it.
    setFog(value) {
        this.environmentState.fog = THREE.MathUtils.clamp(Number(value) || 0, 0, 1);
        this.applyFog();
    }

    applyFog() {
        const value = this.environmentState.fog;
        this.scene.fog = value > 0
            ? new THREE.FogExp2(0x171a21, value * FOG_FALLOFF / Math.max(this.radius, 1))
            : null;
    }

    // View range in meters (default 2000): objects whose center lies further from the scene
    // center than the range are not rendered. The index rebuild runs immediately; the expensive
    // BVH/edge-overlay rebuild is debounced so slider drags stay responsive.
    setViewRange(range) {
        const value = Number(range);
        if (!isFinite(value) || value <= 0) {
            return;
        }

        this.environmentState.viewRange = value;
        if (this.applyCulling()) {
            clearTimeout(this.cullRebuildTimer);
            this.cullRebuildTimer = setTimeout(() => this.rebuildAcceleration(), CULL_REBUILD_DELAY_MS);
        }
    }

    frameScene() {
        const cameraData = this.sceneData.Camera ?? {};

        if (cameraData.AutoFrame === false && cameraData.Position && cameraData.Target) {
            this.camera.position.copy(toThree(cameraData.Position));
            this.controls.target.copy(toThree(cameraData.Target));
            this.controls.update();
            return;
        }

        this.frameBounds(this.center, this.radius);
    }

    // Places the camera so the bounding sphere (center, radius) fits the view with 1.25 padding.
    // The optional direction keeps a caller-chosen viewing angle; the default is the canonical
    // scene-framing direction.
    frameBounds(center, radius, direction = new THREE.Vector3(1, 0.65, 1).normalize()) {
        const fovRad = THREE.MathUtils.degToRad(this.camera.fov);
        const distance = (radius / Math.tan(fovRad / 2)) * 0.75;

        this.camera.position.copy(center.clone().add(direction.clone().multiplyScalar(distance)));
        this.camera.near = Math.max(0.01, distance / 1000);
        this.camera.far = distance * 100;
        this.camera.updateProjectionMatrix();
        this.controls.target.copy(center);
        this.controls.update();
    }

    // Fits the camera to the currently selected objects, preserving the current viewing angle so
    // the view zooms/pans to the selection without swinging around it. No-op when nothing is
    // selected or the selection has no geometry.
    frameSelection() {
        const box = this.selectionBounds();
        if (!box) {
            return;
        }

        const center = box.getCenter(new THREE.Vector3());
        const radius = Math.max(0.5, box.getSize(new THREE.Vector3()).length() / 2);
        const direction = this.camera.position.clone().sub(this.controls.target);
        this.frameBounds(center, radius, direction.lengthSq() > 1e-6 ? direction.normalize() : undefined);
    }

    // Union world-space bounding box over the selected objects, or null when empty. Batched
    // objects share one merged mesh, so their geometry is the contiguous vertex sub-range
    // [vertexStart, vertexStart + vertexCount) — Box3.setFromObject would measure the whole batch.
    selectionBounds() {
        const box = new THREE.Box3();
        const vertex = new THREE.Vector3();

        for (const id of this.selectedIds) {
            const object = this.objects[id];
            const mesh = object?.mesh;
            if (!mesh) {
                continue;
            }

            if (this.batched) {
                const position = mesh.geometry?.getAttribute('position');
                if (!position || object.vertexCount === 0) {
                    continue;
                }
                mesh.updateWorldMatrix(true, false);
                const end = object.vertexStart + object.vertexCount;
                for (let i = object.vertexStart; i < end; i++) {
                    vertex.fromBufferAttribute(position, i);
                    vertex.applyMatrix4(mesh.matrixWorld);
                    box.expandByPoint(vertex);
                }
            } else {
                box.union(new THREE.Box3().setFromObject(mesh));
            }
        }

        return box.isEmpty() ? null : box;
    }

    clearSelection() {
        this.select([]);
    }

    // Returns the opaque payload (glTF extras / batched objectMap properties) attached by the
    // producing application for the object with the given reference, or null when not available.
    getUserData(reference) {
        const object = this.objects.find((o) => o.reference === reference);
        return object ? object.properties : null;
    }

    initPicking() {
        this.raycaster = new THREE.Raycaster();
        this.pointer = new THREE.Vector2();

        const dom = this.renderer.domElement;

        dom.addEventListener('pointermove', (event) => {
            // Scope box drags own the pointer (their handlers registered first and stop
            // propagation); the guard keeps picking inert even if an event slips through.
            if (this.scopeBoxDrag) {
                return;
            }
            if (this.marqueeStart) {
                this.updateMarquee(event);
                return;
            }
            this.updatePointer(event);
            this.updateHover(event);
        });

        dom.addEventListener('pointerdown', (event) => {
            if (event.button !== 0 || this.scopeBoxDrag) {
                return;
            }
            this.marqueeStart = this.containerPosition(event);
            this.marqueeCurrent = null;
            this.marqueeBounds = null;
            // Keep receiving pointer events when the drag leaves the canvas; capture can be
            // unavailable for some pointer types, in which case the drag still works within the canvas.
            try {
                dom.setPointerCapture(event.pointerId);
            } catch {
                // Ignored: pointer capture is an enhancement, not a requirement.
            }
        });

        dom.addEventListener('pointerup', (event) => {
            if (event.button !== 0 || !this.marqueeStart || this.scopeBoxDrag) {
                return;
            }

            try {
                dom.releasePointerCapture(event.pointerId);
            } catch {
                // Ignored: the pointer may not have been captured.
            }

            const start = this.marqueeStart;
            const end = this.containerPosition(event);
            this.marqueeStart = null;
            this.hideMarquee();

            if (Math.hypot(end.x - start.x, end.y - start.y) <= MARQUEE_THRESHOLD) {
                // Plain click: single selection via raycasting.
                this.updateMarqueePreview([]);
                this.marqueeBounds = null;
                this.updatePointer(event);
                const id = this.pick();
                this.select(id === null ? [] : [id]);
                return;
            }

            const ids = this.marqueeSelect(start, end);
            this.updateMarqueePreview([]);
            this.marqueeBounds = null;
            this.select(ids);
        });

        // Zooming with the wheel mid-drag moves the camera, which invalidates the screen-space
        // bounds cached for the active marquee.
        this.controls.addEventListener('change', () => {
            this.marqueeBounds = null;
        });
    }

    containerPosition(event) {
        const rect = this.renderer.domElement.getBoundingClientRect();
        return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    }

    updateMarquee(event) {
        this.marqueeCurrent = this.containerPosition(event);

        const start = this.marqueeStart;
        const current = this.marqueeCurrent;

        if (Math.hypot(current.x - start.x, current.y - start.y) <= MARQUEE_THRESHOLD) {
            this.updateMarqueePreview([]);
            return;
        }

        // Right-to-left drags perform a crossing selection and are drawn with a dashed rectangle.
        const crossing = current.x < start.x;
        this.marquee.style.borderStyle = crossing ? 'dashed' : 'solid';
        this.marquee.style.borderColor = crossing ? '#58c07a' : '#4d90fe';
        this.marquee.style.background = crossing ? 'rgba(88, 192, 122, 0.12)' : 'rgba(77, 144, 254, 0.12)';
        this.marquee.style.display = 'block';
        this.marquee.style.left = `${Math.min(start.x, current.x)}px`;
        this.marquee.style.top = `${Math.min(start.y, current.y)}px`;
        this.marquee.style.width = `${Math.abs(current.x - start.x)}px`;
        this.marquee.style.height = `${Math.abs(current.y - start.y)}px`;

        // Live preview: highlight the objects the marquee would select on release.
        this.updateMarqueePreview(this.marqueeSelect(start, current));
    }

    // Retints the objects the active marquee would select so the selection is visible while
    // dragging. Only the difference against the previous preview is retinted, keeping pointer
    // moves cheap. Passing an empty list clears the preview.
    updateMarqueePreview(ids) {
        const previewIds = new Set(ids);

        for (const id of this.marqueePreviewIds) {
            if (!previewIds.has(id)) {
                this.applyHighlight(id);
            }
        }

        for (const id of previewIds) {
            if (!this.marqueePreviewIds.has(id)) {
                this.applyHighlight(id, SELECTED_TINT);
            }
        }

        this.marqueePreviewIds = previewIds;
    }

    hideMarquee() {
        this.marquee.style.display = 'none';
    }

    // Directional marquee selection over the unified object model: every object projects its own
    // contiguous vertex range (batched) or its whole geometry (legacy) to screen space.
    // - Window (left-to-right): only objects completely inside the rectangle.
    // - Crossing (right-to-left): objects whose screen-space bounding box intersects the rectangle.
    // The projected bounds only depend on the camera, which cannot orbit during a left drag, so
    // they are computed once per drag and reused for every live preview rectangle test.
    marqueeSelect(start, end) {
        if (!this.marqueeBounds) {
            this.marqueeBounds = this.computeScreenBounds();
        }

        const crossing = end.x < start.x;

        const minX = Math.min(start.x, end.x);
        const maxX = Math.max(start.x, end.x);
        const minY = Math.min(start.y, end.y);
        const maxY = Math.max(start.y, end.y);

        const selected = [];
        for (let id = 0; id < this.marqueeBounds.length; id++) {
            const bounds = this.marqueeBounds[id];
            if (!bounds) {
                continue;
            }

            if (crossing) {
                if (bounds.minX <= maxX && bounds.maxX >= minX && bounds.minY <= maxY && bounds.maxY >= minY) {
                    selected.push(id);
                }
            } else {
                if (bounds.allInFront && bounds.minX >= minX && bounds.maxX <= maxX && bounds.minY >= minY && bounds.maxY <= maxY) {
                    selected.push(id);
                }
            }
        }

        // With an active scope box, objects whose center lies outside the box are not marquee
        // selectable (boundary-straddling objects with an outside center are a documented
        // approximation; click picking still reaches their visible interior parts).
        if (this.environmentState.scopeBoxEnabled && this.scopeBoxState !== null && this.cullingReady) {
            return selected.filter((id) => {
                const center = this.objects[id]?.center;
                return center && this.scopeBoxContains(center);
            });
        }

        return selected;
    }

    // Projects every object's vertex range to screen space and returns its 2D bounding box, or
    // null for objects without projectable geometry (missing positions, fully behind the camera).
    computeScreenBounds() {
        const width = this.container.clientWidth;
        const height = this.container.clientHeight;
        const vertex = new THREE.Vector3();
        const viewMatrix = this.camera.matrixWorldInverse;
        const projectionMatrix = this.camera.projectionMatrix;

        const screenBounds = new Array(this.objects.length).fill(null);
        for (let id = 0; id < this.objects.length; id++) {
            if (this.hiddenIds.has(id)) {
                continue;
            }
            const object = this.objects[id];
            const mesh = object.mesh;
            const positionAttribute = mesh?.geometry?.getAttribute('position');
            if (!positionAttribute || object.vertexCount === 0) {
                continue;
            }

            mesh.updateWorldMatrix(true, false);
            const matrixWorld = mesh.matrixWorld;

            let pMinX = Infinity;
            let pMinY = Infinity;
            let pMaxX = -Infinity;
            let pMaxY = -Infinity;
            let anyInFront = false;
            let allInFront = true;

            const endIndex = object.vertexStart + object.vertexCount;
            for (let i = object.vertexStart; i < endIndex; i++) {
                vertex.fromBufferAttribute(positionAttribute, i);
                vertex.applyMatrix4(matrixWorld);
                vertex.applyMatrix4(viewMatrix);

                // The camera looks along -Z in camera space; vertices behind it cannot be projected.
                if (vertex.z >= 0) {
                    allInFront = false;
                    continue;
                }
                anyInFront = true;

                vertex.applyMatrix4(projectionMatrix);

                const screenX = (vertex.x + 1) / 2 * width;
                const screenY = (-vertex.y + 1) / 2 * height;

                if (screenX < pMinX) pMinX = screenX;
                if (screenY < pMinY) pMinY = screenY;
                if (screenX > pMaxX) pMaxX = screenX;
                if (screenY > pMaxY) pMaxY = screenY;
            }

            if (!anyInFront) {
                continue;
            }

            screenBounds[id] = { minX: pMinX, minY: pMinY, maxX: pMaxX, maxY: pMaxY, allInFront };
        }

        return screenBounds;
    }

    updatePointer(event) {
        const rect = this.renderer.domElement.getBoundingClientRect();
        this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    }

    // Picks the object id under the pointer. For batched payloads the id is decoded from the
    // _OBJECTID vertex attribute at the raycast hit face. With an active scope box the raycast
    // walks all hits and takes the first one inside the box: a first-hit-only BVH result could
    // be a clipped-away fragment in front of the visible geometry.
    pick() {
        const scopeBoxActive = this.environmentState.scopeBoxEnabled && this.scopeBoxState !== null;
        this.raycaster.firstHitOnly = !!this.bvh && !scopeBoxActive;

        const pickables = this.batched ? this.batchMeshes : this.objects.map((o) => o.mesh);
        this.raycaster.setFromCamera(this.pointer, this.camera);
        const intersections = this.raycaster.intersectObjects(pickables, false);

        for (const intersection of intersections) {
            if (scopeBoxActive && !this.scopeBoxContains(intersection.point)) {
                continue;
            }

            if (!this.batched) {
                const id = this.meshObjects.get(intersection.object);
                // The raycaster does not honor mesh visibility, so view-range hidden objects are
                // filtered here.
                return id === undefined || this.hiddenIds.has(id) ? null : id;
            }

            const idAttribute = objectIdAttributeOf(intersection.object.geometry);
            if (!idAttribute || !intersection.face) {
                return null;
            }

            // Culled triangles are absent from the rebuilt index, but a stale BVH can still report
            // them between an index rebuild and the debounced BVH rebuild.
            const id = Math.round(idAttribute.getX(intersection.face.a));
            return this.hiddenIds.has(id) ? null : id;
        }

        return null;
    }

    updateHover(event) {
        // Without BVH acceleration, hover raycasts against large merged meshes are throttled.
        if (!this.bvh) {
            const now = performance.now();
            if (now - this.lastHoverTime < HOVER_THROTTLE_MS) {
                return;
            }
            this.lastHoverTime = now;
        }

        const id = this.pick();

        if (this.hoveredId !== null && this.hoveredId !== id) {
            this.applyHighlight(this.hoveredId);
        }

        this.hoveredId = id;

        if (id !== null) {
            this.applyHighlight(id, this.selectedIds.has(id) ? SELECTED_TINT : HOVER_TINT);
            this.renderer.domElement.style.cursor = 'pointer';
            this.hoverLabel.style.display = 'block';
            this.hoverLabel.textContent = this.objects[id].name || 'Object';
        } else {
            this.renderer.domElement.style.cursor = 'default';
            this.hoverLabel.style.display = 'none';
        }
    }

    // Applies (or clears, when tint is null) the highlight of a single object.
    // Batched payloads tint the object's contiguous vertex color range in place; legacy payloads
    // use the material emissive channel.
    applyHighlight(id, tint = null) {
        const object = this.objects[id];
        if (!object?.mesh) {
            return;
        }

        if (tint === null && this.selectedIds.has(id)) {
            tint = SELECTED_TINT;
        }

        if (!this.batched) {
            const emissive = tint === SELECTED_TINT ? SELECTED_EMISSIVE : tint === HOVER_TINT ? HOVER_EMISSIVE : null;
            object.mesh.material.emissive = emissive ? emissive.clone() : new THREE.Color(0x000000);
            return;
        }

        const colorAttribute = object.mesh.geometry.getAttribute('color');
        const original = this.originalColors.get(object.mesh);
        if (!colorAttribute || !original) {
            return;
        }

        const colors = colorAttribute.array;
        const start = object.vertexStart * 4;
        const count = object.vertexCount * 4;

        if (tint === null) {
            // Restore the exact original colors.
            colors.set(original.subarray(start, start + count), start);
        } else {
            const [tr, tg, tb] = tint.color;
            const strength = tint.strength;
            for (let i = start; i < start + count; i += 4) {
                colors[i] = original[i] + (tr - original[i]) * strength;
                colors[i + 1] = original[i + 1] + (tg - original[i + 1]) * strength;
                colors[i + 2] = original[i + 2] + (tb - original[i + 2]) * strength;
                // Alpha stays untouched.
            }
        }

        // Upload only the touched range to the GPU.
        colorAttribute.addUpdateRange(start, count);
        colorAttribute.needsUpdate = true;
    }

    select(ids) {
        for (const id of this.selectedIds) {
            this.selectedIds.delete(id);
            this.applyHighlight(id);
        }

        this.selectedIds = new Set(ids ?? []);

        for (const id of this.selectedIds) {
            this.applyHighlight(id, SELECTED_TINT);
        }

        // Broadcast the generic identifiers of the selected objects; consuming applications
        // decide how to present them (for example a domain-specific properties panel).
        const references = [...this.selectedIds].map((id) => this.objects[id]?.reference ?? '');
        this.container.dispatchEvent(new CustomEvent('gltf-selectionchanged', { detail: { references } }));
    }

    // ------------------------------------------------------------------------------------------
    // ViewCube: a Revit-style navigation gizmo in the bottom-right corner of the viewport.
    // The cube stays axis-aligned in its own miniature scene while the gizmo camera mirrors the
    // main camera orientation each frame, so the cube visually orbits with the scene and every
    // pick zone's outward direction is directly the world-space direction to align the camera to.
    // Rendered through its own small transparent renderer instead of a scissor pass on the main
    // canvas: the gizmo canvas captures its own pointer events, so a left press on the cube can
    // never start a marquee selection on the main canvas underneath.
    // ------------------------------------------------------------------------------------------
    initViewCube() {
        this.viewCubeAnimation = null;
        this.viewCubeHovered = null;
        this.viewCubePointerDown = null;

        this.viewCubeRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.viewCubeRenderer.setPixelRatio(window.devicePixelRatio);
        this.viewCubeRenderer.setSize(VIEW_CUBE_SIZE, VIEW_CUBE_SIZE);
        Object.assign(this.viewCubeRenderer.domElement.style, {
            position: 'absolute', right: `${VIEW_CUBE_MARGIN}px`, bottom: `${VIEW_CUBE_MARGIN}px`,
            zIndex: '6', cursor: 'default', touchAction: 'none'
        });
        this.container.appendChild(this.viewCubeRenderer.domElement);

        this.viewCubeScene = new THREE.Scene();
        this.viewCubeCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 20);

        // Hemisphere + directional lighting gives the Lambert faces enough shading contrast to
        // read the cube's 3D orientation without washing out the labels.
        this.viewCubeScene.add(new THREE.HemisphereLight(0xffffff, 0xb9c0c8, 1.1));
        const light = new THREE.DirectionalLight(0xffffff, 0.5);
        light.position.set(2, 3, 4);
        this.viewCubeScene.add(light);

        // Labeled unit cube. BoxGeometry material order: +X, -X, +Y, -Y, +Z, -Z. DiGi scenes are
        // Z-up rotated to Y-up, so three.js +Y is the DiGi up axis: TOP/BOTTOM sit on +-Y.
        const labels = ['RIGHT', 'LEFT', 'TOP', 'BOTTOM', 'FRONT', 'BACK'];
        this.viewCubeScene.add(new THREE.Mesh(
            new THREE.BoxGeometry(1, 1, 1),
            labels.map((label) => new THREE.MeshLambertMaterial({ map: this.viewCubeFaceTexture(label) }))));

        this.viewCubeScene.add(new THREE.LineSegments(
            new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002)),
            new THREE.LineBasicMaterial({ color: 0x7a8494, transparent: true, opacity: 0.85 })));

        this.viewCubeZones = this.createViewCubeZones();
        this.viewCubeRaycaster = new THREE.Raycaster();

        const dom = this.viewCubeRenderer.domElement;

        dom.addEventListener('pointermove', (event) => {
            const zone = this.pickViewCubeZone(event);
            this.setViewCubeHovered(zone);
            dom.style.cursor = zone ? 'pointer' : 'default';
        });

        dom.addEventListener('pointerleave', () => {
            this.setViewCubeHovered(null);
            dom.style.cursor = 'default';
        });

        dom.addEventListener('pointerdown', (event) => {
            if (event.button === 0) {
                this.viewCubePointerDown = { x: event.clientX, y: event.clientY };
            }
        });

        dom.addEventListener('click', (event) => {
            // Ignore clicks that ended a drag gesture on the gizmo.
            const down = this.viewCubePointerDown;
            this.viewCubePointerDown = null;
            if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) {
                return;
            }

            const zone = this.pickViewCubeZone(event);
            if (zone) {
                this.alignViewToDirection(zone.userData.viewCubeDirection);
            }
        });

        dom.addEventListener('contextmenu', (event) => event.preventDefault());

        // A user interaction with the main view takes over the camera immediately.
        this.controls.addEventListener('start', () => {
            this.viewCubeAnimation = null;
        });
    }

    // Flat light face plate with a centered label and a subtle inset border.
    viewCubeFaceTexture(label) {
        const canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 128;

        const context = canvas.getContext('2d');
        context.fillStyle = '#f2f5f8';
        context.fillRect(0, 0, 128, 128);
        context.strokeStyle = '#c4cdd8';
        context.lineWidth = 2;
        context.strokeRect(1, 1, 126, 126);
        context.fillStyle = '#3d4653';
        context.font = '600 21px "Segoe UI", system-ui, sans-serif';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(label, 64, 64);

        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        return texture;
    }

    // 26 pick zones tile the cube surface like Revit: 6 face centers, 12 edge bands, 8 corner
    // cubelets. Each zone doubles as its own hover highlight (opacity 0 until hovered) and
    // carries the world direction the camera moves to when clicked. Zones straddle the surface
    // (half inside, half outside), so an edge/corner highlight wraps both adjacent faces while
    // the inner half stays hidden by the opaque cube.
    createViewCubeZones() {
        const zones = [];
        const faceSize = 0.7;                    // central face region of the unit cube
        const bandSize = (1 - faceSize) / 2;     // edge/corner band width

        for (let x = -1; x <= 1; x++) {
            for (let y = -1; y <= 1; y++) {
                for (let z = -1; z <= 1; z++) {
                    if (x === 0 && y === 0 && z === 0) {
                        continue;
                    }

                    const signs = [x, y, z];
                    const zone = new THREE.Mesh(
                        new THREE.BoxGeometry(
                            ...signs.map((sign) => (sign === 0 ? faceSize : bandSize * 2))),
                        new THREE.MeshBasicMaterial({
                            color: VIEW_CUBE_HIGHLIGHT, transparent: true, opacity: 0, depthWrite: false
                        }));
                    zone.position.set(x * 0.5, y * 0.5, z * 0.5);
                    zone.userData.viewCubeDirection = new THREE.Vector3(x, y, z).normalize();

                    this.viewCubeScene.add(zone);
                    zones.push(zone);
                }
            }
        }

        return zones;
    }

    pickViewCubeZone(event) {
        const rect = this.viewCubeRenderer.domElement.getBoundingClientRect();
        const pointer = new THREE.Vector2(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            -((event.clientY - rect.top) / rect.height) * 2 + 1);

        this.viewCubeRaycaster.setFromCamera(pointer, this.viewCubeCamera);
        const intersections = this.viewCubeRaycaster.intersectObjects(this.viewCubeZones, false);
        return intersections.length > 0 ? intersections[0].object : null;
    }

    setViewCubeHovered(zone) {
        if (this.viewCubeHovered === zone) {
            return;
        }
        if (this.viewCubeHovered) {
            this.viewCubeHovered.material.opacity = 0;
        }
        this.viewCubeHovered = zone;
        if (zone) {
            zone.material.opacity = VIEW_CUBE_HOVER_OPACITY;
        }
    }

    // Smoothly rotates the camera around the current orbit target until the view axis matches
    // the given world direction (camera placed on the +direction side, looking back at the
    // target). Distance and target are preserved; the sweep is a quaternion slerp so the camera
    // travels the great-circle arc instead of cutting through the scene.
    alignViewToDirection(direction) {
        const offset = this.camera.position.clone().sub(this.controls.target);
        const distance = Math.max(offset.length(), 1e-6);
        const from = offset.lengthSq() > 1e-12 ? offset.normalize() : new THREE.Vector3(0, 0, 1);
        const to = direction.clone().normalize();

        // A perfect top/bottom view is parallel to the camera up axis, which degenerates the
        // OrbitControls azimuth. Nudge toward the current horizontal heading (visually still a
        // perfect plan view), so the arrival keeps the heading and the view stays orbitable.
        if (Math.abs(to.y) > 0.9999) {
            const horizontal = new THREE.Vector3(from.x, 0, from.z);
            const hint = horizontal.lengthSq() > 1e-8 ? horizontal.normalize() : new THREE.Vector3(0, 0, 1);
            to.addScaledVector(hint, 0.001).normalize();
        }

        this.viewCubeAnimation = {
            from,
            distance,
            rotation: new THREE.Quaternion().setFromUnitVectors(from, to),
            start: performance.now()
        };
    }

    // Advances a pending click-to-align tween by moving the main camera along the great-circle
    // arc. Runs before controls.update() so OrbitControls sees the tweened position as the
    // authoritative camera state for the frame.
    updateViewCubeAnimation() {
        const animation = this.viewCubeAnimation;
        if (!animation) {
            return;
        }

        const t = Math.min(1, (performance.now() - animation.start) / VIEW_CUBE_ALIGN_MS);
        const eased = t * t * (3 - 2 * t); // smoothstep ease-in-out
        const rotation = new THREE.Quaternion().slerpQuaternions(new THREE.Quaternion(), animation.rotation, eased);
        const direction = animation.from.clone().applyQuaternion(rotation);
        this.camera.position.copy(this.controls.target).addScaledVector(direction, animation.distance);

        if (t >= 1) {
            this.viewCubeAnimation = null;
        }
    }

    // Mirrors the final main camera orientation of the frame onto the gizmo camera (the cube
    // itself stays axis aligned) and renders the gizmo scene. Runs after the main render so the
    // gizmo never lags the damped camera by a frame.
    updateViewCube() {
        const direction = this.camera.position.clone().sub(this.controls.target);
        if (direction.lengthSq() < 1e-12) {
            direction.set(0, 0, 1);
        }
        this.viewCubeCamera.position.copy(direction.normalize().multiplyScalar(2.4));
        this.viewCubeCamera.up.copy(this.camera.up);
        this.viewCubeCamera.lookAt(0, 0, 0);

        this.viewCubeRenderer.render(this.viewCubeScene, this.viewCubeCamera);
    }

    // ------------------------------------------------------------------------------------------
    // Scope box: a Revit-style clipping cuboid. Six world-space clipping planes (shared Plane
    // instances mutated in place, so every clipped material follows drags for free) restrict
    // rendering to the box interior; geometry crossing the boundary is cut open, exactly like a
    // plain clipped view. The visuals live in scopeBoxGroup: the cyan wireframe, the push/pull
    // and rotate handle sprites and the invisible raycast proxies (box transform, hidden by
    // "Scope Box visible" while the clipping stays active).
    // Interactions: press-drag an edge moves the box on a camera-facing plane, a click on an
    // edge toggles the gizmos, dragging a face arrow pushes/pulls that face along its normal
    // (opposite face fixed) and the rotate handle spins the box about the vertical axis.
    // ------------------------------------------------------------------------------------------
    initScopeBox() {
        this.scopeBoxRaycaster = new THREE.Raycaster();

        const dom = this.renderer.domElement;

        dom.addEventListener('pointerdown', (event) => {
            if (event.button !== 0 || !this.scopeBoxInteractive()) {
                return;
            }
            const hit = this.pickScopeBoxPart(event);
            if (!hit) {
                // Clicking empty space or model geometry hides the gizmos; the event continues
                // to the picking handlers so object selection keeps working.
                this.setScopeBoxSelected(false);
                return;
            }
            event.stopImmediatePropagation();
            this.startScopeBoxDrag(hit, event);
        });

        dom.addEventListener('pointermove', (event) => {
            if (this.scopeBoxDrag) {
                event.stopImmediatePropagation();
                this.updateScopeBoxDrag(event);
                return;
            }
            // Hover feedback only while no marquee is active (the marquee owns the pointer).
            if (!this.scopeBoxInteractive() || this.marqueeStart) {
                return;
            }
            const hit = this.pickScopeBoxPart(event);
            if (hit) {
                event.stopImmediatePropagation();
                dom.style.cursor = hit.part.type === 'edge' ? 'move' : 'pointer';
                this.hoverLabel.style.display = 'none';
            }
        });

        dom.addEventListener('pointerup', (event) => {
            if (event.button !== 0 || !this.scopeBoxDrag) {
                return;
            }
            event.stopImmediatePropagation();
            this.endScopeBoxDrag(event);
        });
    }

    scopeBoxInteractive() {
        return this.environmentState.scopeBoxEnabled && this.scopeBoxState !== null
            && this.scopeBoxGroup !== null && this.scopeBoxGroup.visible;
    }

    // Ground elevation convention shared with addGroundAndGrid: DiGi world Z = 0 sits at
    // three.js y = -ReferencePoint.Z.
    scopeBoxElevation() {
        return -(this.sceneData.ReferencePoint?.Z ?? 0);
    }

    setScopeBoxEnabled(enabled) {
        const value = !!enabled;
        this.environmentState.scopeBoxEnabled = value;

        if (value && !this.root) {
            // The GLB has not been parsed yet; the default box needs the scene bounds, so the
            // activation completes in loadGlb.
            this.scopeBoxPending = true;
            this.dispatchScopeBoxChanged();
            return;
        }
        this.scopeBoxPending = false;

        if (value) {
            if (!this.scopeBoxState) {
                this.initializeScopeBoxDefaults();
            }
            this.ensureScopeBoxGroup();
            this.updateScopeBoxVisuals();
        } else {
            this.setScopeBoxSelected(false);
            this.scopeBoxDrag = null;
        }

        if (this.scopeBoxGroup) {
            this.scopeBoxGroup.visible = value && this.environmentState.scopeBoxVisible;
        }
        this.applyScopeBoxClipping();
        this.dispatchScopeBoxChanged();
    }

    // Hides only the box visuals (wireframe, handles); the clipping planes stay active.
    setScopeBoxVisible(visible) {
        this.environmentState.scopeBoxVisible = !!visible;
        if (this.scopeBoxGroup) {
            this.scopeBoxGroup.visible = this.environmentState.scopeBoxEnabled && this.environmentState.scopeBoxVisible;
            if (!this.scopeBoxGroup.visible) {
                this.setScopeBoxSelected(false);
            }
        }
        this.dispatchScopeBoxChanged();
    }

    // Reports the box in DiGi Z-up coordinates: three.js world (x, y, z) -> DiGi
    // (x, -z, y - elevation); the rotation about the vertical axis carries over sign-identically.
    getScopeBoxState() {
        const { scopeBoxEnabled, scopeBoxVisible } = this.environmentState;
        if (!this.scopeBoxState) {
            return { enabled: scopeBoxEnabled, visible: scopeBoxVisible, center: null, size: null, rotation: 0 };
        }

        const { center, halfExtents, quaternion } = this.scopeBoxState;
        const elevation = this.scopeBoxElevation();
        return {
            enabled: scopeBoxEnabled,
            visible: scopeBoxVisible,
            center: { X: center.x, Y: -center.z, Z: center.y - elevation },
            size: { X: halfExtents.x * 2, Y: halfExtents.z * 2, Z: halfExtents.y * 2 },
            rotation: THREE.MathUtils.radToDeg(2 * Math.atan2(quaternion.y, quaternion.w))
        };
    }

    dispatchScopeBoxChanged() {
        this.container.dispatchEvent(new CustomEvent('gltf-scopeboxchanged', { detail: this.getScopeBoxState() }));
    }

    // "halfX;halfY;zMin;zMax" in DiGi coordinates from data-scope-box-size, or null when the
    // attribute is missing or malformed (the bounds-fit default applies then).
    parseScopeBoxPreset(text) {
        const parts = (text ?? '').split(';').map(Number);
        if (parts.length !== 4 || parts.some((part) => !isFinite(part)) || parts[0] <= 0 || parts[1] <= 0 || parts[3] <= parts[2]) {
            return null;
        }
        return { halfX: parts[0], halfY: parts[1], zMin: parts[2], zMax: parts[3] };
    }

    // First-activation default: the per-view preset centered on the scene (DiGi X half extent ->
    // three x, DiGi Y -> three z, DiGi Z range -> three y above the ground elevation), or a
    // bounds fit of the loaded model with a small margin.
    initializeScopeBoxDefaults() {
        const preset = this.parseScopeBoxPreset(this.container.dataset.scopeBoxSize);
        if (preset) {
            const elevation = this.scopeBoxElevation();
            const halfHeight = (preset.zMax - preset.zMin) / 2;
            this.scopeBoxState = {
                center: new THREE.Vector3(this.center.x, elevation + preset.zMin + halfHeight, this.center.z),
                halfExtents: new THREE.Vector3(preset.halfX, halfHeight, preset.halfY),
                quaternion: new THREE.Quaternion()
            };
            return;
        }

        const box = new THREE.Box3().setFromObject(this.root);
        if (box.isEmpty()) {
            box.setFromCenterAndSize(this.center, new THREE.Vector3(this.radius, this.radius, this.radius));
        }
        box.expandByScalar(Math.max(1, this.radius * 0.02));
        this.scopeBoxState = {
            center: box.getCenter(new THREE.Vector3()),
            halfExtents: box.getSize(new THREE.Vector3()).multiplyScalar(0.5),
            quaternion: new THREE.Quaternion()
        };
    }

    // Cyan handle glyphs drawn on canvas (same idiom as the ViewCube face textures): a paired
    // double arrow for the face push/pull handles (sprite rotation aligns it with the projected
    // face normal) and a circular arrow for the rotate handle.
    scopeBoxGlyphTexture(kind) {
        const canvas = document.createElement('canvas');
        canvas.width = 96;
        canvas.height = 96;

        const context = canvas.getContext('2d');
        context.fillStyle = '#00e0e0';
        context.strokeStyle = '#00e0e0';

        if (kind === 'arrow') {
            context.beginPath();
            context.moveTo(56, 32);
            context.lineTo(56, 64);
            context.lineTo(88, 48);
            context.closePath();
            context.fill();
            context.beginPath();
            context.moveTo(40, 32);
            context.lineTo(40, 64);
            context.lineTo(8, 48);
            context.closePath();
            context.fill();
        } else {
            context.lineWidth = 9;
            context.beginPath();
            context.arc(48, 48, 28, -Math.PI * 0.85, Math.PI * 0.55);
            context.stroke();
            const tipAngle = Math.PI * 0.55;
            const tipX = 48 + 28 * Math.cos(tipAngle);
            const tipY = 48 + 28 * Math.sin(tipAngle);
            context.beginPath();
            context.moveTo(tipX + 14, tipY + 2);
            context.lineTo(tipX - 8, tipY + 12);
            context.lineTo(tipX - 2, tipY - 12);
            context.closePath();
            context.fill();
        }

        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        return texture;
    }

    // Lazily builds the two scope box groups on the first activation.
    ensureScopeBoxGroup() {
        if (this.scopeBoxGroup) {
            return;
        }

        this.scopeBoxGroup = new THREE.Group();
        this.scopeBoxGroup.visible = false;

        const edgesGeometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
        this.scopeBoxWireframe = new THREE.LineSegments(edgesGeometry,
            new THREE.LineBasicMaterial({ color: SCOPE_BOX_COLOR }));
        this.scopeBoxWireframe.raycast = () => { };
        this.scopeBoxGroup.add(this.scopeBoxWireframe);

        // Faint depth-ignoring silhouette so the box outline reads through geometry.
        this.scopeBoxSilhouette = new THREE.LineSegments(edgesGeometry,
            new THREE.LineBasicMaterial({ color: SCOPE_BOX_COLOR, transparent: true, opacity: 0.25, depthTest: false }));
        this.scopeBoxSilhouette.raycast = () => { };
        this.scopeBoxSilhouette.renderOrder = 20;
        this.scopeBoxGroup.add(this.scopeBoxSilhouette);

        const arrowTexture = this.scopeBoxGlyphTexture('arrow');
        for (let i = 0; i < SCOPE_BOX_FACES.length; i++) {
            const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: arrowTexture, depthTest: false, transparent: true }));
            sprite.renderOrder = 21;
            sprite.visible = false;
            this.scopeBoxGroup.add(sprite);
            this.scopeBoxHandles.push(sprite);
        }

        this.scopeBoxRotateHandle = new THREE.Sprite(
            new THREE.SpriteMaterial({ map: this.scopeBoxGlyphTexture('rotate'), depthTest: false, transparent: true }));
        this.scopeBoxRotateHandle.renderOrder = 21;
        this.scopeBoxRotateHandle.visible = false;
        this.scopeBoxGroup.add(this.scopeBoxRotateHandle);

        // Invisible raycast targets; Mesh.raycast ignores material visibility, so the proxies
        // pick without ever rendering. Edges are always interactive (move/select); the face and
        // rotate spheres only react while the gizmos are revealed.
        const proxyMaterial = new THREE.MeshBasicMaterial({ visible: false });
        for (let axis = 0; axis < 3; axis++) {
            for (const signB of [-1, 1]) {
                for (const signC of [-1, 1]) {
                    const proxy = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), proxyMaterial);
                    proxy.userData.scopeBoxPart = { type: 'edge', axis, signB, signC };
                    this.scopeBoxGroup.add(proxy);
                    this.scopeBoxProxies.push(proxy);
                }
            }
        }
        for (let i = 0; i < SCOPE_BOX_FACES.length; i++) {
            const proxy = new THREE.Mesh(new THREE.SphereGeometry(0.75, 8, 8), proxyMaterial);
            proxy.userData.scopeBoxPart = { type: 'face', face: i };
            this.scopeBoxGroup.add(proxy);
            this.scopeBoxProxies.push(proxy);
        }
        const rotateProxy = new THREE.Mesh(new THREE.SphereGeometry(0.75, 8, 8), proxyMaterial);
        rotateProxy.userData.scopeBoxPart = { type: 'rotate' };
        this.scopeBoxGroup.add(rotateProxy);
        this.scopeBoxProxies.push(rotateProxy);

        this.scene.add(this.scopeBoxGroup);
    }

    // Local position of the rotate handle: floating just outside the +X top edge of the box, so
    // it rotates with the box and stays reachable from above.
    scopeBoxRotateHandlePosition() {
        const halfExtents = this.scopeBoxState.halfExtents;
        return new THREE.Vector3(halfExtents.x * 1.15, halfExtents.y, 0);
    }

    // Re-derives every visual from the box state: group transform, wireframe scale, handle and
    // proxy placements, then the clipping planes.
    updateScopeBoxVisuals() {
        if (!this.scopeBoxGroup || !this.scopeBoxState) {
            return;
        }

        const { center, halfExtents, quaternion } = this.scopeBoxState;
        const extents = [halfExtents.x, halfExtents.y, halfExtents.z];

        this.scopeBoxGroup.position.copy(center);
        this.scopeBoxGroup.quaternion.copy(quaternion);

        this.scopeBoxWireframe.scale.set(extents[0] * 2, extents[1] * 2, extents[2] * 2);
        this.scopeBoxSilhouette.scale.copy(this.scopeBoxWireframe.scale);

        const thickness = Math.max(0.05, 2 * halfExtents.length() * SCOPE_BOX_EDGE_PICK_RATIO);
        for (const proxy of this.scopeBoxProxies) {
            const part = proxy.userData.scopeBoxPart;
            if (part.type === 'edge') {
                const axisB = (part.axis + 1) % 3;
                const axisC = (part.axis + 2) % 3;
                const position = [0, 0, 0];
                position[axisB] = part.signB * extents[axisB];
                position[axisC] = part.signC * extents[axisC];
                proxy.position.set(...position);
                const scale = [0, 0, 0];
                scale[part.axis] = extents[part.axis] * 2 + thickness;
                scale[axisB] = thickness;
                scale[axisC] = thickness;
                proxy.scale.set(...scale);
            } else if (part.type === 'face') {
                const [axis, sign] = SCOPE_BOX_FACES[part.face];
                const position = [0, 0, 0];
                position[axis] = sign * extents[axis];
                proxy.position.set(...position);
            } else {
                proxy.position.copy(this.scopeBoxRotateHandlePosition());
            }
        }

        for (let i = 0; i < this.scopeBoxHandles.length; i++) {
            const [axis, sign] = SCOPE_BOX_FACES[i];
            const position = [0, 0, 0];
            position[axis] = sign * extents[axis];
            this.scopeBoxHandles[i].position.set(...position);
        }
        this.scopeBoxRotateHandle.position.copy(this.scopeBoxRotateHandlePosition());

        this.updateScopeBoxPlanes();
    }

    // Recomputes the six world-space clipping planes from the box state, mutating the shared
    // Plane instances in place. three.js keeps fragments on the positive side of every plane,
    // so the normals point inward.
    updateScopeBoxPlanes() {
        const { center, halfExtents, quaternion } = this.scopeBoxState;
        const extents = [halfExtents.x, halfExtents.y, halfExtents.z];

        for (let i = 0; i < SCOPE_BOX_FACES.length; i++) {
            const [axis, sign] = SCOPE_BOX_FACES[i];
            const outward = new THREE.Vector3().setComponent(axis, sign).applyQuaternion(quaternion);
            const faceCenter = center.clone().addScaledVector(outward, extents[axis]);
            this.scopeBoxPlanes[i].setFromNormalAndCoplanarPoint(outward.negate(), faceCenter);
        }
    }

    forEachModelMaterial(callback) {
        this.root?.traverse((object) => {
            const material = object.material;
            if (!material) {
                return;
            }
            for (const item of Array.isArray(material) ? material : [material]) {
                callback(item);
            }
        });
    }

    // Assigns (or clears) the shared clipping planes on every model material - batched meshes,
    // legacy cloned materials and the edge overlay lines (mesh children) alike. Ground, grid,
    // ViewCube and the scope box visuals live outside this.root and are never clipped.
    applyScopeBoxClipping() {
        if (!this.root) {
            return;
        }

        const planes = this.environmentState.scopeBoxEnabled && this.scopeBoxState !== null ? this.scopeBoxPlanes : null;
        this.forEachModelMaterial((material) => {
            if (material.clippingPlanes === planes) {
                return;
            }
            material.clippingPlanes = planes;
            material.clipShadows = planes !== null;
            // The clipping plane count is part of the shader program key.
            material.needsUpdate = true;
        });
    }

    // Box containment with a small tolerance, in box-local coordinates.
    scopeBoxContains(worldPoint) {
        const { center, halfExtents, quaternion } = this.scopeBoxState;
        const local = worldPoint.clone().sub(center).applyQuaternion(quaternion.clone().invert());
        const epsilon = 1e-4;
        return Math.abs(local.x) <= halfExtents.x + epsilon
            && Math.abs(local.y) <= halfExtents.y + epsilon
            && Math.abs(local.z) <= halfExtents.z + epsilon;
    }

    setScopeBoxSelected(selected) {
        this.scopeBoxSelected = !!selected;
        for (const handle of this.scopeBoxHandles) {
            handle.visible = this.scopeBoxSelected;
        }
        if (this.scopeBoxRotateHandle) {
            this.scopeBoxRotateHandle.visible = this.scopeBoxSelected;
        }
    }

    // Raycasts the invisible proxies. Face/rotate parts only react while the gizmos are
    // revealed; edges are always interactive.
    pickScopeBoxPart(event) {
        this.updatePointer(event);
        this.scopeBoxRaycaster.setFromCamera(this.pointer, this.camera);
        const intersections = this.scopeBoxRaycaster.intersectObjects(this.scopeBoxProxies, false);
        for (const intersection of intersections) {
            const part = intersection.object.userData.scopeBoxPart;
            if (part.type === 'edge' || this.scopeBoxSelected) {
                return { part, point: intersection.point.clone() };
            }
        }
        return null;
    }

    // Intersection of the pointer ray with a plane, or null when parallel.
    scopeBoxRayPlanePoint(event, plane) {
        this.updatePointer(event);
        this.scopeBoxRaycaster.setFromCamera(this.pointer, this.camera);
        const point = new THREE.Vector3();
        return this.scopeBoxRaycaster.ray.intersectPlane(plane, point) ? point : null;
    }

    // Parameter t of the point on the line origin + direction * t closest to the pointer ray
    // (closest-point-between-lines with both directions normalized), or null when parallel.
    scopeBoxAxisParameter(event, origin, direction) {
        this.updatePointer(event);
        this.scopeBoxRaycaster.setFromCamera(this.pointer, this.camera);
        const ray = this.scopeBoxRaycaster.ray;

        const w = origin.clone().sub(ray.origin);
        const b = direction.dot(ray.direction);
        const d = direction.dot(w);
        const e = ray.direction.dot(w);
        const denominator = 1 - b * b;
        return Math.abs(denominator) < 1e-8 ? null : (b * e - d) / denominator;
    }

    startScopeBoxDrag(hit, event) {
        const dom = this.renderer.domElement;
        try {
            dom.setPointerCapture(event.pointerId);
        } catch {
            // Ignored: pointer capture is an enhancement, not a requirement.
        }
        this.controls.enabled = false;

        const { center, halfExtents, quaternion } = this.scopeBoxState;
        const drag = {
            part: hit.part,
            start: this.containerPosition(event),
            moved: false,
            grabPoint: hit.point,
            startCenter: center.clone(),
            startHalfExtents: halfExtents.clone(),
            startQuaternion: quaternion.clone()
        };

        if (hit.part.type === 'edge') {
            // Translation: the box follows the pointer on a camera-facing plane through the
            // grab point, giving full 3D movement that tracks the cursor.
            const normal = this.camera.getWorldDirection(new THREE.Vector3());
            drag.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, hit.point);
        } else if (hit.part.type === 'face') {
            const [axis, sign] = SCOPE_BOX_FACES[hit.part.face];
            drag.axis = axis;
            drag.outward = new THREE.Vector3().setComponent(axis, sign).applyQuaternion(quaternion);
            drag.origin = hit.point.clone();
            drag.startT = this.scopeBoxAxisParameter(event, drag.origin, drag.outward) ?? 0;
        } else {
            // Rotation on the horizontal plane through the box center.
            drag.plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -center.y);
            const point = this.scopeBoxRayPlanePoint(event, drag.plane) ?? hit.point;
            drag.startAngle = Math.atan2(point.z - center.z, point.x - center.x);
        }

        this.scopeBoxDrag = drag;
    }

    updateScopeBoxDrag(event) {
        const drag = this.scopeBoxDrag;
        const state = this.scopeBoxState;

        const position = this.containerPosition(event);
        if (Math.hypot(position.x - drag.start.x, position.y - drag.start.y) > MARQUEE_THRESHOLD) {
            drag.moved = true;
        }

        if (drag.part.type === 'edge') {
            const point = this.scopeBoxRayPlanePoint(event, drag.plane);
            if (point) {
                state.center.copy(drag.startCenter).add(point.sub(drag.grabPoint));
            }
        } else if (drag.part.type === 'face') {
            const t = this.scopeBoxAxisParameter(event, drag.origin, drag.outward);
            if (t !== null) {
                const startHalf = drag.startHalfExtents.getComponent(drag.axis);
                const half = Math.max(SCOPE_BOX_MIN_SIZE / 2, startHalf + (t - drag.startT) / 2);
                state.halfExtents.setComponent(drag.axis, half);
                // The opposite face stays fixed: the center follows the dragged face by half
                // the growth.
                state.center.copy(drag.startCenter).addScaledVector(drag.outward, half - startHalf);
            }
        } else {
            const point = this.scopeBoxRayPlanePoint(event, drag.plane);
            if (point) {
                // atan2(z, x) angles shrink under a positive Y rotation, hence startAngle - angle.
                const angle = Math.atan2(point.z - drag.startCenter.z, point.x - drag.startCenter.x);
                const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), drag.startAngle - angle);
                state.quaternion.copy(rotation.multiply(drag.startQuaternion));
            }
        }

        this.updateScopeBoxVisuals();
    }

    endScopeBoxDrag(event) {
        const dom = this.renderer.domElement;
        try {
            dom.releasePointerCapture(event.pointerId);
        } catch {
            // Ignored: the pointer may not have been captured.
        }
        this.controls.enabled = true;

        const drag = this.scopeBoxDrag;
        this.scopeBoxDrag = null;

        // A press without movement on an edge is a click: toggle the face/rotate gizmos.
        if (!drag.moved && drag.part.type === 'edge') {
            this.setScopeBoxSelected(!this.scopeBoxSelected);
        }

        this.dispatchScopeBoxChanged();
    }

    // Per-frame upkeep: constant screen-size handles (and matching pick spheres) plus the
    // screen-space orientation of the face push/pull arrows.
    updateScopeBoxFrame() {
        if (!this.scopeBoxInteractive()) {
            return;
        }

        const fovScale = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * SCOPE_BOX_HANDLE_SIZE * 2;
        const worldPosition = new THREE.Vector3();

        for (const sprite of [...this.scopeBoxHandles, this.scopeBoxRotateHandle]) {
            sprite.getWorldPosition(worldPosition);
            const size = worldPosition.distanceTo(this.camera.position) * fovScale;
            sprite.scale.set(size, size, 1);
        }

        for (const proxy of this.scopeBoxProxies) {
            const type = proxy.userData.scopeBoxPart.type;
            if (type === 'face' || type === 'rotate') {
                proxy.getWorldPosition(worldPosition);
                const size = worldPosition.distanceTo(this.camera.position) * fovScale;
                proxy.scale.set(size, size, size);
            }
        }

        if (!this.scopeBoxSelected) {
            return;
        }

        const { quaternion } = this.scopeBoxState;
        for (let i = 0; i < this.scopeBoxHandles.length; i++) {
            const sprite = this.scopeBoxHandles[i];
            const [axis, sign] = SCOPE_BOX_FACES[i];
            const outward = new THREE.Vector3().setComponent(axis, sign).applyQuaternion(quaternion);

            sprite.getWorldPosition(worldPosition);
            const projectedBase = worldPosition.clone().project(this.camera);
            const projectedTip = worldPosition.clone().add(outward).project(this.camera);
            const dx = (projectedTip.x - projectedBase.x) * this.aspect();
            const dy = projectedTip.y - projectedBase.y;
            if (dx * dx + dy * dy > 1e-12) {
                sprite.material.rotation = Math.atan2(dy, dx);
            }
        }
    }

    // ------------------------------------------------------------------------------------------
    // Settings panel with the environment controls (gizmo/ground visibility, fog, view range).
    // When the host page provides an element with id 'gltf-settings' (typically inside its own
    // left side panel card), the controls mount there and inherit the host theme. Without one,
    // the engine creates its own collapsible panel docked to the left edge of the viewport with
    // inline styling like the other overlays, so every consuming application gets the settings
    // by default without stylesheet support; hosts may reposition it through `this.settingsPanel`.
    // ------------------------------------------------------------------------------------------
    initSettingsPanel() {
        const hostElement = document.getElementById('gltf-settings');
        const floating = !hostElement;
        let content;

        if (floating) {
            this.settingsPanel = document.createElement('div');
            Object.assign(this.settingsPanel.style, {
                // Offset below the top-left corner so host-owned buttons (panel toggles) stay reachable.
                position: 'absolute', left: '12px', top: '54px', zIndex: '6', width: '200px',
                borderRadius: '6px', background: 'rgba(20, 24, 32, 0.92)',
                border: '1px solid rgba(255, 255, 255, 0.08)', boxShadow: '0 4px 16px rgba(0, 0, 0, 0.45)',
                color: '#e6e9ef', fontSize: '0.8rem', userSelect: 'none'
            });
            this.container.appendChild(this.settingsPanel);

            const header = document.createElement('div');
            Object.assign(header.style, {
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '8px 12px', fontWeight: '600', cursor: 'pointer',
                borderBottom: '1px solid rgba(255, 255, 255, 0.08)'
            });
            const title = document.createElement('span');
            title.textContent = 'Settings';
            const chevron = document.createElement('span');
            chevron.textContent = '▾';
            chevron.style.opacity = '0.7';
            header.appendChild(title);
            header.appendChild(chevron);
            this.settingsPanel.appendChild(header);

            content = document.createElement('div');
            Object.assign(content.style, {
                display: 'flex', flexDirection: 'column', gap: '10px', padding: '10px 12px'
            });
            this.settingsPanel.appendChild(content);

            header.addEventListener('click', () => {
                const collapsed = content.style.display === 'none';
                content.style.display = collapsed ? 'flex' : 'none';
                chevron.textContent = collapsed ? '▾' : '▸';
                header.style.borderBottom = collapsed ? '1px solid rgba(255, 255, 255, 0.08)' : 'none';
            });
        } else {
            this.settingsPanel = hostElement;
            content = hostElement;
            Object.assign(content.style, { display: 'flex', flexDirection: 'column', gap: '10px' });
        }

        const checkboxRow = (label, checked, onChange) => {
            const row = document.createElement('label');
            Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' });
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = checked;
            input.style.accentColor = '#4d90fe';
            input.addEventListener('change', () => onChange(input.checked));
            row.appendChild(input);
            row.appendChild(document.createTextNode(label));
            content.appendChild(row);
            return input;
        };

        const sliderLabel = (label) => {
            const wrapper = document.createElement('label');
            // Generic class hook so a themed host styles the rows like its own slider labels.
            wrapper.className = 'gltf-slider-label';
            Object.assign(wrapper.style, { display: 'flex', flexDirection: 'column', gap: '4px' });
            const caption = document.createElement('span');
            caption.textContent = label;
            wrapper.appendChild(caption);
            content.appendChild(wrapper);
            return wrapper;
        };

        checkboxRow('Show gizmo', this.environmentState.gizmoVisible, (checked) => this.setGizmoVisible(checked));
        checkboxRow('Show ground', this.environmentState.groundVisible, (checked) => this.setGroundVisible(checked));
        checkboxRow('Show terminal', this.environmentState.terminalVisible, (checked) => {
            this.environmentState.terminalVisible = checked;
            this.statusTerminal?.setVisible(checked);
        });

        // Scope box rows: the visibility toggle only applies while the box is enabled, so it is
        // disabled and grayed whenever the primary checkbox is unchecked.
        let scopeBoxVisibleInput = null;
        const syncScopeBoxVisibleRow = () => {
            const enabled = this.environmentState.scopeBoxEnabled;
            scopeBoxVisibleInput.disabled = !enabled;
            scopeBoxVisibleInput.parentElement.style.opacity = enabled ? '1' : '0.45';
            scopeBoxVisibleInput.parentElement.style.cursor = enabled ? 'pointer' : 'default';
        };
        checkboxRow('Scope Box', this.environmentState.scopeBoxEnabled, (checked) => {
            this.setScopeBoxEnabled(checked);
            syncScopeBoxVisibleRow();
        });
        scopeBoxVisibleInput = checkboxRow('Scope Box visible', this.environmentState.scopeBoxVisible,
            (checked) => this.setScopeBoxVisible(checked));
        syncScopeBoxVisibleRow();

        const fogWrapper = sliderLabel('Fog');
        const fogInput = document.createElement('input');
        fogInput.type = 'range';
        fogInput.min = '0';
        fogInput.max = '1';
        fogInput.step = '0.01';
        fogInput.value = String(this.environmentState.fog);
        fogInput.style.width = '100%';
        fogInput.addEventListener('input', () => this.setFog(parseFloat(fogInput.value)));
        fogWrapper.appendChild(fogInput);

        const rangeWrapper = sliderLabel('View range');
        const rangeSlider = document.createElement('input');
        rangeSlider.type = 'range';
        rangeSlider.min = String(VIEW_RANGE_MIN);
        rangeSlider.max = String(VIEW_RANGE_MAX);
        rangeSlider.step = '50';
        rangeSlider.value = String(this.environmentState.viewRange);
        rangeSlider.style.width = '100%';
        rangeWrapper.appendChild(rangeSlider);

        const rangeRow = document.createElement('div');
        Object.assign(rangeRow.style, { display: 'flex', alignItems: 'center', gap: '6px' });
        const rangeNumber = document.createElement('input');
        rangeNumber.type = 'number';
        rangeNumber.min = '1';
        rangeNumber.step = '50';
        rangeNumber.value = String(this.environmentState.viewRange);
        Object.assign(rangeNumber.style, { width: '80px', padding: '2px 6px', borderRadius: '4px' });
        if (floating) {
            // Dark chrome colors only for the engine-owned panel; hosted mode inherits the host theme.
            Object.assign(rangeNumber.style, {
                border: '1px solid rgba(255, 255, 255, 0.15)', background: 'rgba(255, 255, 255, 0.06)',
                color: '#e6e9ef', fontSize: '0.8rem'
            });
        }
        const rangeUnit = document.createElement('span');
        rangeUnit.textContent = 'm';
        rangeUnit.style.opacity = '0.7';
        rangeRow.appendChild(rangeNumber);
        rangeRow.appendChild(rangeUnit);
        rangeWrapper.appendChild(rangeRow);

        rangeSlider.addEventListener('input', () => {
            rangeNumber.value = rangeSlider.value;
            this.setViewRange(parseFloat(rangeSlider.value));
        });

        // The numeric input accepts values beyond the slider bounds; the slider just clamps its
        // thumb to the closest position.
        rangeNumber.addEventListener('change', () => {
            const value = parseFloat(rangeNumber.value);
            if (!isFinite(value) || value <= 0) {
                rangeNumber.value = String(this.environmentState.viewRange);
                return;
            }
            rangeSlider.value = String(THREE.MathUtils.clamp(value, VIEW_RANGE_MIN, VIEW_RANGE_MAX));
            this.setViewRange(value);
        });
    }

    animate() {
        this.renderer.setAnimationLoop(() => {
            this.updateViewCubeAnimation();
            this.controls.update();
            this.updateScopeBoxFrame();
            this.renderer.render(this.scene, this.camera);
            this.updateViewCube();
        });
    }
}
