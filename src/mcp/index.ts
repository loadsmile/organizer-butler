import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../config/config.js";
import { createOrganizerMcpServer } from "./server.js";

const { server } = createOrganizerMcpServer(loadConfig());
await server.connect(new StdioServerTransport());
