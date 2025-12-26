#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
	CallToolRequestSchema,
	ErrorCode,
	ListToolsRequestSchema,
	McpError,
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';

import { GetArchivedUrlSchema, getArchivedUrl } from './tools/retrieve.js';
import { SaveUrlSchema, saveUrl } from './tools/save.js';
import { SearchArchivesSchema, searchArchives } from './tools/search.js';
import { CheckArchiveStatusSchema, checkArchiveStatus } from './tools/status.js';

// JSON Schemas for tools
const saveUrlJsonSchema = {
	type: 'object',
	properties: {
		url: { type: 'string', description: 'The URL to save to the Wayback Machine' }
	},
	required: ['url']
};

const getArchivedUrlJsonSchema = {
	type: 'object',
	properties: {
		url: { type: 'string', description: 'The URL to retrieve from the Wayback Machine' },
		timestamp: { type: 'string', description: 'Optional timestamp (YYYYMMDDhhmmss format)' }
	},
	required: ['url']
};

const searchArchivesJsonSchema = {
	type: 'object',
	properties: {
		url: { type: 'string', description: 'The URL to search archives for' },
		from: { type: 'string', description: 'Start date (YYYYMMDD format)' },
		to: { type: 'string', description: 'End date (YYYYMMDD format)' },
		limit: { type: 'number', description: 'Maximum number of results', default: 10 }
	},
	required: ['url']
};

const checkArchiveStatusJsonSchema = {
	type: 'object',
	properties: {
		url: { type: 'string', description: 'The URL to check archive status for' }
	},
	required: ['url']
};

const PORT = parseInt(process.env.PORT || '8081', 10);
const app = express();

app.use(express.json());

// Create MCP server
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
				inputSchema: saveUrlJsonSchema,
			},
			{
				name: 'get_archived_url',
				description: 'Retrieve an archived version of a URL',
				inputSchema: getArchivedUrlJsonSchema,
			},
			{
				name: 'search_archives',
				description: 'Search the Wayback Machine archives for a URL',
				inputSchema: searchArchivesJsonSchema,
			},
			{
				name: 'check_archive_status',
				description: 'Check if a URL has been archived',
				inputSchema: checkArchiveStatusJsonSchema,
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

// Create stateless transport (no session management)
const transport = new StreamableHTTPServerTransport({
	sessionIdGenerator: undefined,
});

// Connect server to transport
server.connect(transport);

// MCP endpoint
app.all('/mcp', async (req, res) => {
	try {
		await transport.handleRequest(req, res, req.body);
	} catch (error) {
		console.error('MCP request error:', error);
		if (!res.headersSent) {
			res.status(500).json({ error: 'Internal server error' });
		}
	}
});

// Health check
app.get('/health', (req, res) => {
	res.json({ status: 'ok' });
});

// Root endpoint
app.get('/', (req, res) => {
	res.json({
		name: 'mcp-wayback-machine',
		version: '1.0.0',
		endpoints: {
			mcp: '/mcp',
			health: '/health'
		}
	});
});

app.listen(PORT, '0.0.0.0', () => {
	console.log(`MCP Wayback Machine HTTP server running on port ${PORT}`);
});
