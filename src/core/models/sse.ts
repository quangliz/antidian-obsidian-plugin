export function createSSEParser(onData: (data: string) => void) {
	let buffer = '';

	return (chunk: string, flush = false): void => {
		buffer += chunk;
		const lines = buffer.split(/\r?\n/);
		buffer = lines.pop() ?? '';
		if (flush && buffer) {
			lines.push(buffer);
			buffer = '';
		}

		for (const line of lines) {
			const data = line.startsWith('data:')
				? line.slice(5).trimStart()
				: '';
			if (data && data !== '[DONE]') onData(data);
		}
	};
}
