/** Images are bundled by esbuild as data URLs (see `loader` in esbuild.config.mjs). */
declare module '*.png' {
	const dataUrl: string;
	export default dataUrl;
}
