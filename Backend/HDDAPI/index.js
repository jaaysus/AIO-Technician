import { execFile } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SMARTCTL_PATH = path.join(__dirname, "bin", "smartctl.exe");
const SERVER_PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// Execute smartctl with given arguments
function runSmartctl(args) {
	return new Promise((resolve, reject) => {
		execFile(SMARTCTL_PATH, args, { windowsHide: true }, (error, stdout, stderr) => {
			if (error) return reject(Object.assign(new Error("smartctl failed"), { error, stdout, stderr }));
			resolve({ stdout, stderr });
		});
	});
}

// Execute WMIC for logical disk space
function getDiskSpace() {
	return new Promise((resolve, reject) => {
		execFile("wmic", ["logicaldisk", "get", "deviceid,size,freespace", "/format:csv"], { windowsHide: true }, (error, stdout) => {
			if (error) return resolve([]);
			const lines = stdout.trim().split(/\r?\n/).slice(1); // skip header
			const volumes = [];
			for (const line of lines) {
				const parts = line.split(",");
				if (parts.length < 4) continue;
				const [, deviceId, freeStr, sizeStr] = parts;
				const free = Number(freeStr);
				const size = Number(sizeStr);
				if (!Number.isFinite(free) || !Number.isFinite(size) || size === 0) continue;
				const freeGB = +(free / 1024 ** 3).toFixed(2);
				const usedGB = +((size - free) / 1024 ** 3).toFixed(2);
				const usagePercent = +((usedGB / (size / 1024 ** 3)) * 100).toFixed(1);
				volumes.push({ DriveLetter: deviceId, FreeGB: freeGB, UsedGB: usedGB, UsagePercent: usagePercent });
			}
			resolve(volumes);
		});
	});
}

// Scan all devices
async function scanDevices() {
	const { stdout } = await runSmartctl(["--scan", "-j"]);
	const parsed = JSON.parse(stdout || "{}");
	return Array.isArray(parsed.devices) ? parsed.devices : [];
}

// Read SMART info for a single device
async function readSmartForDevice(name) {
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
			if (parsed && (parsed.model_name || parsed.serial_number || parsed?.device?.type)) return parsed;
		} catch (_) { /* try next */ }
	}
	return {};
}

// Safe number conversion
function toNumberSafe(value, fallback = 0) {
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
}

// Summarize SMART data
function summarizeSmart(json, deviceName) {
	const type = json?.device?.type || "unknown";
	const model = json?.model_name ?? json?.model_family ?? "";
	const serial = json?.serial_number ?? "";
	const hours = toNumberSafe(json?.power_on_time?.hours, 0);

	let writtenGB = 0;
	let healthPercent = undefined;
	let liveTempC = undefined;

	if (type === "nvme") {
		const log = json?.nvme_smart_health_information_log || {};
		writtenGB = Math.round(((toNumberSafe(log.data_units_written) * 512000) / (1024 ** 3)) * 100) / 100;
		healthPercent = Math.max(0, 100 - toNumberSafe(log.percentage_used));
		liveTempC = log.composite_temperature ? log.composite_temperature - 273 : undefined;
	} else {
		const attrs = json?.ata_smart_attributes?.table || [];
		const lbasAttr = attrs.find(a => (a?.id === 241 || a?.id === 242) && /Written/i.test(a?.name || ""));
		writtenGB = Math.round(((toNumberSafe(lbasAttr?.raw?.value) * 512) / (1024 ** 3)) * 100) / 100;

		const lifeAttr = attrs.find(a => a && (a.id === 231 || a.id === 202 || a.id === 177 || /Wear|Life|Percent/i.test(a.name || "")));
		if (lifeAttr && Number.isFinite(Number(lifeAttr.value))) healthPercent = Number(lifeAttr.value);
		else if (json?.smart_status?.passed === true) healthPercent = 100;
		else if (json?.smart_status?.passed === false) healthPercent = 0;

		const tempAttr = attrs.find(a => a?.id === 194);
		if (tempAttr) liveTempC = Number(tempAttr.raw?.value);
	}

	return {
		Device: deviceName,
		Type: type,
		Model: model,
		Serial: serial,
		HealthPercent: healthPercent,
		WrittenGB: writtenGB,
		PowerCycles: toNumberSafe(json?.power_cycle_count),
		PowerOnHours: hours,
		UnsafeShutdowns: toNumberSafe(json?.unsafe_shutdowns),
		DataUnitsRead: toNumberSafe(json?.nvme_smart_health_information_log?.data_units_read || 0),
		DataUnitsWritten: toNumberSafe(json?.nvme_smart_health_information_log?.data_units_written || 0),
		HostReadCommands: toNumberSafe(json?.nvme_smart_health_information_log?.host_reads || 0),
		HostWriteCommands: toNumberSafe(json?.nvme_smart_health_information_log?.host_writes || 0),
		ControllerBusyTimeMinutes: toNumberSafe(json?.nvme_smart_health_information_log?.controller_busy_time || 0),
		MediaDataIntegrityErrors: toNumberSafe(json?.media_and_data_integrity_errors),
		ErrorLogEntries: toNumberSafe(json?.number_of_error_information_log_entries),
		CompositeTemperatureK: json?.nvme_smart_health_information_log?.composite_temperature,
		LiveTemperatureC: liveTempC,
		CriticalWarning: json?.nvme_smart_health_information_log?.critical_warning || 0,
		AvailableSparePercent: toNumberSafe(json?.nvme_smart_health_information_log?.available_spare, 0),
		AvailableSpareThreshold: toNumberSafe(json?.nvme_smart_health_information_log?.available_spare_threshold, 0),
		PercentageUsed: toNumberSafe(json?.nvme_smart_health_information_log?.percentage_used, 0),
		WarningTempTimeMinutes: toNumberSafe(json?.nvme_smart_health_information_log?.warning_composite_temperature_time, 0),
		CriticalTempTimeMinutes: toNumberSafe(json?.nvme_smart_health_information_log?.critical_composite_temperature_time, 0)
	};
}

// Get summaries for all drives + disk space
// Get summaries for all drives + disk space
async function getAllDriveSummaries() {
	const [devices, volumes] = await Promise.all([scanDevices(), getDiskSpace()]);
	const summaries = [];

	for (const d of devices) {
		const name = d?.name;
		if (!name) continue;
		try {
			const j = await readSmartForDevice(name);
			if (!j || (!j.model_name && !j.serial_number && !j.smart_status && !j?.device?.type)) continue;
			const summary = summarizeSmart(j, name);
			summaries.push(summary);
		} catch (e) {
			summaries.push({ Device: name, error: true, message: String(e?.error?.message || e?.message || e) });
		}
	}

	return { Drives: summaries.sort((a, b) => String(a.Device).localeCompare(String(b.Device))), Volumes: volumes };
}


// Send JSON response
function sendJson(res, status, body) {
	const data = Buffer.from(JSON.stringify(body));
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": data.length,
		"Cache-Control": "no-store"
	});
	res.end(data);
}

// HTTP server
const server = http.createServer(async (req, res) => {
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type");

	if (req.method === "OPTIONS") {
		res.writeHead(204);
		return res.end();
	}

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
