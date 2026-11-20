// Saving a file from a page that has no native save dialog: a download of an in-memory blob.
export function browserDownload(name: string, data: Uint8Array, mime: string): Promise<'saved'> {
	const url = URL.createObjectURL(new Blob([data as BlobPart], { type: mime }));
	const link = document.createElement('a');
	link.href = url;
	link.download = name;
	link.rel = 'noopener';
	document.body.append(link);
	link.click();
	link.remove();
	// The browser needs a moment to start reading the blob.
	setTimeout(() => URL.revokeObjectURL(url), 30_000);
	return Promise.resolve('saved');
}
