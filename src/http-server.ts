#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
	CallToolRequestSchema,
	ErrorCode,
	ListToolsRequestSchema,
	McpError,
} from '@modelcontextprotocol/sdk/types.js';
import express, { Request, Response } from 'express';
import { randomUUID } from 'crypto';

import { GetArchivedUrlSchema, getArchivedUrl } from './tools/retrieve.js';
import { SaveUrlSchema, saveUrl } from './tools/save.js';
import { SearchArchivesSchema, searchArchives } from './tools/search.js';
import { CheckArchiveStatusSchema, checkArchiveStatus } from './tools/status.js';

const PORT = parseInt(process.env.PORT || '8081', 10);
const app = express();

app.use(express.json());

// CORS middleware
app.use((req, res, next) => {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, mcp-session-id');
	res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');
	if (req.method === 'OPTIONS') {
		res.status(204).end();
		return;
	}
	next();
});

// Store transports by session ID
const transports = new Map<string, StreamableHTTPServerTransport>();

// Create MCP server
function createMcpServer(): Server {
	const server = new Server(
		{
			name: 'mcp-wayback-machine',
			version: '1.0.0',
		},
		{
			capabilities: {
				tools: {},
			},
		},
	);

	// Handle tool listing
	server.setRequestHandler(ListToolsRequestSchema, async () => {
		return {
			tools: [
				{
					name: 'save_url',
					description: 'Save a URL to the Wayback Machine',
					inputSchema: SaveUrlSchema,
				},
				{
					name: 'get_archived_url',
					description: 'Retrieve an archived version of a URL',
					inputSchema: GetArchivedUrlSchema,
				},
				{
					name: 'search_archives',
					description: 'Search the Wayback Machine archives for a URL',
					inputSchema: SearchArchivesSchema,
				},
				{
					name: 'check_archive_status',
					description: 'Check if a URL has been archived',
					inputSchema: CheckArchiveStatusSchema,
				},
			],
		};
	});

	// Handle tool execution
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const { name, arguments: args } = request.params;

		try {
			switch (name) {
				case 'save_url': {
					const input = SaveUrlSchema.parse(args);
					const result = await saveUrl(input);

					let text = result.message;
					if (result.archivedUrl) {
						text += `\n\nArchived URL: ${result.archivedUrl}`;
					}
					if (result.timestamp) {
						text += `\nTimestamp: ${result.timestamp}`;
					}
					if (result.jobId) {
						text += `\nJob ID: ${result.jobId}`;
					}

					return {
						content: [{ type: 'text', text }],
					};
				}

				case 'get_archived_url': {
					const input = GetArchivedUrlSchema.parse(args);
					const result = await getArchivedUrl(input);

					let text = result.message;
					if (result.archivedUrl) {
						text += `\n\nArchived URL: ${result.archivedUrl}`;
					}
					if (result.timestamp) {
						text += `\nTimestamp: ${result.timestamp}`;
					}
					if (result.available !== undefined) {
						text += `\nAvailable: ${result.available ? 'Yes' : 'No'}`;
					}

					return {
						content: [{ type: 'text', text }],
					};
				}

				case 'search_archives': {
					const input = SearchArchivesSchema.parse(args);
					const result = await searchArchives(input);

					let text = result.message;
					if (result.results && result.results.length > 0) {
						text += '\n\nResults:';
						for (const archive of result.results) {
							text += `\n\n- Date: ${archive.date}`;
							text += `\n  URL: ${archive.archivedUrl}`;
							text += `\n  Status: ${archive.statusCode}`;
							text += `\n  Type: ${archive.mimeType}`;
						}
					}

					return {
						content: [{ type: 'text', text }],
					};
				}

				case 'check_archive_status': {
					const input = CheckArchiveStatusSchema.parse(args);
					const result = await checkArchiveStatus(input);

					let text = result.message;
					if (result.isArchived) {
						if (result.firstCapture) {
							text += `\n\nFirst captured: ${result.firstCapture}`;
						}
						if (result.lastCapture) {
							text += `\nLast captured: ${result.lastCapture}`;
						}
						if (result.totalCaptures !== undefined) {
							text += `\nTotal captures: ${result.totalCaptures}`;
						}
						if (result.yearlyCaptures && Object.keys(result.yearlyCaptures).length > 0) {
							text += '\n\nCaptures by year:';
							for (const [year, count] of Object.entries(result.yearlyCaptures)) {
								text += `\n  ${year}: ${count}`;
							}
						}
					}

					return {
						content: [{ type: 'text', text }],
					};
				}

				default:
					throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
			}
		} catch (error) {
			if (error instanceof McpError) {
				throw error;
			}

			throw new McpError(
				ErrorCode.InternalError,
				error instanceof Error ? error.message : 'Unknown error occurred',
			);
		}
	});

	return server;
}

// MCP endpoint - handles all MCP communication
app.all('/mcp', async (req: Request, res: Response) => {
	const sessionId = req.headers['mcp-session-id'] as string | undefined;

	if (req.method === 'POST') {
		// Check for existing session
		let transport = sessionId ? transports.get(sessionId) : undefined;

		if (!transport) {
			// Create new session
			const newSessionId = randomUUID();
			transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: () => newSessionId,
			});
			transports.set(newSessionId, transport);

			const server = createMcpServer();
			await server.connect(transport);

			transport.onclose = () => {
				transports.delete(newSessionId);
			};
		}

		await transport.handleRequest(req, res);
	} else if (req.method === 'GET') {
		// SSE stream for server-to-client messages
		if (sessionId && transports.has(sessionId)) {
			const transport = transports.get(sessionId)!;
			await transport.handleRequest(req, res);
		} else {
			res.status(400).json({ error: 'Missing or invalid session ID' });
		}
	} else if (req.method === 'DELETE') {
		// Close session
		if (sessionId && transports.has(sessionId)) {
			const transport = transports.get(sessionId)!;
			await transport.close();
			transports.delete(sessionId);
			res.status(204).end();
		} else {
			res.status(404).json({ error: 'Session not found' });
		}
	} else {
		res.status(405).json({ error: 'Method not allowed' });
	}
});

// Health check
app.get('/health', (req, res) => {
	res.json({ status: 'ok' });
});

app.listen(PORT, () => {
	console.log(`MCP Wayback Machine HTTP server running on port ${PORT}`);
});
