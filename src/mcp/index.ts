import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../config/config.js";
import { initializeOrganizerMcpServer } from "./server.js";

const organizer = await initializeOrganizerMcpServer(loadConfig());
const { server } = organizer;
const closed = new Promise<void>((resolve) => {
  server.server.onclose = resolve;
});
await server.connect(new StdioServerTransport());
await closed;
await organizer.shutdown();
