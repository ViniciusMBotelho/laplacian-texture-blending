import * as THREE from 'three';

export const TERRAIN_SIZE = 400.0;
export const TERRAIN_SEGMENTS = 256;
export const TILE_SIZE = 10.0;
export const TEX_RES = 1024.0;
export const TERRAIN_BOUNDS = 170.0;

/**
 * Deterministically evaluates terrain height at world (x, z).
 * Matches src/benchmark_3d.py bit-for-bit in structure.
 */
export function terrainHeight(x, z) {
    return (
        2.8 * Math.sin(x * 0.045) * Math.cos(z * 0.045) +
        4.5 * Math.sin(x * 0.018 + z * 0.015) +
        1.1 * Math.cos(x * 0.11 - z * 0.09) +
        0.35 * Math.sin(x * 0.24 + z * 0.21)
    );
}

/**
 * Analytical surface normal from partial derivatives of terrainHeight(x, z).
 */
export function terrainNormal(x, z, target = new THREE.Vector3()) {
    const dhdx =
        2.8 * 0.045 * Math.cos(x * 0.045) * Math.cos(z * 0.045) +
        4.5 * 0.018 * Math.cos(x * 0.018 + z * 0.015) -
        1.1 * 0.11 * Math.sin(x * 0.11 - z * 0.09) +
        0.35 * 0.24 * Math.cos(x * 0.24 + z * 0.21);

    const dhdz =
        -2.8 * 0.045 * Math.sin(x * 0.045) * Math.sin(z * 0.045) +
        4.5 * 0.015 * Math.cos(x * 0.018 + z * 0.015) +
        1.1 * 0.09 * Math.sin(x * 0.11 - z * 0.09) +
        0.35 * 0.21 * Math.cos(x * 0.24 + z * 0.21);

    return target.set(-dhdx, 1.0, -dhdz).normalize();
}

/**
 * Builds the 400x400m terrain mesh in world XZ with analytical normals and uniform [0,1] UVs.
 */
export function createTerrainGeometry() {
    const geo = new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, TERRAIN_SEGMENTS, TERRAIN_SEGMENTS);
    geo.rotateX(-Math.PI / 2);

    const pos = geo.attributes.position;
    const norm = geo.attributes.normal;
    const uv = geo.attributes.uv;
    const tmpN = new THREE.Vector3();

    for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const z = pos.getZ(i);
        const y = terrainHeight(x, z);
        pos.setY(i, y);

        terrainNormal(x, z, tmpN);
        norm.setXYZ(i, tmpN.x, tmpN.y, tmpN.z);

        uv.setXY(
            i,
            (x + TERRAIN_SIZE * 0.5) / TERRAIN_SIZE,
            (z + TERRAIN_SIZE * 0.5) / TERRAIN_SIZE
        );
    }

    pos.needsUpdate = true;
    norm.needsUpdate = true;
    uv.needsUpdate = true;
    geo.computeBoundingSphere();
    return geo;
}

/**
 * Atmospheric sky dome matched to the terrain fog color at the horizon.
 */
export function createSkyDome(sunDir = new THREE.Vector3(0.45, 0.72, 0.52).normalize()) {
    const geo = new THREE.SphereGeometry(650, 32, 16);
    const mat = new THREE.ShaderMaterial({
        uniforms: {
            topColor: { value: new THREE.Color(0x1b3356) },
            horizonColor: { value: new THREE.Color(0x9bb4cc) },
            sunDir: { value: sunDir.clone() },
        },
        vertexShader: /* glsl */ `
            varying vec3 vWorldDir;
            void main() {
                vec4 wp = modelMatrix * vec4(position, 1.0);
                vWorldDir = position;
                gl_Position = projectionMatrix * viewMatrix * wp;
            }
        `,
        fragmentShader: /* glsl */ `
            uniform vec3 topColor;
            uniform vec3 horizonColor;
            uniform vec3 sunDir;
            varying vec3 vWorldDir;
            void main() {
                vec3 dir = normalize(vWorldDir);
                float h = clamp(dir.y, 0.0, 1.0);
                vec3 sky = mix(horizonColor, topColor, pow(h, 0.55));
                float sunGlow = pow(max(dot(dir, normalize(sunDir)), 0.0), 48.0);
                sky += vec3(1.0, 0.93, 0.80) * sunGlow * 0.35;
                gl_FragColor = vec4(sky, 1.0);
            }
        `,
        side: THREE.BackSide,
        depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = -10;
    return mesh;
}

function drawImageData(img, size, rotate90) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (rotate90) {
        ctx.translate(size * 0.5, size * 0.5);
        ctx.rotate(Math.PI * 0.5);
        ctx.drawImage(img, -size * 0.5, -size * 0.5, size, size);
    } else {
        ctx.drawImage(img, 0, 0, size, size);
    }
    return ctx.getImageData(0, 0, size, size);
}

function configureSurfaceTexture(tex, maxAniso) {
    tex.wrapS = THREE.MirroredRepeatWrapping;
    tex.wrapT = THREE.MirroredRepeatWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = maxAniso;
    tex.needsUpdate = true;
    return tex;
}

/**
 * Packs tangent-space normal map (RGB) + synthetic deterministic roughness (A)
 * derived from the corresponding albedo texture.
 */
export function createPackedNormalRoughness(
    normalImg,
    albedoImg,
    roughMin = 0.35,
    roughMax = 0.88,
    rotate90 = false,
    maxAniso = 8
) {
    const size = normalImg.width || 512;
    const normData = drawImageData(normalImg, size, rotate90);
    const albData = drawImageData(albedoImg, size, rotate90);

    const outCanvas = document.createElement('canvas');
    outCanvas.width = size;
    outCanvas.height = size;
    const outCtx = outCanvas.getContext('2d');
    const outImg = outCtx.createImageData(size, size);

    const nPx = normData.data;
    const aPx = albData.data;
    const oPx = outImg.data;

    for (let i = 0; i < nPx.length; i += 4) {
        let nx = (nPx[i] / 255.0) * 2.0 - 1.0;
        let ny = (nPx[i + 1] / 255.0) * 2.0 - 1.0;
        const nz = (nPx[i + 2] / 255.0) * 2.0 - 1.0;

        if (rotate90) {
            const rx = ny;
            const ry = -nx;
            nx = rx;
            ny = ry;
        }

        const len = Math.hypot(nx, ny, nz) || 1.0;
        oPx[i] = Math.round(((nx / len) * 0.5 + 0.5) * 255.0);
        oPx[i + 1] = Math.round(((ny / len) * 0.5 + 0.5) * 255.0);
        oPx[i + 2] = Math.round(((nz / len) * 0.5 + 0.5) * 255.0);

        const luma = (0.2989 * aPx[i] + 0.5870 * aPx[i + 1] + 0.1140 * aPx[i + 2]) / 255.0;
        const rough = roughMin + (roughMax - roughMin) * (1.0 - 0.65 * luma);
        oPx[i + 3] = Math.max(0, Math.min(255, Math.round(rough * 255.0)));
    }

    outCtx.putImageData(outImg, 0, 0);
    const tex = new THREE.CanvasTexture(outCanvas);
    return configureSurfaceTexture(tex, maxAniso);
}

/**
 * Generates deterministic 3rd terrain layer albedo (alpine granite/slate) from 1rot.jpg.
 */
export function createLayer3Albedo(img1rot, maxAniso = 8) {
    const size = img1rot.width || 1024;
    const src = drawImageData(img1rot, size, false);

    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const dst = ctx.createImageData(size, size);

    const s = src.data;
    const d = dst.data;
    for (let i = 0; i < s.length; i += 4) {
        d[i] = Math.min(255, Math.round(s[i] * 1.08 + 14));
        d[i + 1] = Math.min(255, Math.round(s[i + 1] * 1.10 + 18));
        d[i + 2] = Math.min(255, Math.round(s[i + 2] * 1.18 + 26));
        d[i + 3] = 255;
    }
    ctx.putImageData(dst, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    return configureSurfaceTexture(tex, maxAniso);
}

/**
 * Builds an articulated stylized explorer avatar for 3rd-person terrain walk-throughs.
 */
export function createAvatar() {
    const root = new THREE.Group();

    const suitMat = new THREE.MeshStandardMaterial({ color: 0x2563eb, roughness: 0.55, metalness: 0.1 });
    const accentMat = new THREE.MeshStandardMaterial({ color: 0xf59e0b, roughness: 0.4, metalness: 0.2 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.7 });
    const visorMat = new THREE.MeshStandardMaterial({
        color: 0x38bdf8,
        emissive: 0x0ea5e9,
        emissiveIntensity: 0.85,
        roughness: 0.2,
    });

    const shadowGeo = new THREE.CircleGeometry(0.55, 24);
    shadowGeo.rotateX(-Math.PI / 2);
    const shadowMat = new THREE.MeshBasicMaterial({
        color: 0x000000,
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
    });
    const shadow = new THREE.Mesh(shadowGeo, shadowMat);
    shadow.position.y = 0.04;
    root.add(shadow);

    const bodyGroup = new THREE.Group();
    root.add(bodyGroup);

    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.72, 0.34), suitMat);
    torso.position.y = 1.08;
    bodyGroup.add(torso);

    const backpack = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.52, 0.22), accentMat);
    backpack.position.set(0, 1.08, -0.25);
    bodyGroup.add(backpack);

    const head = new THREE.Mesh(new THREE.BoxGeometry(0.40, 0.38, 0.38), darkMat);
    head.position.y = 1.68;
    bodyGroup.add(head);

    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.14, 0.06), visorMat);
    visor.position.set(0, 1.70, 0.19);
    bodyGroup.add(visor);

    const leftLeg = new THREE.Group();
    leftLeg.position.set(-0.15, 0.72, 0);
    const legMeshL = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.72, 0.22), darkMat);
    legMeshL.position.y = -0.36;
    leftLeg.add(legMeshL);
    bodyGroup.add(leftLeg);

    const rightLeg = new THREE.Group();
    rightLeg.position.set(0.15, 0.72, 0);
    const legMeshR = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.72, 0.22), darkMat);
    legMeshR.position.y = -0.36;
    rightLeg.add(legMeshR);
    bodyGroup.add(rightLeg);

    const leftArm = new THREE.Group();
    leftArm.position.set(-0.40, 1.38, 0);
    const armMeshL = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.62, 0.18), suitMat);
    armMeshL.position.y = -0.28;
    leftArm.add(armMeshL);
    bodyGroup.add(leftArm);

    const rightArm = new THREE.Group();
    rightArm.position.set(0.40, 1.38, 0);
    const armMeshR = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.62, 0.18), suitMat);
    armMeshR.position.y = -0.28;
    rightArm.add(armMeshR);
    bodyGroup.add(rightArm);

    root.userData = { bodyGroup, leftLeg, rightLeg, leftArm, rightArm, head };
    return root;
}

/**
 * Keyboard-driven 3rd-person avatar controller locked to terrainHeight(x, z).
 */
export class AvatarController {
    constructor(avatarMesh, startX = 12.0, startZ = 14.0) {
        this.mesh = avatarMesh;
        this.position = new THREE.Vector3(startX, terrainHeight(startX, startZ), startZ);
        this.yaw = Math.PI;
        this.walkPhase = 0.0;
        this.keys = new Set();
        this.mesh.position.copy(this.position);
        this.mesh.rotation.y = this.yaw;

        this._onKeyDown = (e) => {
            if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight'].includes(e.code)) {
                this.keys.add(e.code);
            }
        };
        this._onKeyUp = (e) => {
            this.keys.delete(e.code);
        };
        window.addEventListener('keydown', this._onKeyDown);
        window.addEventListener('keyup', this._onKeyUp);
    }

    update(dt, cameraYaw) {
        const clampedDt = Math.min(dt, 0.05);
        let fwd = 0;
        let strafe = 0;
        if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) fwd += 1;
        if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) fwd -= 1;
        if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) strafe += 1;
        if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) strafe -= 1;

        const moving = fwd !== 0 || strafe !== 0;
        if (moving) {
            const sprint = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
            const speed = sprint ? 16.0 : 8.5;

            const forwardX = -Math.sin(cameraYaw);
            const forwardZ = -Math.cos(cameraYaw);
            const rightX = Math.cos(cameraYaw);
            const rightZ = -Math.sin(cameraYaw);

            let dx = forwardX * fwd + rightX * strafe;
            let dz = forwardZ * fwd + rightZ * strafe;
            const len = Math.hypot(dx, dz) || 1.0;
            dx /= len;
            dz /= len;

            this.position.x = Math.max(-TERRAIN_BOUNDS, Math.min(TERRAIN_BOUNDS, this.position.x + dx * speed * clampedDt));
            this.position.z = Math.max(-TERRAIN_BOUNDS, Math.min(TERRAIN_BOUNDS, this.position.z + dz * speed * clampedDt));

            const targetYaw = Math.atan2(dx, dz);
            let diff = targetYaw - this.yaw;
            while (diff > Math.PI) diff -= Math.PI * 2;
            while (diff < -Math.PI) diff += Math.PI * 2;
            this.yaw += diff * Math.min(1.0, clampedDt * 12.0);

            this.walkPhase += clampedDt * (sprint ? 14.0 : 9.0);
        } else {
            this.walkPhase *= 0.85;
        }

        this.position.y = terrainHeight(this.position.x, this.position.z);
        this.mesh.position.copy(this.position);
        this.mesh.rotation.y = this.yaw;

        const { leftLeg, rightLeg, leftArm, rightArm, bodyGroup } = this.mesh.userData;
        const swing = moving ? Math.sin(this.walkPhase) * 0.55 : 0.0;
        leftLeg.rotation.x = swing;
        rightLeg.rotation.x = -swing;
        leftArm.rotation.x = -swing * 0.75;
        rightArm.rotation.x = swing * 0.75;
        bodyGroup.position.y = moving ? Math.abs(Math.cos(this.walkPhase)) * 0.06 : 0.0;

        return moving;
    }

    dispose() {
        window.removeEventListener('keydown', this._onKeyDown);
        window.removeEventListener('keyup', this._onKeyUp);
    }
}
