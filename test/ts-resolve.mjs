import { registerHooks } from 'node:module';
import * as fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as path from 'node:path';

registerHooks({
	resolve(specifier, context, nextResolve) {
		try {
			return nextResolve(specifier, context);
		} catch (err) {
			if (
				(specifier.startsWith('./') || specifier.startsWith('../')) &&
				context.parentURL
			) {
				const parentDir = path.dirname(fileURLToPath(context.parentURL));
				const base = path.resolve(parentDir, specifier);
				const candidates = [
					`${base}.ts`,
					path.join(base, 'index.ts'),
				];
				for (const candidate of candidates) {
					if (fs.existsSync(candidate)) {
						return {
							shortCircuit: true,
							url: pathToFileURL(candidate).href,
						};
					}
				}
			}
			throw err;
		}
	},
});
