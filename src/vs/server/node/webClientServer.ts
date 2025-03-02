/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as url from 'url';
import * as util from 'util';
import * as cookie from 'cookie';
import * as crypto from 'crypto';
import { isEqualOrParent } from 'vs/base/common/extpath';
import { getMediaMime } from 'vs/base/common/mime';
import { isLinux } from 'vs/base/common/platform';
import { ILogService } from 'vs/platform/log/common/log';
import { IServerEnvironmentService } from 'vs/server/node/serverEnvironmentService';
import { extname, dirname, join, normalize } from 'vs/base/common/path';
import { FileAccess, connectionTokenCookieName, connectionTokenQueryName, Schemas } from 'vs/base/common/network';
import { generateUuid } from 'vs/base/common/uuid';
import { IProductService } from 'vs/platform/product/common/productService';
import { ServerConnectionToken, ServerConnectionTokenType } from 'vs/server/node/serverConnectionToken';
import { asText, IRequestService } from 'vs/platform/request/common/request';
import { IHeaders } from 'vs/base/parts/request/common/request';
import { CancellationToken } from 'vs/base/common/cancellation';
import { URI } from 'vs/base/common/uri';
import { streamToBuffer } from 'vs/base/common/buffer';
import { IProductConfiguration } from 'vs/base/common/product';
import { isString } from 'vs/base/common/types';

const textMimeType = {
	'.html': 'text/html',
	'.js': 'text/javascript',
	'.json': 'application/json',
	'.css': 'text/css',
	'.svg': 'image/svg+xml',
} as { [ext: string]: string | undefined };

/**
 * Return an error to the client.
 */
export async function serveError(req: http.IncomingMessage, res: http.ServerResponse, errorCode: number, errorMessage: string): Promise<void> {
	res.writeHead(errorCode, { 'Content-Type': 'text/plain' });
	res.end(errorMessage);
}

/**
 * Serve a file at a given path or 404 if the file is missing.
 */
export async function serveFile(logService: ILogService, req: http.IncomingMessage, res: http.ServerResponse, filePath: string, responseHeaders: Record<string, string> = Object.create(null)): Promise<void> {
	try {
		const stat = await util.promisify(fs.stat)(filePath);

		// Check if file modified since
		const etag = `W/"${[stat.ino, stat.size, stat.mtime.getTime()].join('-')}"`; // weak validator (https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/ETag)
		if (req.headers['if-none-match'] === etag) {
			res.writeHead(304);
			return res.end();
		}

		// Headers
		responseHeaders['Content-Type'] = textMimeType[extname(filePath)] || getMediaMime(filePath) || 'text/plain';
		responseHeaders['Etag'] = etag;

		res.writeHead(200, responseHeaders);

		// Data
		fs.createReadStream(filePath).pipe(res);
	} catch (error) {
		if (error.code !== 'ENOENT') {
			logService.error(error);
			console.error(error.toString());
		}

		res.writeHead(404, { 'Content-Type': 'text/plain' });
		return res.end('Not found');
	}
}

const APP_ROOT = dirname(FileAccess.asFileUri('', require).fsPath);

export class WebClientServer {

	private readonly _webExtensionResourceUrlTemplate: URI | undefined;

	constructor(
		private readonly _connectionToken: ServerConnectionToken,
		@IServerEnvironmentService private readonly _environmentService: IServerEnvironmentService,
		@ILogService private readonly _logService: ILogService,
		@IRequestService private readonly _requestService: IRequestService,
		@IProductService private readonly _productService: IProductService,
	) {
		this._webExtensionResourceUrlTemplate = this._productService.extensionsGallery?.resourceUrlTemplate ? URI.parse(this._productService.extensionsGallery.resourceUrlTemplate) : undefined;
	}

	/**
	 * Handle web resources (i.e. only needed by the web client).
	 * **NOTE**: This method is only invoked when the server has web bits.
	 * **NOTE**: This method is only invoked after the connection token has been validated.
	 */
	async handle(req: http.IncomingMessage, res: http.ServerResponse, parsedUrl: url.UrlWithParsedQuery): Promise<void> {
		try {
			const pathname = parsedUrl.pathname!;

			if (pathname === '/favicon.ico' || pathname === '/manifest.json' || pathname === '/code-192.png' || pathname === '/code-512.png') {
				return serveFile(this._logService, req, res, join(APP_ROOT, 'resources', 'server', pathname.substr(1)));
			}
			if (/^\/static\//.test(pathname)) {
				return this._handleStatic(req, res, parsedUrl);
			}
			if (pathname === '/') {
				return this._handleRoot(req, res, parsedUrl);
			}
			if (pathname === '/callback') {
				// callback support
				return this._handleCallback(res);
			}
			if (/^\/web-extension-resource\//.test(pathname)) {
				// extension resource support
				return this._handleWebExtensionResource(req, res, parsedUrl);
			}

			return serveError(req, res, 404, 'Not found.');
		} catch (error) {
			this._logService.error(error);
			console.error(error.toString());

			return serveError(req, res, 500, 'Internal Server Error.');
		}
	}

	/**
	 * Handle HTTP requests for /static/*
	 */
	private async _handleStatic(req: http.IncomingMessage, res: http.ServerResponse, parsedUrl: url.UrlWithParsedQuery): Promise<void> {
		const headers: Record<string, string> = Object.create(null);

		// Strip `/static/` from the path
		const normalizedPathname = decodeURIComponent(parsedUrl.pathname!); // support paths that are uri-encoded (e.g. spaces => %20)
		const relativeFilePath = normalize(normalizedPathname.substr('/static/'.length));

		const filePath = join(APP_ROOT, relativeFilePath);
		if (!isEqualOrParent(filePath, APP_ROOT, !isLinux)) {
			return serveError(req, res, 400, `Bad request.`);
		}

		return serveFile(this._logService, req, res, filePath, headers);
	}

	private _getResourceURLTemplateAuthority(uri: URI): string | undefined {
		const index = uri.authority.indexOf('.');
		return index !== -1 ? uri.authority.substring(index + 1) : undefined;
	}

	/**
	 * Handle extension resources
	 */
	private async _handleWebExtensionResource(req: http.IncomingMessage, res: http.ServerResponse, parsedUrl: url.UrlWithParsedQuery): Promise<void> {
		if (!this._webExtensionResourceUrlTemplate) {
			return serveError(req, res, 500, 'No extension gallery service configured.');
		}

		// Strip `/web-extension-resource/` from the path
		const normalizedPathname = decodeURIComponent(parsedUrl.pathname!); // support paths that are uri-encoded (e.g. spaces => %20)
		const path = normalize(normalizedPathname.substr('/web-extension-resource/'.length));
		const uri = URI.parse(path).with({
			scheme: this._webExtensionResourceUrlTemplate.scheme,
			authority: path.substring(0, path.indexOf('/')),
			path: path.substring(path.indexOf('/') + 1)
		});

		if (this._getResourceURLTemplateAuthority(this._webExtensionResourceUrlTemplate) !== this._getResourceURLTemplateAuthority(uri)) {
			return serveError(req, res, 403, 'Request Forbidden');
		}

		const headers: IHeaders = {};
		const setRequestHeader = (header: string) => {
			const value = req.headers[header];
			if (value && (isString(value) || value[0])) {
				headers[header] = isString(value) ? value : value[0];
			} else if (header !== header.toLowerCase()) {
				setRequestHeader(header.toLowerCase());
			}
		};
		setRequestHeader('X-Client-Name');
		setRequestHeader('X-Client-Version');
		setRequestHeader('X-Machine-Id');
		setRequestHeader('X-Client-Commit');

		const context = await this._requestService.request({
			type: 'GET',
			url: uri.toString(true),
			headers
		}, CancellationToken.None);

		const status = context.res.statusCode || 500;
		if (status !== 200) {
			let text: string | null = null;
			try {
				text = await asText(context);
			} catch (error) {/* Ignore */ }
			return serveError(req, res, status, text || `Request failed with status ${status}`);
		}

		const responseHeaders: Record<string, string> = Object.create(null);
		const setResponseHeader = (header: string) => {
			const value = context.res.headers[header];
			if (value) {
				responseHeaders[header] = value;
			} else if (header !== header.toLowerCase()) {
				setResponseHeader(header.toLowerCase());
			}
		};
		setResponseHeader('Cache-Control');
		setResponseHeader('Content-Type');
		res.writeHead(200, responseHeaders);
		const buffer = await streamToBuffer(context.stream);
		return res.end(buffer.buffer);
	}

	/**
	 * Handle HTTP requests for /
	 */
	private async _handleRoot(req: http.IncomingMessage, res: http.ServerResponse, parsedUrl: url.UrlWithParsedQuery): Promise<void> {
		if (!req.headers.host) {
			return serveError(req, res, 400, `Bad request.`);
		}

		const queryConnectionToken = parsedUrl.query[connectionTokenQueryName];
		if (typeof queryConnectionToken === 'string') {
			// We got a connection token as a query parameter.
			// We want to have a clean URL, so we strip it
			const responseHeaders: Record<string, string> = Object.create(null);
			responseHeaders['Set-Cookie'] = cookie.serialize(
				connectionTokenCookieName,
				queryConnectionToken,
				{
					sameSite: 'lax',
					maxAge: 60 * 60 * 24 * 7 /* 1 week */
				}
			);

			const newQuery = Object.create(null);
			for (let key in parsedUrl.query) {
				if (key !== connectionTokenQueryName) {
					newQuery[key] = parsedUrl.query[key];
				}
			}
			const newLocation = url.format({ pathname: '/', query: newQuery });
			responseHeaders['Location'] = newLocation;

			res.writeHead(302, responseHeaders);
			return res.end();
		}

		const remoteAuthority = req.headers.host;

		function escapeAttribute(value: string): string {
			return value.replace(/"/g, '&quot;');
		}

		let _wrapWebWorkerExtHostInIframe: undefined | false = undefined;
		if (this._environmentService.driverHandle) {
			// integration tests run at a time when the built output is not yet published to the CDN
			// so we must disable the iframe wrapping because the iframe URL will give a 404
			_wrapWebWorkerExtHostInIframe = false;
		}

		const resolveWorkspaceURI = (defaultLocation?: string) => defaultLocation && URI.from({ scheme: Schemas.vscodeRemote, path: path.resolve(defaultLocation), authority: remoteAuthority });

		const filePath = FileAccess.asFileUri(this._environmentService.isBuilt ? 'vs/code/browser/workbench/workbench.html' : 'vs/code/browser/workbench/workbench-dev.html', require).fsPath;
		const authSessionInfo = !this._environmentService.isBuilt && this._environmentService.args['github-auth'] ? {
			id: generateUuid(),
			providerId: 'github',
			accessToken: this._environmentService.args['github-auth'],
			scopes: [['user:email'], ['repo']]
		} : undefined;
		const data = (await util.promisify(fs.readFile)(filePath)).toString()
			.replace('{{WORKBENCH_WEB_CONFIGURATION}}', escapeAttribute(JSON.stringify({
				remoteAuthority,
				_wrapWebWorkerExtHostInIframe,
				developmentOptions: { enableSmokeTestDriver: this._environmentService.driverHandle === 'web' ? true : undefined },
				settingsSyncOptions: !this._environmentService.isBuilt && this._environmentService.args['enable-sync'] ? { enabled: true } : undefined,
				enableWorkspaceTrust: !this._environmentService.args['disable-workspace-trust'],
				folderUri: resolveWorkspaceURI(this._environmentService.args['default-folder']),
				workspaceUri: resolveWorkspaceURI(this._environmentService.args['default-workspace']),
				productConfiguration: <Partial<IProductConfiguration>>{
					embedderIdentifier: 'server-distro',
					extensionsGallery: this._webExtensionResourceUrlTemplate ? {
						...this._productService.extensionsGallery,
						'resourceUrlTemplate': this._webExtensionResourceUrlTemplate.with({
							scheme: 'http',
							authority: remoteAuthority,
							path: `web-extension-resource/${this._webExtensionResourceUrlTemplate.authority}${this._webExtensionResourceUrlTemplate.path}`
						}).toString(true)
					} : undefined
				}
			})))
			.replace('{{WORKBENCH_AUTH_SESSION}}', () => authSessionInfo ? escapeAttribute(JSON.stringify(authSessionInfo)) : '');

		const cspDirectives = [
			'default-src \'self\';',
			'img-src \'self\' https: data: blob:;',
			'media-src \'self\';',
			`script-src 'self' 'unsafe-eval' ${this._getScriptCspHashes(data).join(' ')} 'sha256-fh3TwPMflhsEIpR8g1OYTIMVWhXTLcjQ9kh2tIpmv54=' http://${remoteAuthority};`, // the sha is the same as in src/vs/workbench/services/extensions/worker/webWorkerExtensionHostIframe.html
			'child-src \'self\';',
			`frame-src 'self' https://*.vscode-webview.net data:;`,
			'worker-src \'self\' data:;',
			'style-src \'self\' \'unsafe-inline\';',
			'connect-src \'self\' ws: wss: https:;',
			'font-src \'self\' blob:;',
			'manifest-src \'self\';'
		].join(' ');

		const headers: http.OutgoingHttpHeaders = {
			'Content-Type': 'text/html',
			'Content-Security-Policy': cspDirectives
		};
		if (this._connectionToken.type !== ServerConnectionTokenType.None) {
			// At this point we know the client has a valid cookie
			// and we want to set it prolong it to ensure that this
			// client is valid for another 1 week at least
			headers['Set-Cookie'] = cookie.serialize(
				connectionTokenCookieName,
				this._connectionToken.value,
				{
					sameSite: 'lax',
					maxAge: 60 * 60 * 24 * 7 /* 1 week */
				}
			);
		}

		res.writeHead(200, headers);
		return res.end(data);
	}

	private _getScriptCspHashes(content: string): string[] {
		// Compute the CSP hashes for line scripts. Uses regex
		// which means it isn't 100% good.
		const regex = /<script>([\s\S]+?)<\/script>/img;
		const result: string[] = [];
		let match: RegExpExecArray | null;
		while (match = regex.exec(content)) {
			const hasher = crypto.createHash('sha256');
			// This only works on Windows if we strip `\r` from `\r\n`.
			const script = match[1].replace(/\r\n/g, '\n');
			const hash = hasher
				.update(Buffer.from(script))
				.digest().toString('base64');

			result.push(`'sha256-${hash}'`);
		}
		return result;
	}

	/**
	 * Handle HTTP requests for /callback
	 */
	private async _handleCallback(res: http.ServerResponse): Promise<void> {
		const filePath = FileAccess.asFileUri('vs/code/browser/workbench/callback.html', require).fsPath;
		const data = (await util.promisify(fs.readFile)(filePath)).toString();
		const cspDirectives = [
			'default-src \'self\';',
			'img-src \'self\' https: data: blob:;',
			'media-src \'none\';',
			`script-src 'self' ${this._getScriptCspHashes(data).join(' ')};`,
			'style-src \'self\' \'unsafe-inline\';',
			'font-src \'self\' blob:;'
		].join(' ');

		res.writeHead(200, {
			'Content-Type': 'text/html',
			'Content-Security-Policy': cspDirectives
		});
		return res.end(data);
	}
}
