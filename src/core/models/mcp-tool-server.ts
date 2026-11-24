import * as http from 'http';
import * as crypto from 'crypto';
import type { ToolContext, ToolRegistry } from '../tools';

export interface McpToolServerInfo {
	url: string;
	token: string;
	port: number;
}

export interface McpToolCallEvent {
	/** Unique per call within this server, used to pair start/end events. */
	callId: string;
	toolName: string;
	toolArgs: Record<string, unknown>;
	toolOutput?: unknown;
}

interface JsonRpcRequest {
	jsonrpc: '2.0';
	id?: string | number | null;
	method: string;
	params?: Record<string, unknown>;
}

export class McpToolServer {
	private registry: ToolRegistry;
	private server: http.Server | null = null;
	private token: string;
	private info: McpToolServerInfo | null = null;
	private activeTurnContext: ToolContext | undefined;
	private onToolStart?: (event: McpToolCallEvent) => void;
	private callCounter = 0;
	private onToolEnd?: (event: McpToolCallEvent) => void;

	constructor(registry: ToolRegistry) {
		this.registry = registry;
		this.token = crypto.randomBytes(24).toString('hex');
	}

	setTurnContext(
		ctx?: ToolContext,
		callbacks?: {
			onToolStart?: (event: McpToolCallEvent) => void;
			onToolEnd?: (event: McpToolCallEvent) => void;
		},
	): void {
		this.activeTurnContext = ctx;
		this.onToolStart = callbacks?.onToolStart;
		this.onToolEnd = callbacks?.onToolEnd;
	}

	clearTurnContext(): void {
		this.activeTurnContext = undefined;
		this.onToolStart = undefined;
		this.onToolEnd = undefined;
	}

	async start(): Promise<McpToolServerInfo> {
		if (this.info && this.server) {
			return this.info;
		}

		this.server = http.createServer((req, res) => {
			void this.handleRequest(req, res);
		});

		await new Promise<void>((resolve, reject) => {
			this.server!.once('error', reject);
			this.server!.listen(0, '127.0.0.1', () => {
				this.server!.removeListener('error', reject);
				resolve();
			});
		});

		const address = this.server.address();
		const port =
			typeof address === 'object' && address !== null ? address.port : 0;

		this.info = {
			url: `http://127.0.0.1:${port}/mcp`,
			token: this.token,
			port,
		};
		return this.info;
	}

	async stop(): Promise<void> {
		this.clearTurnContext();
		if (!this.server) return;
		const srv = this.server;
		this.server = null;
		this.info = null;
		await new Promise<void>((resolve) => {
			srv.close(() => resolve());
		});
	}

	private async handleRequest(
		req: http.IncomingMessage,
		res: http.ServerResponse,
	): Promise<void> {
		const authHeader = req.headers.authorization;
		if (authHeader !== `Bearer ${this.token}`) {
			res.writeHead(401, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Unauthorized' }));
			return;
		}

		if (req.method === 'DELETE') {
			res.writeHead(200);
			res.end();
			return;
		}

		if (req.method !== 'POST') {
			res.writeHead(405);
			res.end();
			return;
		}

		const rawBody = await new Promise<string>((resolve) => {
			let data = '';
			req.on('data', (chunk: Buffer | string) => {
				data += chunk.toString();
			});
			req.on('end', () => resolve(data));
		});

		if (!rawBody.trim()) {
			res.writeHead(202);
			res.end();
			return;
		}

		let msg: JsonRpcRequest;
		try {
			msg = JSON.parse(rawBody) as JsonRpcRequest;
		} catch {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(
				JSON.stringify({
					jsonrpc: '2.0',
					id: null,
					error: { code: -32700, message: 'Parse error' },
				}),
			);
			return;
		}

		if (msg.method === 'notifications/initialized') {
			res.writeHead(202);
			res.end();
			return;
		}

		if (msg.method === 'initialize') {
			this.sendResult(res, msg.id, {
				protocolVersion: '2025-03-26',
				capabilities: { tools: {} },
				serverInfo: { name: 'anti-dian-vault', version: '1.0.0' },
			});
			return;
		}

		if (msg.method === 'ping') {
			this.sendResult(res, msg.id, {});
			return;
		}

		if (msg.method === 'tools/list') {
			const tools = this.registry.getAll().map((t) => ({
				name: t.name,
				description: t.description,
				inputSchema: t.schema,
			}));
			this.sendResult(res, msg.id, { tools });
			return;
		}

		if (msg.method === 'tools/call') {
			const name =
				typeof msg.params?.name === 'string' ? msg.params.name : '';
			const args =
				(msg.params?.arguments as Record<string, unknown> | undefined) ??
				{};

			const tool = this.registry.get(name);
			if (!tool) {
				this.sendResult(res, msg.id, {
					isError: true,
					content: [
						{
							type: 'text',
							text: JSON.stringify({
								error: `Tool "${name}" not found`,
							}),
						},
					],
				});
				return;
			}

			const turnContext = this.activeTurnContext;
			if (turnContext?.signal?.aborted) {
				this.sendResult(res, msg.id, {
					content: [
						{
							type: 'text',
							text: JSON.stringify({
								cancelled: true,
								message: 'Turn cancelled by user.',
							}),
						},
					],
				});
				return;
			}

			const callId = `mcp-${++this.callCounter}`;
			this.onToolStart?.({ callId, toolName: name, toolArgs: args });

			if (
				tool.mutates &&
				turnContext?.permissionMode === 'plan'
			) {
				const blockedOutput = {
					staged: false,
					blockedByPlanMode: true,
					message: `Plan Mode (read-only) is active: "${name}" was not staged. Present your proposed changes to the user in markdown instead.`,
				};
				this.onToolEnd?.({
					callId,
					toolName: name,
					toolArgs: args,
					toolOutput: blockedOutput,
				});
				this.sendResult(res, msg.id, {
					content: [
						{
							type: 'text',
							text: JSON.stringify(blockedOutput),
						},
					],
				});
				return;
			}

			try {
				let output = await tool.execute(args, turnContext);
				if (turnContext?.signal?.aborted) {
					output = {
						staged: false,
						applied: false,
						cancelled: true,
						message: 'Turn cancelled by user.',
					};
				} else if (tool.mutates && turnContext?.reviewMutation) {
					// Mutations are reviewed per call (approve/apply or reject) before
					// the model sees the result.
					output = await turnContext.reviewMutation({
						callId,
						toolName: name,
						toolArgs: args,
						output,
					});
				}
				this.onToolEnd?.({
					callId,
					toolName: name,
					toolArgs: args,
					toolOutput: output,
				});
				this.sendResult(res, msg.id, {
					content: [
						{
							type: 'text',
							text:
								typeof output === 'string'
									? output
									: JSON.stringify(withoutPrivateFields(output)),
						},
					],
				});
			} catch (err) {
				const errOutput = {
					error: err instanceof Error ? err.message : String(err),
				};
				this.onToolEnd?.({
					callId,
					toolName: name,
					toolArgs: args,
					toolOutput: errOutput,
				});
				this.sendResult(res, msg.id, {
					isError: true,
					content: [
						{
							type: 'text',
							text: JSON.stringify(errOutput),
						},
					],
				});
			}
			return;
		}

		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(
			JSON.stringify({
				jsonrpc: '2.0',
				id: msg.id ?? null,
				error: {
					code: -32601,
					message: `Method not found: ${msg.method}`,
				},
			}),
		);
	}

	private sendResult(
		res: http.ServerResponse,
		id: string | number | null | undefined,
		result: unknown,
	): void {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(
			JSON.stringify({
				jsonrpc: '2.0',
				id: id ?? null,
				result,
			}),
		);
	}
}

/** Fields prefixed with `_` are for the UI only (e.g. diffs) and never sent to the model. */
function withoutPrivateFields(value: unknown): unknown {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).filter(([key]) => !key.startsWith('_')),
	);
}
