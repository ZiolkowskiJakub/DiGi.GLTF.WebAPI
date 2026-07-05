// DiGi.GLTF.WebAPI — generic, reusable 3D glTF viewer engine.
// Renders a GLTFScene payload (scene JSON + binary glTF) without any domain knowledge:
// - Rendering pipeline: WebGL canvas, ground grid, shadows, autoframing camera, frustum culling.
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
// - Raycasting is accelerated with three-mesh-bvh when the optional module resolves; without it,
//   hover picking is throttled to keep the frame rate stable on large merged meshes.
// Integration contract for consuming applications:
// - Events dispatched on the container element:
//   'gltf-ready'            detail: { objectCount }
//   'gltf-selectionchanged' detail: { references: string[] } (generic object identifiers)
// - Public API: frameScene(), clearSelection(), getSunState(), setSun(azimuth, altitude),
//   setSunIntensity(value), setAmbientIntensity(value), getUserData(reference).
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

        this.initRenderer();
        this.initOverlays();
        this.initScene();
        this.initCameraAndControls();
        this.initPicking();
        this.loadGlb();
        this.animate();
    }

    initRenderer() {
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
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
            position: 'absolute', pointerEvents: 'none', zIndex: '6', padding: '2px 8px',
            borderRadius: '4px', background: 'rgba(20, 24, 32, 0.85)', color: '#e6e9ef',
            fontSize: '0.8rem', display: 'none', whiteSpace: 'nowrap'
        });
        this.container.appendChild(this.hoverLabel);

        this.marquee = document.createElement('div');
        Object.assign(this.marquee.style, {
            position: 'absolute', zIndex: '7', pointerEvents: 'none', display: 'none',
            border: '1px solid #4d90fe', background: 'rgba(77, 144, 254, 0.12)'
        });
        this.container.appendChild(this.marquee);

        this.controlsHint = document.createElement('div');
        Object.assign(this.controlsHint.style, {
            position: 'absolute', left: '10px', bottom: '10px', zIndex: '5', pointerEvents: 'none',
            padding: '3px 10px', borderRadius: '4px', background: 'rgba(20, 24, 32, 0.75)',
            color: '#9aa3b2', fontSize: '0.75rem', whiteSpace: 'nowrap'
        });
        this.controlsHint.textContent = 'Middle mouse: Pan · Shift + Middle mouse: Orbit · Wheel: Zoom · Left drag →: Window selection · Left drag ←: Crossing selection';
        this.container.appendChild(this.controlsHint);

        this.marqueeStart = null;
        this.marqueeCurrent = null;
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

        // Prevent the browser autoscroll behavior on middle mouse drag and the context menu.
        this.renderer.domElement.addEventListener('mousedown', (event) => {
            if (event.button === 1) {
                event.preventDefault();
            }
        });
        this.renderer.domElement.addEventListener('contextmenu', (event) => event.preventDefault());
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
            this.addGroundAndGrid();
            this.setupLights();
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
                    vertexCount: entry.vertexCount ?? 0
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
                vertexCount: mesh.geometry.getAttribute('position')?.count ?? 0
            });
        }
    }

    buildDeferredStructures() {
        const pickables = this.batched ? this.batchMeshes : this.objects.map((o) => o.mesh);

        let totalTriangles = 0;
        for (const mesh of pickables) {
            if (mesh?.geometry?.index) {
                totalTriangles += mesh.geometry.index.count / 3;
            }
        }

        // Raycast acceleration (BVH) for large merged meshes.
        if (this.bvh) {
            for (const mesh of pickables) {
                if (mesh?.geometry && !mesh.geometry.boundsTree) {
                    mesh.geometry.computeBoundsTree();
                }
            }
        }

        // Edge overlays for visual quality, skipped for extreme triangle counts.
        if (totalTriangles <= EDGES_TRIANGLE_LIMIT) {
            for (const mesh of pickables) {
                if (!mesh?.geometry) {
                    continue;
                }
                const edges = new THREE.LineSegments(
                    new THREE.EdgesGeometry(mesh.geometry, 25),
                    new THREE.LineBasicMaterial({ color: 0x11141b, transparent: true, opacity: 0.55 }));
                edges.raycast = () => { };
                mesh.add(edges);
            }
        }
    }

    computeBounds() {
        const box = new THREE.Box3().setFromObject(this.root);
        if (box.isEmpty()) {
            return;
        }
        box.getCenter(this.center);
        this.radius = Math.max(1, box.getSize(new THREE.Vector3()).length() / 2);
    }

    addGroundAndGrid() {
        const size = this.radius * 8;

        const grid = new THREE.GridHelper(size, 40, 0x39404f, 0x232833);
        grid.position.y = -0.02;
        this.scene.add(grid);

        const ground = new THREE.Mesh(
            new THREE.PlaneGeometry(size, size),
            new THREE.ShadowMaterial({ opacity: 0.35 }));
        ground.rotation.x = -Math.PI / 2;
        ground.position.y = -0.01;
        ground.receiveShadow = true;
        this.scene.add(ground);
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

    frameScene() {
        const cameraData = this.sceneData.Camera ?? {};

        if (cameraData.AutoFrame === false && cameraData.Position && cameraData.Target) {
            this.camera.position.copy(toThree(cameraData.Position));
            this.controls.target.copy(toThree(cameraData.Target));
            this.controls.update();
            return;
        }

        // Autoframing: place the camera so the whole bounding sphere fits the view.
        const fovRad = THREE.MathUtils.degToRad(this.camera.fov);
        const distance = (this.radius / Math.tan(fovRad / 2)) * 1.25;
        const direction = new THREE.Vector3(1, 0.65, 1).normalize();

        this.camera.position.copy(this.center.clone().add(direction.multiplyScalar(distance)));
        this.camera.near = Math.max(0.01, distance / 1000);
        this.camera.far = distance * 100;
        this.camera.updateProjectionMatrix();
        this.controls.target.copy(this.center);
        this.controls.update();
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
            if (this.marqueeStart) {
                this.updateMarquee(event);
                return;
            }
            this.updatePointer(event);
            this.updateHover(event);
        });

        dom.addEventListener('pointerdown', (event) => {
            if (event.button !== 0) {
                return;
            }
            this.marqueeStart = this.containerPosition(event);
            this.marqueeCurrent = null;
            // Keep receiving pointer events when the drag leaves the canvas; capture can be
            // unavailable for some pointer types, in which case the drag still works within the canvas.
            try {
                dom.setPointerCapture(event.pointerId);
            } catch {
                // Ignored: pointer capture is an enhancement, not a requirement.
            }
        });

        dom.addEventListener('pointerup', (event) => {
            if (event.button !== 0 || !this.marqueeStart) {
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
                this.updatePointer(event);
                const id = this.pick();
                this.select(id === null ? [] : [id]);
                return;
            }

            this.select(this.marqueeSelect(start, end));
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
    }

    hideMarquee() {
        this.marquee.style.display = 'none';
    }

    // Directional marquee selection over the unified object model: every object projects its own
    // contiguous vertex range (batched) or its whole geometry (legacy) to screen space.
    // - Window (left-to-right): only objects completely inside the rectangle.
    // - Crossing (right-to-left): objects whose screen-space bounding box intersects the rectangle.
    marqueeSelect(start, end) {
        const crossing = end.x < start.x;

        const minX = Math.min(start.x, end.x);
        const maxX = Math.max(start.x, end.x);
        const minY = Math.min(start.y, end.y);
        const maxY = Math.max(start.y, end.y);

        const width = this.container.clientWidth;
        const height = this.container.clientHeight;
        const vertex = new THREE.Vector3();
        const viewMatrix = this.camera.matrixWorldInverse;
        const projectionMatrix = this.camera.projectionMatrix;

        const selected = [];
        for (let id = 0; id < this.objects.length; id++) {
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

            if (crossing) {
                if (pMinX <= maxX && pMaxX >= minX && pMinY <= maxY && pMaxY >= minY) {
                    selected.push(id);
                }
            } else {
                if (allInFront && pMinX >= minX && pMaxX <= maxX && pMinY >= minY && pMaxY <= maxY) {
                    selected.push(id);
                }
            }
        }

        return selected;
    }

    updatePointer(event) {
        const rect = this.renderer.domElement.getBoundingClientRect();
        this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    }

    // Picks the object id under the pointer. For batched payloads the id is decoded from the
    // _OBJECTID vertex attribute at the raycast hit face.
    pick() {
        this.raycaster.firstHitOnly = !!this.bvh;

        const pickables = this.batched ? this.batchMeshes : this.objects.map((o) => o.mesh);
        this.raycaster.setFromCamera(this.pointer, this.camera);
        const intersections = this.raycaster.intersectObjects(pickables, false);
        if (intersections.length === 0) {
            return null;
        }

        const intersection = intersections[0];
        if (!this.batched) {
            const id = this.meshObjects.get(intersection.object);
            return id === undefined ? null : id;
        }

        const idAttribute = objectIdAttributeOf(intersection.object.geometry);
        if (!idAttribute || !intersection.face) {
            return null;
        }

        return Math.round(idAttribute.getX(intersection.face.a));
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
            const rect = this.container.getBoundingClientRect();
            this.hoverLabel.style.display = 'block';
            this.hoverLabel.style.left = `${event.clientX - rect.left + 12}px`;
            this.hoverLabel.style.top = `${event.clientY - rect.top + 12}px`;
            this.hoverLabel.textContent = this.objects[id].reference || this.objects[id].name || 'Object';
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

    animate() {
        this.renderer.setAnimationLoop(() => {
            this.controls.update();
            this.renderer.render(this.scene, this.camera);
        });
    }
}
