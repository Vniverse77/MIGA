// The 3D MIGA mark on the landing page. Loaded only on the landing route, through a dynamic import,
// so none of this (nor three.js) is part of the app bundle. Everything is bundled locally.
import {
	AmbientLight,
	BufferGeometry,
	CylinderGeometry,
	DirectionalLight,
	DoubleSide,
	ExtrudeGeometry,
	Float32BufferAttribute,
	Group,
	IcosahedronGeometry,
	Line,
	LineBasicMaterial,
	MathUtils,
	Mesh,
	MeshStandardMaterial,
	OctahedronGeometry,
	PerspectiveCamera,
	Scene,
	Shape,
	TorusGeometry,
	Vector3,
	WebGLRenderer,
	Box3
} from 'three';
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js';
import { ICON_SVG } from './icon-svg';

const BG = 0x070b14;
const PANEL = 0x0d1525;
const PRIMARY = 0x1a6bbf;
const SECONDARY = 0x378add;
const TEXT = 0xe8f0fe;

export type SceneHandle = { destroy(): void };

type Key = { x: number; y: number; s: number; ry: number; rx: number; rz: number; o: number };

// One keyframe per landing section, in page order: hero, why, download, start, features, how, faq, end.
// x and y are screen positions (-1..1), s the size as a fraction of the window height, r* are radians.
const DESKTOP: Key[] = [
	{ x: 0.5, y: 0.0, s: 0.56, ry: -0.3, rx: 0.06, rz: 0, o: 1 },
	{ x: 0.55, y: 0.0, s: 0.48, ry: Math.PI * 0.75, rx: -0.1, rz: 0.05, o: 1 },
	{ x: -0.55, y: 0.0, s: 0.46, ry: Math.PI * 1.3, rx: 0.14, rz: -0.06, o: 1 },
	{ x: 0.88, y: 0.8, s: 0.13, ry: Math.PI * 1.9, rx: -0.08, rz: 0.04, o: 0.6 },
	{ x: 0.82, y: 0.78, s: 0.13, ry: Math.PI * 2.4, rx: 0, rz: 0, o: 0.5 },
	{ x: 0, y: 0, s: 0.0, ry: Math.PI * 3, rx: 0, rz: 0, o: 1 },
	{ x: -0.6, y: -0.05, s: 0.38, ry: Math.PI * 3.5, rx: 0.1, rz: -0.04, o: 1 },
	{ x: 0.5, y: 0.0, s: 0.52, ry: Math.PI * 4, rx: 0, rz: 0, o: 1 }
];
const MOBILE: Key[] = [
	{ x: 0, y: 0.5, s: 0.3, ry: -0.35, rx: 0.08, rz: 0, o: 1 },
	{ x: 0.78, y: -0.82, s: 0.09, ry: Math.PI * 0.75, rx: -0.1, rz: 0, o: 0.5 },
	{ x: 0.78, y: -0.82, s: 0.09, ry: Math.PI * 1.3, rx: 0.14, rz: 0, o: 0.5 },
	{ x: 0.78, y: -0.82, s: 0.09, ry: Math.PI * 1.9, rx: -0.08, rz: 0, o: 0.5 },
	{ x: 0.78, y: -0.82, s: 0.09, ry: Math.PI * 2.4, rx: 0, rz: 0, o: 0.5 },
	{ x: 0, y: 0, s: 0, ry: Math.PI * 3, rx: 0, rz: 0, o: 1 },
	{ x: 0.78, y: -0.82, s: 0.09, ry: Math.PI * 3.5, rx: 0.1, rz: 0, o: 0.5 },
	{ x: 0.78, y: -0.82, s: 0.09, ry: Math.PI * 4, rx: 0, rz: 0, o: 0.5 }
];

const CAM_Z = 6;
const FOV = 30;
const HALF_H = Math.tan(MathUtils.degToRad(FOV / 2)) * CAM_Z;

const smooth = (t: number) => t * t * (3 - 2 * t);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function roundedRect(w: number, h: number, r: number): Shape {
	const s = new Shape();
	const x = -w / 2;
	const y = -h / 2;
	s.moveTo(x + r, y);
	s.lineTo(x + w - r, y);
	s.quadraticCurveTo(x + w, y, x + w, y + r);
	s.lineTo(x + w, y + h - r);
	s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
	s.lineTo(x + r, y + h);
	s.quadraticCurveTo(x, y + h, x, y + h - r);
	s.lineTo(x, y + r);
	s.quadraticCurveTo(x, y, x + r, y);
	return s;
}

function frameShape(w: number, h: number, r: number, inset: number): Shape {
	const outer = roundedRect(w, h, r);
	outer.holes.push(roundedRect(w - inset * 2, h - inset * 2, Math.max(r - inset, 0.001)));
	return outer;
}

/** The MIGA mark: a dark rounded tile with a blue rim and the extruded head-and-shoulders silhouette. */
function buildIcon(): Group {
	const group = new Group();
	const data = new SVGLoader().parse(ICON_SVG);
	const shapes = data.paths.flatMap((p) => p.toShapes());
	const bust = new Group();
	const bustMat = new MeshStandardMaterial({ color: TEXT, roughness: 0.38, metalness: 0.12 });
	for (const [i, shape] of shapes.entries()) {
		// Overlapping parts get a hair more depth each, so their front faces never fight for the same pixels.
		const g = new ExtrudeGeometry(shape, {
			depth: 36 + i * 2.5,
			bevelEnabled: true,
			bevelThickness: 7,
			bevelSize: 5,
			bevelSegments: 2,
			curveSegments: 14
		});
		bust.add(new Mesh(g, bustMat));
	}
	const box = new Box3().setFromObject(bust);
	const size = box.getSize(new Vector3());
	const k = 1 / (Math.max(size.x, size.y) * 1.2); // the tile side becomes 1 unit
	bust.scale.setScalar(k);
	bust.position.set(-((box.min.x + box.max.x) / 2) * k, -((box.min.y + box.max.y) / 2) * k - 0.02, 0.035);

	const tileMat = new MeshStandardMaterial({ color: PANEL, roughness: 0.55, metalness: 0.25 });
	const rimMat = new MeshStandardMaterial({ color: PRIMARY, roughness: 0.4, metalness: 0.5 });
	const tile = new Mesh(
		new ExtrudeGeometry(roundedRect(1, 1, 0.16), {
			depth: 0.05,
			bevelEnabled: true,
			bevelThickness: 0.012,
			bevelSize: 0.012,
			bevelSegments: 2,
			curveSegments: 10
		}),
		tileMat
	);
	tile.position.z = -0.03;
	const rim = new Mesh(
		new ExtrudeGeometry(frameShape(1.03, 1.03, 0.17, 0.022), {
			depth: 0.075,
			bevelEnabled: true,
			bevelThickness: 0.006,
			bevelSize: 0.006,
			bevelSegments: 2,
			curveSegments: 10
		}),
		rimMat
	);
	rim.position.z = -0.045;
	// The back shows the same mark, so the turn on scroll never reveals an empty plate.
	const back = bust.clone();
	back.rotation.y = Math.PI;
	back.position.set(-bust.position.x, bust.position.y, -0.045);
	group.add(tile, rim, bust, back);
	return group;
}

function roundedBox(w: number, h: number, d: number, r: number, color: number, metal = 0.3): Mesh {
	return new Mesh(
		new ExtrudeGeometry(roundedRect(w, h, r), { depth: d, bevelEnabled: false, curveSegments: 8 }),
		new MeshStandardMaterial({ color, roughness: 0.5, metalness: metal })
	);
}

/** A phone: dark body, blue rim, and three message bars on its screen. */
function buildPhone(): Group {
	const g = new Group();
	const body = roundedBox(0.32, 0.58, 0.03, 0.04, PANEL);
	const rim = new Mesh(
		new ExtrudeGeometry(frameShape(0.335, 0.595, 0.045, 0.01), { depth: 0.04, bevelEnabled: false, curveSegments: 8 }),
		new MeshStandardMaterial({ color: PRIMARY, roughness: 0.4, metalness: 0.5 })
	);
	body.position.z = 0;
	rim.position.z = -0.005;
	g.add(body, rim);
	const bars: [number, number, number, boolean][] = [
		[-0.04, 0.14, 0.15, false],
		[0.04, 0.05, 0.17, true],
		[-0.03, -0.04, 0.12, false]
	];
	for (const [x, y, w, mine] of bars) {
		const b = roundedBox(w, 0.055, 0.012, 0.02, mine ? SECONDARY : 0x1b2c4a, 0.1);
		b.position.set(x, y, 0.03);
		g.add(b);
	}
	return g;
}

function buildEnvelope(): { group: Group; flap: Group; seal: Mesh } {
	const group = new Group();
	const w = 0.42;
	const h = 0.28;
	const paper = new MeshStandardMaterial({ color: TEXT, roughness: 0.6, metalness: 0.05, side: DoubleSide });
	const body = new Mesh(
		new ExtrudeGeometry(roundedRect(w, h, 0.02), { depth: 0.02, bevelEnabled: false, curveSegments: 6 }),
		paper
	);
	body.position.z = -0.01;
	const flap = new Group();
	const tri = new Shape();
	tri.moveTo(-w / 2, 0);
	tri.lineTo(w / 2, 0);
	tri.lineTo(0, -h * 0.62);
	tri.closePath();
	const flapMesh = new Mesh(
		new ExtrudeGeometry(tri, { depth: 0.012, bevelEnabled: false }),
		new MeshStandardMaterial({ color: 0xbcd0ee, roughness: 0.6, metalness: 0.05, side: DoubleSide })
	);
	flapMesh.position.z = 0.012;
	flap.add(flapMesh);
	flap.position.y = h / 2;
	const seal = new Mesh(
		new CylinderGeometry(0.035, 0.035, 0.015, 24),
		new MeshStandardMaterial({ color: PRIMARY, roughness: 0.35, metalness: 0.5 })
	);
	seal.rotation.x = Math.PI / 2;
	seal.position.set(0, h / 2 - h * 0.62 + 0.02, 0.04);
	group.add(body, flap, seal);
	return { group, flap, seal };
}

export function createScene(
	canvas: HTMLCanvasElement,
	opts: { onReady: () => void; onFail: () => void }
): SceneHandle | null {
	let renderer: WebGLRenderer;
	try {
		renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
	} catch {
		return null;
	}
	const gl = renderer.getContext();
	if (!gl || gl.isContextLost()) {
		renderer.dispose();
		return null;
	}
	renderer.setClearColor(BG, 0);

	const scene = new Scene();
	const camera = new PerspectiveCamera(FOV, 1, 0.1, 30);
	camera.position.z = CAM_Z;
	scene.add(new AmbientLight(0xffffff, 0.75));
	const key = new DirectionalLight(0xffffff, 2.4);
	key.position.set(-2.5, 3, 4);
	const rimLight = new DirectionalLight(SECONDARY, 1.6);
	rimLight.position.set(3, -1.5, -2);
	const fill = new DirectionalLight(0x9db8e0, 0.5);
	fill.position.set(2, 0, 4);
	scene.add(key, rimLight, fill);

	const icon = buildIcon();
	const iconPivot = new Group();
	iconPivot.add(icon);
	scene.add(iconPivot);

	// The "how it works" set: phone, relay, phone, and one envelope that travels between them.
	const flow = new Group();
	const phoneA = buildPhone();
	const phoneB = buildPhone();
	const relay = new Group();
	const relayCore = new Mesh(
		new OctahedronGeometry(0.15),
		new MeshStandardMaterial({ color: SECONDARY, roughness: 0.3, metalness: 0.55, flatShading: true })
	);
	const relayRing = new Mesh(
		new TorusGeometry(0.26, 0.008, 8, 64),
		new MeshStandardMaterial({ color: PRIMARY, roughness: 0.4, metalness: 0.5 })
	);
	relayRing.rotation.x = Math.PI / 2.4;
	relay.add(relayCore, relayRing);
	const env = buildEnvelope();
	const lineGeo = new BufferGeometry();
	lineGeo.setAttribute('position', new Float32BufferAttribute([-1, 0, 0, 1, 0, 0], 3));
	const line = new Line(lineGeo, new LineBasicMaterial({ color: PRIMARY, transparent: true, opacity: 0.45 }));
	flow.add(line, phoneA, relay, phoneB, env.group);
	flow.visible = false;
	scene.add(flow);

	const sections = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('[data-stage]'));
	let stageEls: HTMLElement[] = [];
	const howEl = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-how]');

	const state: Key = { x: 0.5, y: 0, s: 0.5, ry: 0, rx: 0, rz: 0, o: 1 };
	const target: Key = { ...state };
	let howMix = 0;
	let howP = 0;
	let narrow = false;
	let width = 1;
	let height = 1;
	let aspect = 1;
	let px = 0;
	let py = 0;
	let hidden = document.hidden;
	let running = true;
	let raf = 0;
	let last = performance.now();
	let firstFrame = true;
	let settled = 0;

	function resize(): void {
		width = window.innerWidth;
		height = window.innerHeight;
		aspect = width / height;
		narrow = aspect < 0.9 || width < 760;
		renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, narrow ? 1.5 : 1.75));
		renderer.setSize(width, height, false);
		camera.aspect = aspect;
		camera.updateProjectionMatrix();
		stageEls = sections();
		readScroll();
	}

	function readScroll(): void {
		const keys = narrow ? MOBILE : DESKTOP;
		const mid = height / 2;
		// Fractional stage index: which two sections the middle of the window sits between.
		let f = 0;
		if (stageEls.length) {
			const centers = stageEls.map((el) => {
				const r = el.getBoundingClientRect();
				return r.top + r.height / 2;
			});
			if (mid <= centers[0]) f = 0;
			else if (mid >= centers[centers.length - 1]) f = stageEls.length - 1;
			else {
				for (let i = 0; i < centers.length - 1; i++) {
					if (mid >= centers[i] && mid <= centers[i + 1]) {
						f = i + (mid - centers[i]) / (centers[i + 1] - centers[i]);
						break;
					}
				}
			}
		}
		const i0 = Math.min(Math.floor(f), keys.length - 1);
		const i1 = Math.min(i0 + 1, keys.length - 1);
		const t = smooth(f - i0);
		const a = keys[i0];
		const b = keys[i1];
		for (const n of ['x', 'y', 's', 'ry', 'rx', 'rz', 'o'] as const) target[n] = a[n] + (b[n] - a[n]) * t;

		const how = howEl();
		if (how) {
			const r = how.getBoundingClientRect();
			const enter = smooth(clamp01((height * 0.85 - r.top) / (height * 0.55)));
			const leave = smooth(clamp01((r.bottom - height * 0.15) / (height * 0.55)));
			howMix = Math.min(enter, leave);
			howP = clamp01(-r.top / Math.max(1, r.height - height));
		} else howMix = 0;
		settled = 0;
	}

	const ndc = (x: number, y: number) => new Vector3(x * HALF_H * aspect, y * HALF_H, 0);

	function layoutFlow(): void {
		// Positions are in screen units so the set fits any window; it is scaled down on narrow screens.
		const spread = narrow ? 0.66 : 0.6;
		const y = narrow ? -0.02 : -0.08;
		const sc = narrow ? 1.15 : 1.25;
		const pa = ndc(-spread, y);
		const pr = ndc(0, y);
		const pb = ndc(spread, y);
		phoneA.position.copy(pa);
		phoneB.position.copy(pb);
		relay.position.copy(pr);
		phoneA.scale.setScalar(sc);
		phoneB.scale.setScalar(sc);
		relay.scale.setScalar(sc);
		line.position.copy(pr);
		line.scale.set(Math.abs(pb.x - pa.x) / 2, 1, 1);
		env.group.scale.setScalar(sc);
		// Envelope: seal at A, travel to the relay, pass on to B, open there.
		const e = howP;
		const seal = smooth(clamp01((e - 0.05) / 0.17)); // flap closes
		const toRelay = smooth(clamp01((e - 0.25) / 0.3));
		const toB = smooth(clamp01((e - 0.6) / 0.25));
		const open = smooth(clamp01((e - 0.86) / 0.1));
		const x = e < 0.6 ? MathUtils.lerp(pa.x, pr.x, toRelay) : MathUtils.lerp(pr.x, pb.x, toB);
		const lift = Math.sin(toRelay * Math.PI) * 0.18 * sc + Math.sin(toB * Math.PI) * 0.18 * sc;
		env.group.position.set(x, y + lift + (e < 0.25 ? 0.38 * sc : 0), 0.15);
		if (e < 0.25) env.group.position.x = pa.x;
		env.group.rotation.z = Math.sin(toRelay * Math.PI) * -0.18 + Math.sin(toB * Math.PI) * 0.18;
		env.flap.rotation.x = -2.6 * (1 - seal) * (e < 0.5 ? 1 : 0) - 2.6 * open;
		env.seal.visible = seal > 0.9 && open < 0.1;
		// The relay lights up while the envelope passes it, but it never opens it.
		const near = 1 - Math.min(1, Math.abs(e - 0.57) / 0.12);
		relay.scale.setScalar(sc * (1 + 0.18 * Math.max(0, near)));
		relayRing.rotation.z += 0.02;
		relayCore.rotation.y += 0.012;
	}

	function frame(now: number): void {
		raf = 0;
		if (!running) return;
		const dt = Math.min(0.05, (now - last) / 1000);
		last = now;
		const k = 1 - Math.exp(-dt * 6);
		let moving = false;
		for (const n of ['x', 'y', 's', 'ry', 'rx', 'rz', 'o'] as const) {
			const d = target[n] - state[n];
			if (Math.abs(d) > 0.0004) moving = true;
			state[n] += d * k;
		}
		const t = now / 1000;
		const visibleIcon = state.s * (1 - howMix) > 0.01;
		iconPivot.visible = visibleIcon;
		if (visibleIcon) {
			const world = state.s * (1 - smooth(howMix)) * HALF_H * 2;
			iconPivot.position.copy(ndc(state.x, state.y + Math.sin(t * 0.9) * 0.012));
			iconPivot.scale.setScalar(Math.max(world, 0.0001));
			iconPivot.rotation.set(state.rx + py * 0.12, state.ry + Math.sin(t * 0.5) * 0.06 + px * 0.2, state.rz);
			canvas.style.opacity = '1';
		}
		flow.visible = howMix > 0.02;
		if (flow.visible) {
			flow.scale.setScalar(smooth(howMix));
			layoutFlow();
		}
		// Section keyframes carry an opacity; it fades the whole canvas gently without touching materials.
		canvas.style.opacity = String(visibleIcon || flow.visible ? Math.max(state.o, howMix) : 0);
		if (visibleIcon || flow.visible) renderer.render(scene, camera);
		if (firstFrame) {
			firstFrame = false;
			opts.onReady();
		}
		// Idle motion is slow; once everything has settled and nothing is on screen to animate, stop asking for frames.
		settled = moving || flow.visible ? 0 : settled + 1;
		schedule();
	}

	function schedule(): void {
		if (!raf && running && !hidden) {
			// Settled and idle: drop to ~20 fps for the gentle float, which is plenty and saves battery.
			raf = requestAnimationFrame(settled > 30 ? (n) => (n - last > 48 ? frame(n) : ((raf = 0), schedule())) : frame);
		}
	}

	const onScroll = () => readScroll();
	const onVis = () => {
		hidden = document.hidden;
		if (hidden && raf) {
			cancelAnimationFrame(raf);
			raf = 0;
		} else {
			last = performance.now();
			schedule();
		}
	};
	const onPointer = (e: PointerEvent) => {
		if (e.pointerType !== 'mouse') return;
		px = (e.clientX / width - 0.5) * 2;
		py = (e.clientY / height - 0.5) * 2;
	};
	const onLost = (e: Event) => {
		e.preventDefault();
		handle.destroy();
		opts.onFail();
	};

	window.addEventListener('scroll', onScroll, { passive: true });
	window.addEventListener('resize', resize);
	window.addEventListener('pointermove', onPointer, { passive: true });
	document.addEventListener('visibilitychange', onVis);
	canvas.addEventListener('webglcontextlost', onLost);
	const mo = new ResizeObserver(() => {
		stageEls = sections();
		readScroll();
	});
	mo.observe(document.body);

	const handle: SceneHandle = {
		destroy() {
			running = false;
			if (raf) cancelAnimationFrame(raf);
			window.removeEventListener('scroll', onScroll);
			window.removeEventListener('resize', resize);
			window.removeEventListener('pointermove', onPointer);
			document.removeEventListener('visibilitychange', onVis);
			canvas.removeEventListener('webglcontextlost', onLost);
			mo.disconnect();
			scene.traverse((o) => {
				const m = o as Mesh;
				m.geometry?.dispose();
				const mat = m.material;
				if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
				else mat?.dispose();
			});
			renderer.dispose();
		}
	};

	resize();
	// Start where the page already is, without sweeping in from the defaults.
	Object.assign(state, target);
	schedule();
	return handle;
}
