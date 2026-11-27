import { build } from 'esbuild';
import { chromium } from 'playwright';
import { modelIO } from './model';

let script: Promise<string> | undefined;
function rendererScript() {
    script ??= build({
        stdin: {
            resolveDir: process.cwd(),
            contents: `
        import * as THREE from 'three';
        import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
        window.renderModel = async (bytes) => {
            const gltf = await new GLTFLoader().parseAsync(new Uint8Array(bytes).buffer, '');
            const scene = new THREE.Scene(); scene.background = new THREE.Color('white');
            const model = gltf.scene; model.updateMatrixWorld(true);
            const bounds = new THREE.Box3().setFromObject(model), center = bounds.getCenter(new THREE.Vector3());
            const radius = bounds.getSize(new THREE.Vector3()).length() / 2;
            if (!Number.isFinite(radius) || radius <= 0) throw new Error('Mô hình không có hình học hiển thị.');
            model.position.sub(center); scene.add(model, new THREE.HemisphereLight(0xffffff, 0x777777, 2));
            const light = new THREE.DirectionalLight(0xffffff, 3); light.position.set(2, 4, 3); scene.add(light);
            const camera = new THREE.PerspectiveCamera(40, 1, radius / 100, radius * 100);
            camera.position.copy(new THREE.Vector3(1, .6, 1.5).normalize().multiplyScalar(radius / Math.sin(Math.PI / 9) * 1.15));
            camera.lookAt(0, 0, 0);
            const renderer = new THREE.WebGLRenderer({ canvas: document.querySelector('canvas'), antialias: true, preserveDrawingBuffer: true });
            renderer.setSize(320, 320); renderer.outputColorSpace = THREE.SRGBColorSpace;
            await new Promise(requestAnimationFrame); renderer.render(scene, camera);
        };`,
        },
        bundle: true,
        write: false,
        platform: 'browser',
        format: 'iife',
        minify: true,
    }).then((result) => {
        const output = result.outputFiles[0];
        if (!output) throw new Error('Thiếu mã renderer.');
        return output.text;
    });
    return script;
}
export async function modelThumbnail(input: Uint8Array, signal: AbortSignal) {
    signal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    const io = await modelIO(),
        document = await io.readBinary(input);
    // Decode compressed extensions before rendering so the browser needs no network decoders.
    for (const extension of document.getRoot().listExtensionsUsed()) extension.dispose();
    const bytes = await io.writeBinary(document);
    signal.throwIfAborted();
    const browser = await chromium.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--use-angle=swiftshader',
            '--enable-unsafe-swiftshader',
        ],
    });
    const abort = () => {
        void browser.close();
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
        signal.throwIfAborted();
        const page = await browser.newPage({
            viewport: { width: 320, height: 320 },
            deviceScaleFactor: 1,
        });
        await page.route('**/*', (route) => route.abort());
        await page.setContent('<canvas width="320" height="320"></canvas>');
        await page.addScriptTag({ content: await rendererScript() });
        await page.evaluate(async (data) => {
            await (
                globalThis as unknown as { renderModel: (data: number[]) => Promise<void> }
            ).renderModel(data);
        }, Array.from(bytes));
        signal.throwIfAborted();
        return await page.screenshot({ type: 'jpeg', quality: 85, timeout: 30_000 });
    } finally {
        signal.removeEventListener('abort', abort);
        await browser.close();
    }
}
