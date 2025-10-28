import { execFile } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SMARTCTL_PATH = path.join(__dirname, "bin", "smartctl.exe");
const SERVER_PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

function runSmartctl(args) {
	return new Promise((resolve, reject) => {
		execFile(SMARTCTL_PATH, args, { windowsHide: true }, (error, stdout, stderr) => {
			if (error) {
				return reject(Object.assign(new Error("smartctl failed"), { error, stdout, stderr }));
			}
			resolve({ stdout, stderr });
		});
	});
}

async function scanDevices() {
	const { stdout } = await runSmartctl(["--scan", "-j"]);
	const parsed = JSON.parse(stdout || "{}");
	return Array.isArray(parsed.devices) ? parsed.devices : [];
}

async function readSmartForDevice(name) {
	// Try plain first, then hints commonly needed for USB bridges/enclosures
	const argSets = [
		["-a", "-j", name],
		["-a", "-j", "-d", "sat", name],
		["-a", "-j", "-d", "sat,12", name],
		["-a", "-j", "-d", "scsi", name]
	];
	for (const args of argSets) {
		try {
			const { stdout } = await runSmartctl(args);
			const parsed = JSON.parse(stdout || "{}");
			if (parsed && (parsed.model_name || parsed.serial_number || parsed?.device?.type)) {
				return parsed;
			}
		} catch (_) {
			// try next
		}
	}
	return {};
}

function toNumberSafe(value, fallback = 0) {
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
}

function summarizeSmart(json, deviceName) {
	const type = json?.device?.type || "unknown";
	const model = json?.model_name ?? json?.model_family ?? "";
	const serial = json?.serial_number ?? "";
	const hours = toNumberSafe(json?.power_on_time?.hours, 0);

	let writtenGB = 0;
	let healthPercent = undefined;

	if (type === "nvme") {
		const duw = toNumberSafe(json?.nvme_smart_health_information_log?.data_units_written, 0);
		// NVMe spec: one data unit = 512,000 bytes
		writtenGB = Math.round(((duw * 512000) / (1024 * 1024 * 1024)) * 100) / 100;
		const used = toNumberSafe(json?.nvme_smart_health_information_log?.percentage_used, 0);
		healthPercent = Math.max(0, 100 - used);
	} else {
		const attrs = json?.ata_smart_attributes?.table || [];
		// Total LBAs Written usually attribute 241/242
		const lbasAttr = attrs.find(a => (a?.id === 241 || a?.id === 242) && /Written/i.test(a?.name || ""));
		const lbas = toNumberSafe(lbasAttr?.raw?.value, 0);
		writtenGB = Math.round(((lbas * 512) / (1024 * 1024 * 1024)) * 100) / 100;

		// Health/life left often in attributes 231, 202, 177 or name matches
		const lifeAttr = attrs.find(a => a && (a.id === 231 || a.id === 202 || a.id === 177 || /Wear|Life|Percent/i.test(a.name || "")));
		if (lifeAttr && Number.isFinite(Number(lifeAttr.value))) {
			healthPercent = Number(lifeAttr.value);
		} else if (json?.smart_status?.passed === true) {
			healthPercent = 100;
		} else if (json?.smart_status?.passed === false) {
			healthPercent = 0;
		}
	}

	return {
		Device: deviceName,
		Type: type,
		Model: model,
		Serial: serial,
		HealthPercent: healthPercent,
		PowerOnHours: hours,
		WrittenGB: writtenGB
	};
}

async function getAllDriveSummaries() {
	const devices = await scanDevices();
	const summaries = [];
	for (const d of devices) {
		const name = d?.name;
		if (!name) continue;
		try {
			const j = await readSmartForDevice(name);
			if (!j || (!j.model_name && !j.serial_number && !j.smart_status && !j?.device?.type)) {
				// skip meaningless/empty entries often seen with some USB bridges
				continue;
			}
			summaries.push(summarizeSmart(j, name));
		} catch (e) {
			summaries.push({ Device: name, error: true, message: String(e?.error?.message || e?.message || e) });
		}
	}
	return summaries.sort((a, b) => String(a.Device).localeCompare(String(b.Device)));
}

function sendJson(res, status, body) {
	const data = Buffer.from(JSON.stringify(body));
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": data.length,
		"Cache-Control": "no-store"
	});
	res.end(data);
}

const server = http.createServer(async (req, res) => {
	// Simple CORS for local use
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type");
	if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

	if (req.method === "GET" && (req.url === "/" || req.url === "/api/drives")) {
		try {
			const summaries = await getAllDriveSummaries();
			return sendJson(res, 200, summaries);
		} catch (e) {
			return sendJson(res, 500, { error: true, message: String(e?.message || e) });
		}
	}

	res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
	res.end("Not Found\n");
});

server.listen(SERVER_PORT, () => {
	console.log(`HDDAPI listening on http://localhost:${SERVER_PORT} (GET /api/drives)`);
});


