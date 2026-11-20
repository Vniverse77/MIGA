// Tiny renderer for the legal pages. It handles only what docs/legal/*.md uses: headings, paragraphs,
// bullet lists, tables, **bold**, `code` and [text](url). Input is escaped first, so no raw HTML gets through.
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(s: string): string {
	return esc(s)
		.replace(/`([^`]+)`/g, '<code>$1</code>')
		.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
		.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, url: string) =>
			/^(https:\/\/|\/)/.test(url) ? `<a href="${url}">${text}</a>` : text
		)
		.replace(/(^|[\s(])(https:\/\/[^\s)<]+[^\s).,<])/g, '$1<a href="$2">$2</a>');
}

export function renderMarkdown(src: string): string {
	const lines = src.replace(/<!--[\s\S]*?-->/g, '').split('\n');
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (!line.trim()) { i++; continue; }
		const h = /^(#{1,3})\s+(.*)$/.exec(line);
		if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
		if (line.startsWith('|')) {
			const rows: string[][] = [];
			while (i < lines.length && lines[i].startsWith('|')) {
				if (!/^\|[\s|:-]+\|$/.test(lines[i])) rows.push(lines[i].replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
				i++;
			}
			const [head, ...body] = rows;
			out.push('<div class="tbl"><table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' +
				body.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>');
			continue;
		}
		if (/^[-*]\s/.test(line)) {
			const items: string[] = [];
			while (i < lines.length && lines[i].trim()) {
				if (/^[-*]\s/.test(lines[i])) items.push(lines[i].replace(/^[-*]\s+/, ''));
				else items[items.length - 1] += ' ' + lines[i].trim();
				i++;
			}
			out.push('<ul>' + items.map((x) => `<li>${inline(x)}</li>`).join('') + '</ul>');
			continue;
		}
		const para: string[] = [];
		while (i < lines.length && lines[i].trim() && !/^(#{1,3}\s|\||[-*]\s)/.test(lines[i])) para.push(lines[i++].trim());
		out.push(`<p>${inline(para.join(' '))}</p>`);
	}
	return out.join('\n');
}
