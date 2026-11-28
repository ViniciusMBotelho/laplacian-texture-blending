import { terrainHeight } from './terrain.js';

export const CAMERA_PRESETS = {
    overview: {
        label: 'Panorâmica (3 Zonas)',
        pos: [0.0, terrainHeight(0.0, 60.0) + 14.0, 60.0],
        target: [0.0, terrainHeight(0.0, -60.0) + 1.0, -60.0],
        fov: 50,
    },
    grazing: {
        label: 'Ângulo Rasante (Anisotropia)',
        pos: [-20.0, terrainHeight(-20.0, 75.0) + 2.6, 75.0],
        target: [10.0, terrainHeight(10.0, -80.0) + 2.0, -80.0],
        fov: 50,
    },
    closeup: {
        label: 'Close-Up (Detalhes PBR)',
        pos: [12.0, terrainHeight(12.0, 18.0) + 3.8, 18.0],
        target: [12.0, terrainHeight(12.0, 8.0) + 0.2, 8.0],
        fov: 50,
    },
    aerial: {
        label: 'Vista Aérea (Macro)',
        pos: [-55.0, terrainHeight(-55.0, 85.0) + 48.0, 85.0],
        target: [15.0, terrainHeight(15.0, -25.0), -25.0],
        fov: 50,
    },
};

/**
 * Applies a fixed reproducible camera pose and synchronizes OrbitControls.
 */
export function applyCameraPreset(camera, controls, presetKey) {
    const preset = CAMERA_PRESETS[presetKey] || CAMERA_PRESETS.overview;
    if (camera.fov !== preset.fov) {
        camera.fov = preset.fov;
        camera.updateProjectionMatrix();
    }
    camera.position.set(preset.pos[0], preset.pos[1], preset.pos[2]);
    if (controls) {
        controls.target.set(preset.target[0], preset.target[1], preset.target[2]);
        controls.update();
    } else {
        camera.lookAt(preset.target[0], preset.target[1], preset.target[2]);
    }
}

/**
 * Positions camera behind/above the avatar while preventing ground clipping.
 */
export function updateThirdPersonCamera(camera, avatarPos, yaw, pitch, distance) {
    const cosPitch = Math.cos(pitch);
    const offsetX = Math.sin(yaw) * cosPitch * distance;
    const offsetZ = Math.cos(yaw) * cosPitch * distance;
    const offsetY = Math.sin(pitch) * distance + 1.8;

    const camX = avatarPos.x + offsetX;
    const camZ = avatarPos.z + offsetZ;
    const minGroundY = terrainHeight(camX, camZ) + 1.1;
    const camY = Math.max(minGroundY, avatarPos.y + offsetY);

    camera.position.set(camX, camY, camZ);
    camera.lookAt(avatarPos.x, avatarPos.y + 1.35, avatarPos.z);
}
