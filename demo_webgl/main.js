import * as THREE from 'three';

import { GUI } from 'three/examples/jsm/libs/lil-gui.module.min.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import Stats from 'three/examples/jsm/libs/stats.module'

const passthroughVS = /* glsl */`
varying vec2 vUv;

void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`;

const MaskShader = {
    uniforms: {
        'tOriginal': { value: null },
        'threshold': { value: 0.5 },
    },
    vertexShader: passthroughVS,
    fragmentShader: /* glsl */`
		uniform sampler2D tOriginal;
        uniform float threshold;

		varying vec2 vUv;

		void main() {
            vec3 inpColor = texture2D( tOriginal, vUv ).xyz;
			gl_FragColor = vec4(vec3(clamp((inpColor.x - threshold)*140.0, 0.0, 1.0)), 1.0);
		}`
};

const CopyShader = {
    uniforms: {
        'tOriginal': { value: null },
    },
    vertexShader: passthroughVS,
    fragmentShader: /* glsl */`
		uniform sampler2D tOriginal;

		varying vec2 vUv;

		void main() {
            vec2 uv = vUv;
            vec3 inpColor = texture2D( tOriginal, uv ).xyz;
			gl_FragColor = vec4(inpColor, 1.0);
		}`
};



const FinalCombinePassShader = {
    uniforms: {
        't0': { value: null },
        't1': { value: null },

        'm0': { value: null },
        'm1': { value: null },
        'm2': { value: null },
        'm3': { value: null },
        'm4': { value: null },
        'm5': { value: null },
        'm6': { value: null },
        'm7': { value: null },

        'enable': { value: 0.5 },
        'zoom': { value: 2.0 },
        'mip': { value: 6.0 },
        'aspectRatio' : { value: 1.0 },
    },
    vertexShader: passthroughVS,
    fragmentShader: /* glsl */`
        uniform sampler2D t0;
        uniform sampler2D t1;

        uniform sampler2D m0;
        uniform sampler2D m1;
        uniform sampler2D m2;
        uniform sampler2D m3;
        uniform sampler2D m4;
        uniform sampler2D m5;
        uniform sampler2D m6;
        uniform sampler2D m7;

        uniform float enable;
        uniform float zoom;
        uniform int mip;

        uniform float aspectRatio;

        varying vec2 vUv;

		void main() {
            vec2 uv = vUv / vec2(zoom);
            uv.x *= aspectRatio;

            vec4 accum = vec4(0.0);
            

            #define LVL_CNT 6
            vec4 mips0[LVL_CNT+1], mips1[LVL_CNT+1], mm[8];
            
            #pragma unroll
            for (int i = 0; i < LVL_CNT + 1; i += 1) {
                mips0[i] = texture2D(t0, uv, float(i));
                mips1[i] = texture2D(t1, uv, float(i));
            }
            
            mm[0] = texture2D(m0, uv);
            mm[1] = texture2D(m1, uv);
            mm[2] = texture2D(m2, uv);
            mm[3] = texture2D(m3, uv);
            mm[4] = texture2D(m4, uv);
            mm[5] = texture2D(m5, uv);
            mm[6] = texture2D(m6, uv);
            mm[7] = texture2D(m7, uv);
            
            for (int i = 0; i < int(mip); i += 1) {
                vec4 l0 = mips0[i] - mips0[i+1];
                vec4 l1 = mips1[i] - mips1[i+1];
                accum += l0 * mm[i+1] + l1 * (vec4(1.0)-mm[i+1]);
            }
            accum += mips0[mip] * mm[mip+1] + mips1[mip] * (vec4(1.0)-mm[mip+1]);

            if (enable < 1.0) {
                vec4 m = mm[mip+1];
                vec4 basicBlend = texture2D(t0, uv) * m + texture2D(t1, uv) * (vec4(1.0)-m);                
                accum = basicBlend;
            }
			gl_FragColor = accum;
		}`
};


const params = {
    enable: true,
    threshold: 0.6,
    zoom: 2.5,
    mip: 5.0,
    tex0: 1,
    tex1: 3,
    save: saveAsImage,
};

let renderer, effectCopy, effectFinalCombine, effectMask, mips, textures, aspectRatio;

const stats = Stats()
document.body.appendChild(stats.dom)

init();

function init() {
    aspectRatio = window.innerWidth / window.innerHeight;
    renderer = new THREE.WebGLRenderer();
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);
    renderer.toneMapping = THREE.LinearToneMapping;
    renderer.outputEncoding = THREE.LinearEncoding;

    let loaded = 0;
    mips = new Object();
    textures = new Object();
    let loadData = function (tex, name) {
        const material = new THREE.MeshBasicMaterial({ map: tex });
        if (name == "mask") {
            let w = tex.image.width;
            let h = tex.image.height;

            let sharedProps = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat, type: THREE.UnsignedByteType };

            let mips_l = []
            while (w > 1 && h > 1) {
                mips_l.push(new THREE.WebGLRenderTarget(w, h, sharedProps));
                w = w / 2;
                h = h / 2;
            }

            mips[name] = mips_l;
        }

        textures[name] = tex;

        loaded += 1;
        if (loaded == 7)
            render();
    }

    new THREE.TextureLoader().load("1.jpg", function ( texture ) {loadData(texture, "0")});
    new THREE.TextureLoader().load("2.jpg", function ( texture ) {loadData(texture, "1")});
    new THREE.TextureLoader().load("1rot.jpg", function ( texture ) {loadData(texture, "2")});
    new THREE.TextureLoader().load("2rot.jpg", function ( texture ) {loadData(texture, "3")});    
    new THREE.TextureLoader().load("normal0.jpg", function ( texture ) {loadData(texture, "4")});
    new THREE.TextureLoader().load("normal1.jpg", function ( texture ) {loadData(texture, "5")});
    new THREE.TextureLoader().load("perlin.jpg", function ( texture ) {loadData(texture, "mask")});

    effectCopy = new ShaderPass(CopyShader);
    effectFinalCombine = new ShaderPass(FinalCombinePassShader);
    effectMask = new ShaderPass(MaskShader, null);

    const gui = new GUI();

    gui.add(params, 'enable');
    gui.add(params, 'threshold', 0.0, 1.0);
    gui.add(params, 'zoom', 1.0, 4.0);
    gui.add(params, 'mip', 0, 6, 1.0);
    gui.add(params, 'tex0', { Texture0: 0, Texture1: 1, Texture0Rotated: 2, Texture1Rotated: 3, Normal0: 4, Normal1: 5});
    gui.add(params, 'tex1', { Texture0: 0, Texture1: 1, Texture0Rotated: 2, Texture1Rotated: 3, Normal0: 4, Normal1: 5});
    gui.add(params, 'save');

    gui.open();
}

window.addEventListener('resize', onWindowResize, false);

function saveAsImage() {
    render();
    var imgData;
    var strDownloadMime = "image/octet-stream";
    var strMime = "image/jpeg";
    imgData = renderer.domElement.toDataURL(strMime);
    imgData = imgData.replace(strMime, strDownloadMime);
    var link = document.createElement('a');
    if (typeof link.download === 'string') {
        document.body.appendChild(link);
        link.download = 'snapshot.jpg';
        link.href = imgData;
        link.click();
        document.body.removeChild(link); //remove the link when done
    } else {
        location.replace(uri);
    }
}

function onWindowResize() {
    aspectRatio = window.innerWidth / window.innerHeight;
    renderer.setSize(window.innerWidth, window.innerHeight);
    render();
}

function render() {
    effectMask.uniforms['threshold'].value = params.threshold;
    effectMask.uniforms['tOriginal'].value = textures["mask"];
    effectMask.render(renderer, mips["mask"][0]);

    for (let i = 0; i < 7; i++) {
        effectCopy.uniforms['tOriginal'].value = mips["mask"][i].texture;
        effectCopy.render(renderer, mips["mask"][i + 1]);
    }

    effectFinalCombine.renderToScreen = true;
    for (let i = 0; i < 8; i++) { 
        effectFinalCombine.uniforms['m'+i].value = mips["mask"][i].texture;
    }
    effectFinalCombine.uniforms['mip'].value = params.mip;
    effectFinalCombine.uniforms['t0'].value = textures[params.tex0];
    effectFinalCombine.uniforms['t1'].value = textures[params.tex1];
    effectFinalCombine.uniforms['enable'].value = params.enable;
    effectFinalCombine.uniforms['zoom'].value = params.zoom;
    effectFinalCombine.uniforms['aspectRatio'].value = aspectRatio;
    effectFinalCombine.render(renderer, null);

    requestAnimationFrame(render);
    stats.update();
}
