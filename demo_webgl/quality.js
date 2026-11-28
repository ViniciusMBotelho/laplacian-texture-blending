/** The same RGBA terrain capture supplies both PSNR and the SSIM PNG. */
export function computeTerrainPsnr(candidate, reference) {
    if (candidate.length !== reference.length || candidate.length % 4) throw new Error('RGBA shape mismatch');
    let squaredError = 0, samples = 0;
    for (let i = 0; i < reference.length; i += 4) {
        if ((candidate[i + 3] >= 128) !== (reference[i + 3] >= 128)) throw new Error('Terrain masks differ');
        if (reference[i + 3] < 128) continue;
        for (let channel = 0; channel < 3; channel++) squaredError += ((candidate[i + channel] - reference[i + channel]) / 255) ** 2;
        samples += 3;
    }
    if (!samples) throw new Error('No valid terrain pixels');
    return squaredError === 0 ? Infinity : 10 * Math.log10(samples / squaredError);
}

export function terrainPng(bytes, width, height) {
    if (bytes.length !== width * height * 4) throw new Error('Capture dimensions mismatch');
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    const output = ctx.createImageData(width, height);
    for (let y = 0; y < height; y++) {
        output.data.set(bytes.subarray((height - 1 - y) * width * 4, (height - y) * width * 4), y * width * 4);
    }
    ctx.putImageData(output, 0, 0);
    return canvas.toDataURL('image/png');
}
