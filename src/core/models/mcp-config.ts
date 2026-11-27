import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type McpServerType = 'stdio' | 'http';

export interface McpServerConfig {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	serverUrl?: string;
	url?: string;
	httpUrl?: string;
	headers?: Record<string, string>;
	disabled?: boolean;
	[key: string]: unknown;
}

export interface McpConfigFile {
	mcpServers: Record<string, McpServerConfig>;
	[key: string]: unknown;
}

export interface McpServerListItem {
	name: string;
	type: McpServerType;
	enabled: boolean;
	summary: string;
	config: McpServerConfig;
}

export interface McpServerInput {
	type: McpServerType;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	serverUrl?: string;
	headers?: Record<string, string>;
	enabled?: boolean;
}

export function getMcpConfigPath(homeDir: string = os.homedir()): string {
	return path.join(homeDir, '.gemini', 'config', 'mcp_config.json');
}

export function getMcpServerUrl(config: McpServerConfig): string {
	return config.serverUrl ?? config.httpUrl ?? config.url ?? '';
}

export function getMcpServerType(config: McpServerConfig): McpServerType {
	return getMcpServerUrl(config) && !config.command ? 'http' : 'stdio';
}

export function formatMcpServerSummary(config: McpServerConfig): string {
	const type = getMcpServerType(config);
	if (type === 'http') {
		return getMcpServerUrl(config) || '(missing URL)';
	}
	const parts = [config.command ?? '', ...(config.args ?? [])].filter(Boolean);
	return parts.join(' ') || '(missing command)';
}

export function readMcpConfig(configPath: string = getMcpConfigPath()): McpConfigFile {
	if (!fs.existsSync(configPath)) {
		return { mcpServers: {} };
	}
	const raw = fs.readFileSync(configPath, 'utf8').trim();
	if (!raw) {
		return { mcpServers: {} };
	}
	const parsed: unknown = JSON.parse(raw);
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('MCP config root must be a JSON object.');
	}
	const record = parsed as Record<string, unknown>;
	const rawServers = record.mcpServers;
	if (
		rawServers !== undefined &&
		(!rawServers || typeof rawServers !== 'object' || Array.isArray(rawServers))
	) {
		throw new Error('Field "mcpServers" must be a JSON object.');
	}
	return {
		...record,
		mcpServers: (rawServers as Record<string, McpServerConfig> | undefined) ?? {},
	};
}

export function writeMcpConfig(
	config: McpConfigFile,
	configPath: string = getMcpConfigPath(),
): void {
	const dir = path.dirname(configPath);
	fs.mkdirSync(dir, { recursive: true });
	const existed = fs.existsSync(configPath);
	const serialized = `${JSON.stringify(config, null, 2)}\n`;
	fs.writeFileSync(configPath, serialized, {
		encoding: 'utf8',
		mode: existed ? undefined : 0o600,
	});
}

export function listMcpServers(configPath: string = getMcpConfigPath()): McpServerListItem[] {
	const config = readMcpConfig(configPath);
	return Object.entries(config.mcpServers)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, entry]) => ({
			name,
			type: getMcpServerType(entry),
			enabled: entry.disabled !== true,
			summary: formatMcpServerSummary(entry),
			config: entry,
		}));
}

export function setMcpServerEnabled(
	name: string,
	enabled: boolean,
	configPath: string = getMcpConfigPath(),
): void {
	const config = readMcpConfig(configPath);
	const existing = config.mcpServers[name];
	if (!existing) {
		throw new Error(`MCP server "${name}" not found.`);
	}
	config.mcpServers[name] = {
		...existing,
		disabled: !enabled,
	};
	writeMcpConfig(config, configPath);
}

export function upsertMcpServer(
	name: string,
	input: McpServerInput,
	options?: { previousName?: string; configPath?: string },
): void {
	const trimmedName = name.trim();
	if (!trimmedName) {
		throw new Error('Server name is required.');
	}
	const configPath = options?.configPath ?? getMcpConfigPath();
	const config = readMcpConfig(configPath);
	const previousName = options?.previousName?.trim();
	const existing =
		(previousName ? config.mcpServers[previousName] : undefined) ??
		config.mcpServers[trimmedName];

	if (previousName && previousName !== trimmedName && config.mcpServers[trimmedName]) {
		throw new Error(`An MCP server named "${trimmedName}" already exists.`);
	}

	const next: McpServerConfig = existing ? { ...existing } : {};
	delete next.command;
	delete next.args;
	delete next.env;
	delete next.serverUrl;
	delete next.url;
	delete next.httpUrl;
	delete next.headers;

	if (input.type === 'http') {
		const url = input.serverUrl?.trim() ?? '';
		if (!url) {
			throw new Error('Server URL is required.');
		}
		next.serverUrl = url;
		if (input.headers && Object.keys(input.headers).length > 0) {
			next.headers = input.headers;
		}
	} else {
		const command = input.command?.trim() ?? '';
		if (!command) {
			throw new Error('Command is required.');
		}
		next.command = command;
		if (input.args && input.args.length > 0) {
			next.args = input.args;
		}
		if (input.env && Object.keys(input.env).length > 0) {
			next.env = input.env;
		}
	}

	next.disabled = input.enabled === false;

	if (previousName && previousName !== trimmedName) {
		delete config.mcpServers[previousName];
	}
	config.mcpServers[trimmedName] = next;
	writeMcpConfig(config, configPath);
}

export function removeMcpServer(
	name: string,
	configPath: string = getMcpConfigPath(),
): void {
	const config = readMcpConfig(configPath);
	if (!(name in config.mcpServers)) return;
	delete config.mcpServers[name];
	writeMcpConfig(config, configPath);
}

export function parseArgsLines(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
}

export function formatArgsLines(args?: string[]): string {
	return (args ?? []).join('\n');
}

export function parseKeyValueLines(
	text: string,
	separator: '=' | ':',
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		const idx = line.indexOf(separator);
		if (idx <= 0) {
			throw new Error(`Invalid entry "${line}". Expected KEY${separator}VALUE.`);
		}
		const key = line.slice(0, idx).trim();
		const value = line.slice(idx + 1).trim();
		if (!key) {
			throw new Error(`Invalid entry "${line}". Key cannot be empty.`);
		}
		result[key] = value;
	}
	return result;
}

export function formatKeyValueLines(
	record: Record<string, string> | undefined,
	separator: '=' | ':',
): string {
	if (!record) return '';
	const joiner = separator === ':' ? ': ' : '=';
	return Object.entries(record)
		.map(([key, value]) => `${key}${joiner}${value}`)
		.join('\n');
}
