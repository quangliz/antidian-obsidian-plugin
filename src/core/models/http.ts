import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';

export interface HttpRequestOptions {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	timeout?: number;
	onData?: (chunk: string, statusCode: number) => void;
}

export interface HttpResponse {
	statusCode: number;
	statusMessage: string;
	headers: http.IncomingHttpHeaders;
	body: string;
}

export function httpRequest(
	urlStr: string,
	options: HttpRequestOptions = {},
): Promise<HttpResponse> {
	return new Promise((resolve, reject) => {
		const url = new URL(urlStr);
		const isHttps = url.protocol === 'https:';
		const client = isHttps ? https : http;

		const reqOptions: https.RequestOptions = {
			method: options.method ?? 'GET',
			headers: options.headers ?? {},
			timeout: options.timeout ?? 60000,
		};

		const req = client.request(url, reqOptions, (res) => {
			let data = '';
			res.setEncoding('utf-8');
			res.on('data', (chunk) => {
				const textChunk = String(chunk);
				data += textChunk;
				options.onData?.(textChunk, res.statusCode ?? 0);
			});
			res.on('end', () => {
				resolve({
					statusCode: res.statusCode ?? 0,
					statusMessage: res.statusMessage ?? '',
					headers: res.headers,
					body: data,
				});
			});
		});

		req.on('timeout', () => {
			req.destroy(new Error(`Request to ${urlStr} timed out.`));
		});

		req.on('error', (err) => {
			reject(err);
		});

		if (options.body) {
			req.write(options.body);
		}
		req.end();
	});
}
