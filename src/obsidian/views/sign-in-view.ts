import type { BackendConnection } from '../../core/models/antigravity-acp';
import type { BinaryDownloadProgress } from '../../core/models/agy-binary-manager';

export interface SignInCallbacks {
	getConnection: () => BackendConnection;
	/** Custom binary path from the settings, if any. */
	getCustomPath: () => string;
	login: (onProgress: (p: BinaryDownloadProgress) => void) => Promise<void>;
	cancelLogin: () => void;
	checkAgain: () => void;
}

/** Stands in for the prompt bar on the empty screen until the backend is usable. */
export class SignInView {
	private el: HTMLElement;
	private progress: BinaryDownloadProgress | null = null;
	private loginError: string | null = null;

	constructor(
		parentEl: HTMLElement,
		private callbacks: SignInCallbacks,
	) {
		this.el = parentEl.createDiv({
			cls: 'antidian-sign-in',
			attr: { 'aria-live': 'polite' },
		});
		this.render();
	}

	/** Call when the connection state changes. */
	render(): void {
		this.el.empty();
		if (this.progress) {
			const { phase, message } = this.progress;
			this.addText(
				phase === 'signing-in' ? 'Signing in' : 'Setting up Antigravity',
				message,
			);
			if (phase === 'signing-in') {
				this.addButton('Cancel', () => this.callbacks.cancelLogin());
			}
			return;
		}

		const { status, message } = this.callbacks.getConnection();
		const customPath = this.callbacks.getCustomPath();
		const signIn = () => void this.signIn();
		const checkAgain = () => this.callbacks.checkAgain();
		switch (status) {
			case 'ready':
				this.loginError = null;
				return;
			case 'checking':
				this.addText('Connecting to Antigravity…');
				return;
			case 'not-installed':
				if (customPath) {
					this.addText(
						'Antigravity not found',
						`There is no file at ${customPath}. Change the custom binary path in the Antidian settings.`,
					);
					this.addButton('Check again', checkAgain, true);
					return;
				}
				this.addText(
					'Sign in to start',
					'The Antigravity backend is not installed yet. It is downloaded before you sign in.',
				);
				break;
			case 'signed-out':
				this.addText(
					'Sign in to start',
					'Antidian works with your Google account through Antigravity.',
				);
				break;
			case 'error':
				this.addText('Could not connect to Antigravity', message);
				this.addError();
				this.addButton('Check again', checkAgain, true);
				this.addButton('Sign in with Google', signIn);
				return;
		}
		this.addError();
		this.addButton('Sign in with Google', signIn, true);
		this.addButton('Check again', checkAgain);
	}

	private async signIn(): Promise<void> {
		this.loginError = null;
		this.progress = { phase: 'manifest', message: 'Preparing…' };
		this.render();
		try {
			await this.callbacks.login((progress) => {
				this.progress = progress;
				this.render();
			});
		} catch (err) {
			this.loginError = err instanceof Error ? err.message : String(err);
		} finally {
			this.progress = null;
			this.render();
		}
	}

	private addText(title: string, desc?: string): void {
		this.el.createDiv({ cls: 'antidian-empty-title', text: title });
		if (desc) this.el.createDiv({ cls: 'antidian-sign-in-desc', text: desc });
	}

	private addError(): void {
		if (!this.loginError) return;
		this.el.createDiv({ cls: 'antidian-sign-in-error', text: this.loginError });
	}

	private addButton(text: string, onClick: () => void, primary = false): void {
		const button = this.el.createEl('button', {
			cls: primary ? 'mod-cta' : 'antidian-sign-in-secondary',
			text,
		});
		button.onclick = onClick;
	}
}
