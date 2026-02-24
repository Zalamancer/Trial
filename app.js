import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

// ============================================================
// State
// ============================================================
const state = {
    scene: null,
    camera: null,
    renderer: null,
    orbitControls: null,
    transformControls: null,
    clock: new THREE.Clock(),

    // Model
    model: null,
    skeleton: null,
    bones: [],
    boneHelpers: null,
    skeletonHelper: null,

    // Selection
    selectedBone: null,
    boneVisuals: [],      // small spheres at bone positions for raycasting

    // Visibility
    showBones: true,
    showMesh: true,
    wireframe: false,

    // Transform mode
    transformMode: 'translate', // translate | rotate | scale
    transformSpace: 'local',

    // Animation
    fps: 24,
    totalFrames: 48,
    currentFrame: 0,
    isPlaying: false,
    keyframes: new Map(), // boneName -> Map(frame -> { position, quaternion, scale })

    // Original bone transforms (rest pose)
    restPose: new Map(), // boneName -> { position, quaternion, scale }
};

// ============================================================
// Init
// ============================================================
function init() {
    const canvas = document.getElementById('canvas');
    const viewport = document.getElementById('viewport');

    // Renderer
    state.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    state.renderer.setPixelRatio(window.devicePixelRatio);
    state.renderer.setClearColor(0x1a1a2e);
    state.renderer.shadowMap.enabled = true;
    state.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // Scene
    state.scene = new THREE.Scene();

    // Camera
    state.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    state.camera.position.set(3, 3, 5);

    // Orbit controls
    state.orbitControls = new OrbitControls(state.camera, canvas);
    state.orbitControls.enableDamping = true;
    state.orbitControls.dampingFactor = 0.08;
    state.orbitControls.target.set(0, 1, 0);

    // Transform controls
    state.transformControls = new TransformControls(state.camera, canvas);
    state.transformControls.setSize(0.75);
    state.scene.add(state.transformControls);

    state.transformControls.addEventListener('dragging-changed', (event) => {
        state.orbitControls.enabled = !event.value;
    });

    state.transformControls.addEventListener('objectChange', () => {
        updateBoneInfoPanel();
    });

    // Lights
    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    state.scene.add(ambient);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
    dirLight.position.set(5, 10, 7);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.set(2048, 2048);
    dirLight.shadow.camera.near = 0.5;
    dirLight.shadow.camera.far = 50;
    dirLight.shadow.camera.left = -10;
    dirLight.shadow.camera.right = 10;
    dirLight.shadow.camera.top = 10;
    dirLight.shadow.camera.bottom = -10;
    state.scene.add(dirLight);

    const hemiLight = new THREE.HemisphereLight(0x8899aa, 0x443322, 0.4);
    state.scene.add(hemiLight);

    // Grid
    const grid = new THREE.GridHelper(20, 20, 0x2a3a5e, 0x1e2d4d);
    state.scene.add(grid);

    // Axes helper
    const axes = new THREE.AxesHelper(1);
    axes.position.set(0, 0.001, 0);
    state.scene.add(axes);

    // Ground plane (for shadows)
    const groundGeo = new THREE.PlaneGeometry(20, 20);
    const groundMat = new THREE.ShadowMaterial({ opacity: 0.3 });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    state.scene.add(ground);

    resize();
    window.addEventListener('resize', resize);

    // Start loop
    animate();

    // Setup interactions
    setupDragAndDrop();
    setupFileInput();
    setupToolbar();
    setupKeyboard();
    setupViewportClick();
    setupTimeline();
}

function resize() {
    const viewport = document.getElementById('viewport');
    const w = viewport.clientWidth;
    const h = viewport.clientHeight;
    state.renderer.setSize(w, h);
    state.camera.aspect = w / h;
    state.camera.updateProjectionMatrix();
}

function animate() {
    requestAnimationFrame(animate);
    state.orbitControls.update();
    updateBoneVisuals();

    // Animation playback
    if (state.isPlaying) {
        state._playAccum = (state._playAccum || 0) + state.clock.getDelta();
        const frameDuration = 1 / state.fps;
        if (state._playAccum >= frameDuration) {
            state._playAccum -= frameDuration;
            state.currentFrame++;
            if (state.currentFrame >= state.totalFrames) {
                state.currentFrame = 0;
            }
            applyFramePose(state.currentFrame);
            updateFrameDisplay();
            drawTimeline();
        }
    } else {
        state.clock.getDelta(); // consume delta
    }

    state.renderer.render(state.scene, state.camera);
}

// ============================================================
// FBX Loading
// ============================================================
function loadFBX(arrayBuffer, fileName) {
    // Remove old model
    if (state.model) {
        state.scene.remove(state.model);
        if (state.skeletonHelper) state.scene.remove(state.skeletonHelper);
        clearBoneVisuals();
        state.transformControls.detach();
    }

    const loader = new FBXLoader();
    const blob = new Blob([arrayBuffer]);
    const url = URL.createObjectURL(blob);

    loader.load(url, (object) => {
        URL.revokeObjectURL(url);

        state.model = object;

        // Scale down if model is huge
        const box = new THREE.Box3().setFromObject(object);
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        if (maxDim > 10) {
            const s = 5 / maxDim;
            object.scale.multiplyScalar(s);
        }

        // Center on ground
        const box2 = new THREE.Box3().setFromObject(object);
        const center = box2.getCenter(new THREE.Vector3());
        object.position.x -= center.x;
        object.position.z -= center.z;
        object.position.y -= box2.min.y;

        // Enable shadows
        object.traverse((child) => {
            if (child.isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;
                if (child.material) {
                    const mats = Array.isArray(child.material) ? child.material : [child.material];
                    mats.forEach(m => {
                        m.side = THREE.DoubleSide;
                    });
                }
            }
        });

        state.scene.add(object);

        // Extract skeleton
        state.bones = [];
        state.restPose.clear();
        state.keyframes.clear();

        object.traverse((child) => {
            if (child.isBone) {
                state.bones.push(child);
                // Store rest pose
                state.restPose.set(child.name, {
                    position: child.position.clone(),
                    quaternion: child.quaternion.clone(),
                    scale: child.scale.clone(),
                });
            }
        });

        // Skeleton helper
        state.skeletonHelper = new THREE.SkeletonHelper(object);
        state.skeletonHelper.material.linewidth = 2;
        state.scene.add(state.skeletonHelper);

        // Build bone visuals for picking
        createBoneVisuals();

        // Build hierarchy UI
        buildBoneTree();

        // Focus camera
        const finalBox = new THREE.Box3().setFromObject(object);
        const finalCenter = finalBox.getCenter(new THREE.Vector3());
        const finalSize = finalBox.getSize(new THREE.Vector3());
        const dist = Math.max(finalSize.x, finalSize.y, finalSize.z) * 1.5;
        state.orbitControls.target.copy(finalCenter);
        state.camera.position.set(
            finalCenter.x + dist * 0.7,
            finalCenter.y + dist * 0.5,
            finalCenter.z + dist * 0.7
        );

        // Hide hint
        document.getElementById('no-model-hint').classList.add('hidden');

        // Reset timeline
        state.currentFrame = 0;
        updateFrameDisplay();
        buildTimelineTracks();
        drawTimeline();

        // If FBX has existing animations, load the first one
        if (object.animations && object.animations.length > 0) {
            importFBXAnimation(object.animations[0]);
        }

    }, undefined, (error) => {
        console.error('Error loading FBX:', error);
        alert('Failed to load FBX file. Check console for details.');
    });
}

function importFBXAnimation(clip) {
    state.keyframes.clear();

    // Determine duration in frames
    const duration = clip.duration;
    state.totalFrames = Math.max(1, Math.round(duration * state.fps));
    document.getElementById('duration-input').value = state.totalFrames;

    // Sample the animation at each frame
    for (const track of clip.tracks) {
        // Track names are like "boneName.position", "boneName.quaternion"
        const parts = track.name.split('.');
        const boneName = parts[0];
        const property = parts[1];

        const bone = state.bones.find(b => b.name === boneName);
        if (!bone) continue;

        if (!state.keyframes.has(boneName)) {
            state.keyframes.set(boneName, new Map());
        }
        const boneKeyframes = state.keyframes.get(boneName);

        // Sample at each frame
        const times = track.times;
        for (let i = 0; i < times.length; i++) {
            const frame = Math.round(times[i] * state.fps);
            if (frame < 0 || frame > state.totalFrames) continue;

            if (!boneKeyframes.has(frame)) {
                const rest = state.restPose.get(boneName);
                boneKeyframes.set(frame, {
                    position: rest ? rest.position.clone() : bone.position.clone(),
                    quaternion: rest ? rest.quaternion.clone() : bone.quaternion.clone(),
                    scale: rest ? rest.scale.clone() : bone.scale.clone(),
                });
            }

            const kf = boneKeyframes.get(frame);
            const values = track.values;
            const valueSize = track.getValueSize();
            const offset = i * valueSize;

            if (property === 'position') {
                kf.position.set(values[offset], values[offset + 1], values[offset + 2]);
            } else if (property === 'quaternion') {
                kf.quaternion.set(values[offset], values[offset + 1], values[offset + 2], values[offset + 3]);
            } else if (property === 'scale') {
                kf.scale.set(values[offset], values[offset + 1], values[offset + 2]);
            }
        }
    }

    // Apply first frame
    applyFramePose(0);
    buildTimelineTracks();
    drawTimeline();
    updateFrameDisplay();
}

// ============================================================
// Bone Visuals (for raycasting/picking)
// ============================================================
const BONE_SPHERE_RADIUS = 0.04;

function createBoneVisuals() {
    clearBoneVisuals();
    const geo = new THREE.SphereGeometry(BONE_SPHERE_RADIUS, 8, 8);

    state.bones.forEach((bone) => {
        const mat = new THREE.MeshBasicMaterial({
            color: 0x00ccff,
            transparent: true,
            opacity: 0.7,
            depthTest: false,
        });
        const sphere = new THREE.Mesh(geo, mat);
        sphere.userData.bone = bone;
        sphere.renderOrder = 999;
        state.scene.add(sphere);
        state.boneVisuals.push(sphere);
    });
}

function clearBoneVisuals() {
    state.boneVisuals.forEach(s => {
        state.scene.remove(s);
        s.geometry?.dispose();
        s.material?.dispose();
    });
    state.boneVisuals = [];
}

function updateBoneVisuals() {
    state.boneVisuals.forEach((sphere) => {
        const bone = sphere.userData.bone;
        if (bone) {
            const worldPos = new THREE.Vector3();
            bone.getWorldPosition(worldPos);
            sphere.position.copy(worldPos);

            // Highlight selected
            if (bone === state.selectedBone) {
                sphere.material.color.setHex(0xe94560);
                sphere.material.opacity = 1.0;
                sphere.scale.setScalar(1.8);
            } else {
                sphere.material.color.setHex(0x00ccff);
                sphere.material.opacity = 0.7;
                sphere.scale.setScalar(1.0);
            }
        }
    });

    // Skeleton helper visibility
    if (state.skeletonHelper) {
        state.skeletonHelper.visible = state.showBones;
    }
    state.boneVisuals.forEach(s => s.visible = state.showBones);
}

// ============================================================
// Selection
// ============================================================
function setupViewportClick() {
    const canvas = document.getElementById('canvas');
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    canvas.addEventListener('pointerdown', (event) => {
        // Skip if interacting with transform controls
        if (state.transformControls.dragging) return;

        const rect = canvas.getBoundingClientRect();
        mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        raycaster.setFromCamera(mouse, state.camera);

        // Check bone visuals first
        const boneHits = raycaster.intersectObjects(state.boneVisuals, false);
        if (boneHits.length > 0) {
            const bone = boneHits[0].object.userData.bone;
            if (bone) {
                selectBone(bone);
                return;
            }
        }

        // If no bone hit, check meshes to find nearest bone
        if (state.model) {
            const meshes = [];
            state.model.traverse(c => { if (c.isMesh) meshes.push(c); });
            const meshHits = raycaster.intersectObjects(meshes, false);
            if (meshHits.length > 0) {
                // Find closest bone to hit point
                const hitPoint = meshHits[0].point;
                let closestBone = null;
                let closestDist = Infinity;
                const wp = new THREE.Vector3();
                state.bones.forEach(bone => {
                    bone.getWorldPosition(wp);
                    const d = wp.distanceTo(hitPoint);
                    if (d < closestDist) {
                        closestDist = d;
                        closestBone = bone;
                    }
                });
                if (closestBone) {
                    selectBone(closestBone);
                    return;
                }
            }
        }
    });
}

function selectBone(bone) {
    state.selectedBone = bone;

    // Attach transform controls to bone
    state.transformControls.attach(bone);
    state.transformControls.setMode(state.transformMode);
    state.transformControls.setSpace(state.transformSpace);

    // Update UI
    document.getElementById('selected-bone-name').textContent = bone.name || '(unnamed)';
    updateBoneInfoPanel();

    // Highlight in tree
    document.querySelectorAll('.bone-node').forEach(el => el.classList.remove('selected'));
    const treeNode = document.querySelector(`.bone-node[data-bone-name="${CSS.escape(bone.name)}"]`);
    if (treeNode) {
        treeNode.classList.add('selected');
        treeNode.scrollIntoView({ block: 'nearest' });
    }

    // Highlight in timeline
    document.querySelectorAll('.track-label').forEach(el => el.classList.remove('selected'));
    const trackLabel = document.querySelector(`.track-label[data-bone-name="${CSS.escape(bone.name)}"]`);
    if (trackLabel) {
        trackLabel.classList.add('selected');
    }
}

function deselectBone() {
    state.selectedBone = null;
    state.transformControls.detach();
    document.getElementById('selected-bone-name').textContent = 'No bone selected';
    document.getElementById('bone-transform-info').innerHTML = '';
    document.querySelectorAll('.bone-node').forEach(el => el.classList.remove('selected'));
    document.querySelectorAll('.track-label').forEach(el => el.classList.remove('selected'));
}

function updateBoneInfoPanel() {
    const bone = state.selectedBone;
    if (!bone) return;

    const p = bone.position;
    const r = new THREE.Euler().setFromQuaternion(bone.quaternion);
    const toDeg = THREE.MathUtils.radToDeg;

    document.getElementById('bone-transform-info').innerHTML = `
        Pos: ${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(3)}<br>
        Rot: ${toDeg(r.x).toFixed(1)}&deg;, ${toDeg(r.y).toFixed(1)}&deg;, ${toDeg(r.z).toFixed(1)}&deg;<br>
        Scl: ${bone.scale.x.toFixed(3)}, ${bone.scale.y.toFixed(3)}, ${bone.scale.z.toFixed(3)}
    `;
}

// ============================================================
// Bone Hierarchy UI
// ============================================================
function buildBoneTree() {
    const container = document.getElementById('bone-tree');
    container.innerHTML = '';

    if (state.bones.length === 0) return;

    // Find root bones
    const rootBones = state.bones.filter(b => !b.parent || !b.parent.isBone);

    rootBones.forEach(bone => {
        container.appendChild(buildBoneNodeElement(bone, 0));
    });
}

function buildBoneNodeElement(bone, depth) {
    const wrapper = document.createElement('div');

    const childBones = bone.children.filter(c => c.isBone);
    const hasChildren = childBones.length > 0;

    // The label row
    const row = document.createElement('div');
    row.className = 'bone-node';
    row.dataset.boneName = bone.name;
    row.style.paddingLeft = (8 + depth * 16) + 'px';

    // Toggle arrow
    const toggle = document.createElement('span');
    toggle.className = 'bone-toggle';
    toggle.textContent = hasChildren ? '\u25BC' : '';
    if (!hasChildren) toggle.style.visibility = 'hidden';
    row.appendChild(toggle);

    // Bone icon
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('class', 'bone-icon');
    icon.setAttribute('viewBox', '0 0 16 16');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M8 2 L10 6 L8 8 L6 6 Z M8 8 L10 10 L8 14 L6 10 Z');
    icon.appendChild(path);
    row.appendChild(icon);

    // Name
    const nameSpan = document.createElement('span');
    nameSpan.textContent = bone.name || '(unnamed)';
    row.appendChild(nameSpan);

    // Click to select
    row.addEventListener('click', (e) => {
        e.stopPropagation();
        selectBone(bone);
    });

    wrapper.appendChild(row);

    // Children container
    if (hasChildren) {
        const childContainer = document.createElement('div');
        childContainer.className = 'bone-children';

        childBones.forEach(child => {
            childContainer.appendChild(buildBoneNodeElement(child, depth + 1));
        });

        wrapper.appendChild(childContainer);

        toggle.addEventListener('click', (e) => {
            e.stopPropagation();
            toggle.classList.toggle('collapsed');
            childContainer.classList.toggle('collapsed');
        });
    }

    return wrapper;
}

// ============================================================
// Toolbar
// ============================================================
function setupToolbar() {
    const btnTranslate = document.getElementById('btn-translate');
    const btnRotate = document.getElementById('btn-rotate');
    const btnScale = document.getElementById('btn-scale');
    const btnLocal = document.getElementById('btn-local');
    const btnWorld = document.getElementById('btn-world');
    const btnBones = document.getElementById('btn-toggle-bones');
    const btnMesh = document.getElementById('btn-toggle-mesh');
    const btnWire = document.getElementById('btn-wireframe');

    function setTransformMode(mode) {
        state.transformMode = mode;
        state.transformControls.setMode(mode);
        btnTranslate.classList.toggle('active', mode === 'translate');
        btnRotate.classList.toggle('active', mode === 'rotate');
        btnScale.classList.toggle('active', mode === 'scale');
    }

    function setTransformSpace(space) {
        state.transformSpace = space;
        state.transformControls.setSpace(space);
        btnLocal.classList.toggle('active', space === 'local');
        btnWorld.classList.toggle('active', space === 'world');
    }

    btnTranslate.addEventListener('click', () => setTransformMode('translate'));
    btnRotate.addEventListener('click', () => setTransformMode('rotate'));
    btnScale.addEventListener('click', () => setTransformMode('scale'));
    btnLocal.addEventListener('click', () => setTransformSpace('local'));
    btnWorld.addEventListener('click', () => setTransformSpace('world'));

    btnBones.addEventListener('click', () => {
        state.showBones = !state.showBones;
        btnBones.classList.toggle('active', state.showBones);
    });

    btnMesh.addEventListener('click', () => {
        state.showMesh = !state.showMesh;
        btnMesh.classList.toggle('active', state.showMesh);
        if (state.model) {
            state.model.traverse(c => {
                if (c.isMesh) c.visible = state.showMesh;
            });
        }
    });

    btnWire.addEventListener('click', () => {
        state.wireframe = !state.wireframe;
        btnWire.classList.toggle('active', state.wireframe);
        if (state.model) {
            state.model.traverse(c => {
                if (c.isMesh && c.material) {
                    const mats = Array.isArray(c.material) ? c.material : [c.material];
                    mats.forEach(m => m.wireframe = state.wireframe);
                }
            });
        }
    });

    // Store setTransformMode for keyboard shortcuts
    window._setTransformMode = setTransformMode;
    window._setTransformSpace = setTransformSpace;
}

// ============================================================
// Keyboard Shortcuts
// ============================================================
function setupKeyboard() {
    window.addEventListener('keydown', (e) => {
        // Don't capture if typing in an input
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

        switch (e.key.toLowerCase()) {
            case 'g':
                window._setTransformMode('translate');
                break;
            case 'r':
                window._setTransformMode('rotate');
                break;
            case 's':
                window._setTransformMode('scale');
                break;
            case 'b':
                document.getElementById('btn-toggle-bones').click();
                break;
            case 'm':
                document.getElementById('btn-toggle-mesh').click();
                break;
            case 'w':
                document.getElementById('btn-wireframe').click();
                break;
            case 'k':
                addKeyframe();
                break;
            case 'delete':
            case 'backspace':
                deleteKeyframe();
                break;
            case ' ':
                e.preventDefault();
                togglePlayback();
                break;
            case 'escape':
                deselectBone();
                break;
            case 'arrowleft':
                e.preventDefault();
                setFrame(Math.max(0, state.currentFrame - 1));
                break;
            case 'arrowright':
                e.preventDefault();
                setFrame(Math.min(state.totalFrames - 1, state.currentFrame + 1));
                break;
        }
    });
}

// ============================================================
// Drag & Drop / File Input
// ============================================================
function setupDragAndDrop() {
    const viewport = document.getElementById('viewport');
    const overlay = document.getElementById('drop-overlay');

    viewport.addEventListener('dragenter', (e) => {
        e.preventDefault();
        overlay.classList.add('visible');
    });

    overlay.addEventListener('dragover', (e) => {
        e.preventDefault();
    });

    overlay.addEventListener('dragleave', (e) => {
        e.preventDefault();
        if (!overlay.contains(e.relatedTarget)) {
            overlay.classList.remove('visible');
        }
    });

    overlay.addEventListener('drop', (e) => {
        e.preventDefault();
        overlay.classList.remove('visible');
        const file = e.dataTransfer.files[0];
        if (file) {
            loadFile(file);
        }
    });

    // Also prevent default on document to avoid browser opening the file
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => e.preventDefault());
}

function setupFileInput() {
    document.getElementById('file-input').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) loadFile(file);
    });
}

function loadFile(file) {
    if (!file.name.toLowerCase().endsWith('.fbx')) {
        alert('Please provide an FBX file.');
        return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
        loadFBX(e.target.result, file.name);
    };
    reader.readAsArrayBuffer(file);
}

// ============================================================
// Animation / Timeline
// ============================================================
function addKeyframe() {
    if (!state.selectedBone) return;
    const bone = state.selectedBone;
    const frame = state.currentFrame;

    if (!state.keyframes.has(bone.name)) {
        state.keyframes.set(bone.name, new Map());
    }

    state.keyframes.get(bone.name).set(frame, {
        position: bone.position.clone(),
        quaternion: bone.quaternion.clone(),
        scale: bone.scale.clone(),
    });

    buildTimelineTracks();
    drawTimeline();
}

function deleteKeyframe() {
    if (!state.selectedBone) return;
    const boneKFs = state.keyframes.get(state.selectedBone.name);
    if (boneKFs) {
        boneKFs.delete(state.currentFrame);
        if (boneKFs.size === 0) state.keyframes.delete(state.selectedBone.name);
    }
    buildTimelineTracks();
    drawTimeline();
}

function clearAllKeyframes() {
    state.keyframes.clear();
    // Reset to rest pose
    state.bones.forEach(bone => {
        const rest = state.restPose.get(bone.name);
        if (rest) {
            bone.position.copy(rest.position);
            bone.quaternion.copy(rest.quaternion);
            bone.scale.copy(rest.scale);
        }
    });
    buildTimelineTracks();
    drawTimeline();
    updateBoneInfoPanel();
}

function setFrame(frame) {
    state.currentFrame = Math.max(0, Math.min(frame, state.totalFrames - 1));
    applyFramePose(state.currentFrame);
    updateFrameDisplay();
    drawTimeline();
    updateBoneInfoPanel();
}

function applyFramePose(frame) {
    state.bones.forEach(bone => {
        const boneKFs = state.keyframes.get(bone.name);
        if (!boneKFs || boneKFs.size === 0) return;

        const rest = state.restPose.get(bone.name);

        // Find surrounding keyframes
        const sortedFrames = Array.from(boneKFs.keys()).sort((a, b) => a - b);

        if (sortedFrames.length === 0) return;

        // Exact match
        if (boneKFs.has(frame)) {
            const kf = boneKFs.get(frame);
            bone.position.copy(kf.position);
            bone.quaternion.copy(kf.quaternion);
            bone.scale.copy(kf.scale);
            return;
        }

        // Find prev and next keyframe
        let prevFrame = null;
        let nextFrame = null;
        for (const f of sortedFrames) {
            if (f <= frame) prevFrame = f;
            if (f > frame && nextFrame === null) nextFrame = f;
        }

        if (prevFrame !== null && nextFrame !== null) {
            // Lerp between keyframes
            const t = (frame - prevFrame) / (nextFrame - prevFrame);
            const prevKF = boneKFs.get(prevFrame);
            const nextKF = boneKFs.get(nextFrame);

            bone.position.lerpVectors(prevKF.position, nextKF.position, t);
            bone.quaternion.slerpQuaternions(prevKF.quaternion, nextKF.quaternion, t);
            bone.scale.lerpVectors(prevKF.scale, nextKF.scale, t);
        } else if (prevFrame !== null) {
            const kf = boneKFs.get(prevFrame);
            bone.position.copy(kf.position);
            bone.quaternion.copy(kf.quaternion);
            bone.scale.copy(kf.scale);
        } else if (nextFrame !== null) {
            // Before first keyframe: lerp from rest to first keyframe
            const kf = boneKFs.get(nextFrame);
            if (rest) {
                const t = frame / nextFrame;
                bone.position.lerpVectors(rest.position, kf.position, t);
                bone.quaternion.slerpQuaternions(rest.quaternion, kf.quaternion, t);
                bone.scale.lerpVectors(rest.scale, kf.scale, t);
            }
        }
    });
}

function togglePlayback() {
    state.isPlaying = !state.isPlaying;
    state._playAccum = 0;
    document.getElementById('btn-play').textContent = state.isPlaying ? '\u23F8' : '\u25B6';
}

function stopPlayback() {
    state.isPlaying = false;
    state._playAccum = 0;
    state.currentFrame = 0;
    applyFramePose(0);
    updateFrameDisplay();
    drawTimeline();
    document.getElementById('btn-play').textContent = '\u25B6';
}

function updateFrameDisplay() {
    document.getElementById('frame-display').textContent =
        `Frame: ${state.currentFrame} / ${state.totalFrames - 1}`;
}

// ============================================================
// Timeline UI
// ============================================================
const TRACK_HEIGHT = 24;
const FRAME_WIDTH = 14;
const HEADER_HEIGHT = 24;

function setupTimeline() {
    // Controls
    document.getElementById('btn-play').addEventListener('click', togglePlayback);
    document.getElementById('btn-stop').addEventListener('click', stopPlayback);
    document.getElementById('btn-prev-frame').addEventListener('click', () => {
        setFrame(Math.max(0, state.currentFrame - 1));
    });
    document.getElementById('btn-next-frame').addEventListener('click', () => {
        setFrame(Math.min(state.totalFrames - 1, state.currentFrame + 1));
    });

    document.getElementById('fps-input').addEventListener('change', (e) => {
        state.fps = Math.max(1, parseInt(e.target.value) || 24);
    });

    document.getElementById('duration-input').addEventListener('change', (e) => {
        state.totalFrames = Math.max(1, parseInt(e.target.value) || 48);
        updateFrameDisplay();
        drawTimeline();
    });

    document.getElementById('btn-add-keyframe').addEventListener('click', addKeyframe);
    document.getElementById('btn-delete-keyframe').addEventListener('click', deleteKeyframe);
    document.getElementById('btn-clear-animation').addEventListener('click', () => {
        if (confirm('Clear all keyframes?')) clearAllKeyframes();
    });
    document.getElementById('btn-export-anim').addEventListener('click', exportAnimation);

    // Timeline canvas click
    const canvas = document.getElementById('timeline-canvas');
    canvas.addEventListener('pointerdown', onTimelineClick);
    canvas.addEventListener('pointermove', onTimelineDrag);
    canvas.addEventListener('pointerup', () => { state._timelineDragging = false; });

    drawTimeline();
}

function onTimelineClick(e) {
    state._timelineDragging = true;
    scrubTimeline(e);
}

function onTimelineDrag(e) {
    if (state._timelineDragging) {
        scrubTimeline(e);
    }
}

function scrubTimeline(e) {
    const canvas = document.getElementById('timeline-canvas');
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const frame = Math.round((x - 2) / FRAME_WIDTH);
    setFrame(Math.max(0, Math.min(state.totalFrames - 1, frame)));
}

function buildTimelineTracks() {
    const container = document.getElementById('timeline-tracks');
    container.innerHTML = '';

    state.bones.forEach(bone => {
        const label = document.createElement('div');
        label.className = 'track-label';
        label.dataset.boneName = bone.name;
        label.textContent = bone.name || '(unnamed)';

        if (state.keyframes.has(bone.name) && state.keyframes.get(bone.name).size > 0) {
            label.classList.add('has-keyframes');
        }
        if (state.selectedBone === bone) {
            label.classList.add('selected');
        }

        label.addEventListener('click', () => selectBone(bone));
        container.appendChild(label);
    });
}

function drawTimeline() {
    const canvas = document.getElementById('timeline-canvas');
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;

    const numTracks = state.bones.length;
    const width = Math.max(600, (state.totalFrames + 1) * FRAME_WIDTH + 4);
    const height = HEADER_HEIGHT + numTracks * TRACK_HEIGHT + 4;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    ctx.scale(dpr, dpr);

    // Background
    ctx.fillStyle = '#0f1a30';
    ctx.fillRect(0, 0, width, height);

    // Header (frame numbers)
    ctx.fillStyle = '#1a2744';
    ctx.fillRect(0, 0, width, HEADER_HEIGHT);

    ctx.fillStyle = '#667';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    for (let f = 0; f <= state.totalFrames; f += 5) {
        const x = 2 + f * FRAME_WIDTH + FRAME_WIDTH / 2;
        ctx.fillText(f.toString(), x, 16);
    }

    // Grid lines
    ctx.strokeStyle = 'rgba(42, 58, 94, 0.3)';
    ctx.lineWidth = 0.5;
    for (let f = 0; f <= state.totalFrames; f++) {
        const x = 2 + f * FRAME_WIDTH + FRAME_WIDTH / 2;
        ctx.beginPath();
        ctx.moveTo(x, HEADER_HEIGHT);
        ctx.lineTo(x, height);
        ctx.stroke();
    }

    // Track rows
    state.bones.forEach((bone, idx) => {
        const y = HEADER_HEIGHT + idx * TRACK_HEIGHT;

        // Alternating row colors
        if (idx % 2 === 0) {
            ctx.fillStyle = 'rgba(15, 26, 48, 0.5)';
            ctx.fillRect(0, y, width, TRACK_HEIGHT);
        }

        // Draw keyframes
        const boneKFs = state.keyframes.get(bone.name);
        if (boneKFs) {
            boneKFs.forEach((_, frame) => {
                const x = 2 + frame * FRAME_WIDTH + FRAME_WIDTH / 2;
                const cy = y + TRACK_HEIGHT / 2;

                // Diamond shape for keyframe
                ctx.fillStyle = (state.selectedBone === bone) ? '#e94560' : '#c73855';
                ctx.beginPath();
                ctx.moveTo(x, cy - 5);
                ctx.lineTo(x + 5, cy);
                ctx.lineTo(x, cy + 5);
                ctx.lineTo(x - 5, cy);
                ctx.closePath();
                ctx.fill();
            });
        }
    });

    // Playhead
    const phx = 2 + state.currentFrame * FRAME_WIDTH + FRAME_WIDTH / 2;
    ctx.strokeStyle = '#e94560';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(phx, 0);
    ctx.lineTo(phx, height);
    ctx.stroke();

    // Playhead triangle
    ctx.fillStyle = '#e94560';
    ctx.beginPath();
    ctx.moveTo(phx - 6, 0);
    ctx.lineTo(phx + 6, 0);
    ctx.lineTo(phx, 8);
    ctx.closePath();
    ctx.fill();
}

// ============================================================
// Export Animation
// ============================================================
function exportAnimation() {
    if (state.keyframes.size === 0) {
        alert('No keyframes to export.');
        return;
    }

    const data = {
        fps: state.fps,
        totalFrames: state.totalFrames,
        bones: {},
    };

    state.keyframes.forEach((frames, boneName) => {
        const boneData = {};
        frames.forEach((kf, frame) => {
            boneData[frame] = {
                position: [kf.position.x, kf.position.y, kf.position.z],
                quaternion: [kf.quaternion.x, kf.quaternion.y, kf.quaternion.z, kf.quaternion.w],
                scale: [kf.scale.x, kf.scale.y, kf.scale.z],
            };
        });
        data.bones[boneName] = boneData;
    });

    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'animation.json';
    a.click();
    URL.revokeObjectURL(url);
}

// ============================================================
// Boot
// ============================================================
init();
