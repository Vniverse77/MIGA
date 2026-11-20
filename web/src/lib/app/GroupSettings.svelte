<script lang="ts">
	// Group settings: name (admin), members with admin actions as icons, banned list, add, mute, leave.
	// A bottom sheet on touch, a centred modal with a mouse (Sheet). Non-admins only see leave and mute.
	import Sheet from './Sheet.svelte';
	import Icon from './Icon.svelte';
	import { ask } from './ConfirmDialog.svelte';
	import { groupAvatarUrl } from '../avatar';
	import { canInvite, canRename, isAdmin, memberActions, memberColor, mustTransferBeforeLeaving, type MemberAction } from '../group-ui';
	import { MAX_GROUP_NAME, MAX_MEMBERS, type GroupRecord } from '../groups';
	import { t } from '../i18n.svelte';

	type Pick = { address: string; name: string };
	let {
		rec,
		me,
		nameOf,
		avSrc,
		muted,
		addable,
		onrename,
		onmember,
		onunban,
		oninvite,
		onmute,
		onleave,
		ondelete,
		onclose
	}: {
		rec: GroupRecord;
		me: string;
		nameOf: (address: string) => string;
		avSrc: (address: string) => string;
		muted: boolean;
		/** My contacts that could still be added (not members, not banned, not blocked). */
		addable: Pick[];
		onrename: (name: string) => Promise<void>;
		onmember: (action: MemberAction, address: string) => Promise<void>;
		onunban: (address: string) => Promise<void>;
		oninvite: (address: string) => Promise<void>;
		onmute: () => void;
		onleave: () => Promise<void>;
		ondelete: () => Promise<void>;
		onclose: () => void;
	} = $props();

	const st = $derived(rec.state);
	const admin = $derived(isAdmin(rec, me));
	const live = $derived(rec.status === 'active');
	let name = $state('');
	let nameInit = false;
	$effect(() => {
		if (!nameInit) {
			name = rec.state.name;
			nameInit = true;
		}
	});
	let adding = $state(false);
	let busy = $state(false);
	const full = $derived(st.members.length >= MAX_MEMBERS);
	const nameChanged = $derived(name.trim() !== '' && name.trim().replace(/\s+/g, ' ') !== st.name);

	const label = (a: string) => (a === me ? t('you') : nameOf(a));
	const ICON: Record<MemberAction, 'crown' | 'user-x' | 'block'> = { admin: 'crown', remove: 'user-x', ban: 'block' };
	const TITLE: Record<MemberAction, 'g_make_admin' | 'g_remove' | 'g_ban'> = { admin: 'g_make_admin', remove: 'g_remove', ban: 'g_ban' };
	const BODY: Record<MemberAction, 'g_q_admin' | 'g_q_remove' | 'g_q_ban'> = { admin: 'g_q_admin', remove: 'g_q_remove', ban: 'g_q_ban' };

	async function run(job: () => Promise<void>): Promise<void> {
		if (busy) return;
		busy = true;
		try {
			await job();
		} finally {
			busy = false;
		}
	}

	async function act(action: MemberAction, address: string): Promise<void> {
		const ok = await ask({ body: t(BODY[action], { name: label(address) }), confirm: t(TITLE[action]), danger: action !== 'admin' });
		if (ok) await run(() => onmember(action, address));
	}

	async function leave(): Promise<void> {
		const ok = await ask({ body: t('g_q_leave', { name: st.name }), confirm: t('g_leave'), danger: true });
		if (ok) await run(onleave);
	}
	async function drop(): Promise<void> {
		const ok = await ask({ body: t('g_q_delete', { name: st.name }), confirm: t('delete_chat'), danger: true });
		if (ok) await run(ondelete);
	}
</script>

<Sheet title={t('g_settings')} {onclose} {busy}>
	<div class="gs" data-group-settings>
		<div class="top">
			<img class="gav" src={groupAvatarUrl(st.id)} alt="" width="64" height="64" />
			{#if admin}
				<form
					class="rename"
					onsubmit={(e) => {
						e.preventDefault();
						if (nameChanged) void run(() => onrename(name));
					}}
				>
					<input bind:value={name} maxlength={MAX_GROUP_NAME} aria-label={t('g_name')} autocomplete="off" enterkeyhint="done" data-group-name />
					<button type="submit" class="ic ok" disabled={!nameChanged || busy} title={t('save')} aria-label={t('save')}><Icon name="check" size={20} /></button>
				</form>
			{:else}
				<strong class="gname">{st.name}</strong>
			{/if}
		</div>

		<h3><Icon name="users" size={16} />{t('g_members')} <span class="n" class:full data-count>{st.members.length}/{MAX_MEMBERS}</span></h3>
		<ul class="members">
			{#each st.members as a (a)}
				<li data-member={a}>
					<img src={avSrc(a)} alt="" class="av" />
					<span class="nm" style:color="var(--gm-{memberColor(st.members, a)})">{label(a)}</span>
					{#if a === st.admin}<span class="badge" title={t('g_admin')} aria-label={t('g_admin')} role="img"><Icon name="crown" size={15} /></span>{/if}
					{#if !rec.accepted.includes(a) && a !== me}<span class="wait" title={t('g_pending')} aria-label={t('g_pending')} role="img">&hellip;</span>{/if}
					<span class="acts">
						{#each memberActions(rec, me, a) as action (action)}
							<button type="button" class="ic" class:danger={action !== 'admin'} title={t(TITLE[action])} aria-label={t(TITLE[action])} disabled={busy} data-act={action} onclick={() => act(action, a)}><Icon name={ICON[action]} size={19} /></button>
						{/each}
					</span>
				</li>
			{/each}
		</ul>

		{#if admin && live}
			<div class="add">
				<button type="button" class="line" disabled={full || !addable.length} aria-expanded={adding} data-add onclick={() => (adding = !adding)}>
					<Icon name="user-plus" size={19} /><span>{t('g_add_member')}</span>
				</button>
				{#if full}<p class="hint" role="status">{t('g_full', { n: MAX_MEMBERS })}</p>{/if}
				{#if adding && !full}
					<ul class="members pick">
						{#each addable as c (c.address)}
							<li>
								<img src={avSrc(c.address)} alt="" class="av" />
								<span class="nm">{c.name}</span>
								<button type="button" class="ic ok" title={t('g_add_member')} aria-label={t('g_add_member')} disabled={busy} data-invite={c.address} onclick={() => run(() => oninvite(c.address)).then(() => (adding = false))}><Icon name="plus" size={19} /></button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		{/if}

		{#if admin && st.banned.length}
			<h3><Icon name="block" size={16} />{t('g_banned')}</h3>
			<ul class="members">
				{#each st.banned as a (a)}
					<li data-banned={a}>
						<img src={avSrc(a)} alt="" class="av" />
						<span class="nm">{nameOf(a)}</span>
						<span class="acts"><button type="button" class="ic" title={t('g_unban')} aria-label={t('g_unban')} disabled={busy} data-act="unban" onclick={() => run(() => onunban(a))}><Icon name="undo" size={19} /></button></span>
					</li>
				{/each}
			</ul>
		{/if}

		<div class="foot">
			<button type="button" class="line" aria-pressed={muted} data-mute onclick={onmute}>
				<Icon name={muted ? 'bell' : 'bell-off'} size={19} /><span>{t(muted ? 'unmute_chat' : 'mute_chat')}</span>
			</button>
			{#if live}
				<button type="button" class="line danger" disabled={busy || mustTransferBeforeLeaving(rec, me)} data-leave onclick={leave}>
					<Icon name="logout" size={19} /><span>{t('g_leave')}</span>
				</button>
				{#if mustTransferBeforeLeaving(rec, me)}<p class="hint">{t('g_admin_leave_hint')}</p>{/if}
			{:else}
				<button type="button" class="line danger" disabled={busy} onclick={drop}><Icon name="trash" size={19} /><span>{t('delete_chat')}</span></button>
			{/if}
		</div>
	</div>
</Sheet>

<style>
	.gs {
		display: grid;
		gap: 0.7rem;
		min-width: 0;
	}
	.top {
		display: flex;
		align-items: center;
		gap: 0.8rem;
	}
	.gav {
		flex: none;
		width: 64px;
		height: 64px;
		border-radius: 14px;
		image-rendering: pixelated;
		border: 0.5px solid var(--line-strong);
	}
	.gname {
		color: var(--heading);
		font-size: 1.1rem;
		overflow-wrap: anywhere;
	}
	.rename {
		display: flex;
		flex: 1;
		align-items: center;
		gap: 0.4rem;
		min-width: 0;
	}
	.rename input {
		flex: 1;
		min-width: 0;
	}
	h3 {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin: 0.3rem 0 0;
		color: var(--muted);
		font-size: var(--fs-small);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.n {
		margin-left: auto;
		font-variant-numeric: tabular-nums;
		color: var(--heading);
	}
	.n.full {
		color: var(--accent-2);
	}
	.members {
		display: grid;
		gap: 2px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.members li {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		min-height: 48px;
		min-width: 0;
	}
	.av {
		flex: none;
		width: 36px;
		height: 36px;
		border-radius: 50%;
		object-fit: cover;
		image-rendering: pixelated;
	}
	.nm {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 600;
	}
	.badge {
		display: grid;
		place-items: center;
		flex: none;
		color: var(--accent-2);
	}
	.wait {
		flex: none;
		color: var(--muted);
		letter-spacing: 0.1em;
	}
	.acts {
		display: flex;
		flex: none;
	}
	.ic {
		display: grid;
		place-items: center;
		flex: none;
		width: 40px;
		height: 40px;
		padding: 0;
		border: 0;
		border-radius: var(--radius);
		background: transparent;
		color: var(--muted);
		cursor: pointer;
	}
	.ic:hover:not(:disabled) {
		background: var(--panel-2);
		color: var(--text);
	}
	.ic.danger:hover:not(:disabled) {
		color: var(--danger);
	}
	.ic.ok {
		color: var(--accent-2);
	}
	.ic:disabled {
		opacity: 0.35;
		cursor: default;
	}
	.line {
		display: flex;
		align-items: center;
		gap: 0.7rem;
		width: 100%;
		min-height: 48px;
		padding: 0 0.5rem;
		border: 0;
		border-radius: var(--radius);
		background: transparent;
		color: var(--text);
		font-size: var(--fs-body);
		text-align: left;
		cursor: pointer;
	}
	.line:hover:not(:disabled) {
		background: var(--panel-2);
	}
	.line:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	.line.danger {
		color: var(--danger);
	}
	.foot {
		display: grid;
		gap: 2px;
		margin-top: 0.2rem;
		padding-top: 0.4rem;
		border-top: 0.5px solid var(--line);
	}
	.hint {
		margin: 0 0.5rem;
		color: var(--muted);
		font-size: var(--fs-small);
	}
	.pick {
		padding-left: 0.5rem;
	}
</style>
