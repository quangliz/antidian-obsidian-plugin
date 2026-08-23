import type AntiDianPlugin from '../../main';

export function registerCommands(plugin: AntiDianPlugin): void {
	plugin.addCommand({
		id: 'open-sidebar',
		name: 'Open sidebar',
		callback: () => {
			void plugin.activateView();
		},
	});
}
