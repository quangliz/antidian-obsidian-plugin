import { App, Modal } from 'obsidian';
import type { MediaInput } from '../../core/types/model';

/** Full-size preview of an attached image or video (Esc / click outside closes). */
export class MediaPreviewModal extends Modal {
	constructor(
		app: App,
		private media: MediaInput,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass('anti-dian-media-preview-modal');
		const { contentEl, media } = this;
		contentEl.empty();
		if (!media.data) return;

		if (media.type === 'video') {
			const video = contentEl.createEl('video', {
				cls: 'anti-dian-media-preview-full',
				attr: { src: media.data, controls: 'true', autoplay: 'true' },
			});
			video.playsInline = true;
		} else {
			contentEl.createEl('img', {
				cls: 'anti-dian-media-preview-full',
				attr: { src: media.data, alt: 'Attached image' },
			});
		}
		// Clicking the picture itself also closes, like most lightboxes.
		contentEl.addEventListener('click', (e) => {
			if (media.type !== 'video' || e.target === contentEl) this.close();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
