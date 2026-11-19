// Swipe a bubble sideways (either way) to reply: it follows the finger, a reply icon fades in behind it, a tick fires at the
// threshold, and it springs back. Touch only. Vertical scrolling stays with the browser (touch-action: pan-y on the bubble).
const THRESHOLD = 56;
const SLOP = 10;
const ICON =
	'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 6 6v3"/></svg>';

export function swipeReply(node: HTMLElement, opts: { onreply: () => void; haptic?: () => void }) {
	let o = opts;
	let id = -1;
	let x0 = 0;
	let y0 = 0;
	let mode: '' | 'h' | 'v' = '';
	let armed = false;
	let icon: HTMLElement | null = null;

	function reset(animate: boolean): void {
		node.style.transition = animate ? 'transform 0.32s cubic-bezier(0.34, 1.56, 0.64, 1)' : '';
		node.style.transform = '';
		if (icon) {
			icon.style.opacity = '0';
			const gone = icon;
			setTimeout(() => gone.remove(), animate ? 320 : 0);
			icon = null;
		}
		id = -1;
		mode = '';
		armed = false;
	}

	function down(e: PointerEvent): void {
		if (e.pointerType !== 'touch' || !e.isPrimary) return;
		if ((e.target as Element | null)?.closest?.('a, button, input, textarea, video, audio')) return;
		id = e.pointerId;
		x0 = e.clientX;
		y0 = e.clientY;
		mode = '';
		node.style.transition = 'none';
	}
	function move(e: PointerEvent): void {
		if (e.pointerId !== id) return;
		const dx = e.clientX - x0;
		const dy = e.clientY - y0;
		if (!mode) {
			if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
			if (Math.abs(dx) > Math.abs(dy) * 1.5 && !getSelection()?.toString()) {
				mode = 'h';
				try {
					node.setPointerCapture(e.pointerId);
				} catch {
					// Not an active pointer (synthetic event): the drag still works without capture.
				}
				icon = document.createElement('span');
				icon.className = 'swipe-icon';
				icon.innerHTML = ICON;
				icon.style.cssText = `position:absolute;top:50%;${dx > 0 ? 'left' : 'right'}:-2.6rem;display:grid;place-items:center;width:2rem;height:2rem;border:0.5px solid var(--line-strong);border-radius:50%;background:var(--panel-2);color:var(--accent-2);opacity:0;pointer-events:none;`;
				node.append(icon);
			} else {
				mode = 'v';
			}
		}
		if (mode !== 'h') return;
		// Resistance past the threshold, so it never runs away from the finger.
		const a = Math.abs(dx);
		const shown = a <= THRESHOLD ? a : THRESHOLD + (a - THRESHOLD) * 0.25;
		const tx = Math.sign(dx) * Math.min(shown, THRESHOLD * 1.5);
		node.style.transform = `translateX(${tx}px)`;
		const p = Math.min(1, a / THRESHOLD);
		if (icon) {
			icon.style.opacity = String(p);
			icon.style.transform = `translateY(-50%) scale(${0.6 + 0.4 * p})`;
		}
		if (a >= THRESHOLD && !armed) {
			armed = true;
			o.haptic?.();
		} else if (a < THRESHOLD && armed) armed = false;
	}
	function up(e: PointerEvent): void {
		if (e.pointerId !== id) return;
		const fire = mode === 'h' && armed;
		reset(true);
		if (fire) o.onreply();
	}
	function cancel(e: PointerEvent): void {
		if (e.pointerId === id) reset(true);
	}

	node.addEventListener('pointerdown', down);
	node.addEventListener('pointermove', move);
	node.addEventListener('pointerup', up);
	node.addEventListener('pointercancel', cancel);
	return {
		update(next: typeof opts) {
			o = next;
		},
		destroy() {
			node.removeEventListener('pointerdown', down);
			node.removeEventListener('pointermove', move);
			node.removeEventListener('pointerup', up);
			node.removeEventListener('pointercancel', cancel);
		}
	};
}
