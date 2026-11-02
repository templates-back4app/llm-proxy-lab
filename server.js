// File: server.js · Containers entry point: runs the deterministic provider SIMULATOR on PORT (default 8080).
// The Node buildpack starts this file by convention; the backend itself is Cloud Code, not this container.
import { startSimulator } from './scripts/simulator.mjs';
startSimulator({ port: Number(process.env.PORT) || 8080, quiet: false }).catch((e) => { console.error(e); process.exit(1); });
