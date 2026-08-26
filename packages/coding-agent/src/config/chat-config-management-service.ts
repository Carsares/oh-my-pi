import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils/dirs";
import {
	buildTelegramDmConfig,
	buildTelegramDoctorReport,
	getLatestTelegramUpdateId,
	getTelegramBotIdentity,
	observeTelegramPrivateDm,
	type TelegramBotIdentity,
	type TelegramWorkerStatusLike,
} from "./telegram-setup";

export type ChatConfigManagementResult = { ok: true; data?: unknown } | { ok: false; error: string };

export type ChatConfigManagementServiceOptions = {
	agentDir?: string;
};

const CHAT_CONFIG_MANAGEMENT_OPERATIONS = new Set([
	"read_chat_config",
	"write_chat_config",
	"telegram_validate",
	"telegram_bind",
	"telegram_doctor",
]);

export function isChatConfigManagementOperation(operation: string): boolean {
	return CHAT_CONFIG_MANAGEMENT_OPERATIONS.has(operation);
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

function asString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readConfigFile(filePath: string, fallback: string): { content: string; path: string } {
	const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : fallback;
	return { content, path: filePath };
}

function writeConfigFile(filePath: string, content: unknown): void {
	if (typeof content !== "string") throw new Error("content must be a string");
	try {
		JSON.parse(content);
	} catch (error) {
		throw new Error(`content is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content, "utf8");
}

function readJsonFile(filePath: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch {
		return undefined;
	}
}

function getChatWorkerStatuses(statusDir: string): TelegramWorkerStatusLike[] {
	let entries: string[];
	try {
		entries = fs.readdirSync(statusDir);
	} catch {
		return [];
	}
	return entries
		.filter(entry => entry.endsWith(".json"))
		.map(entry => readJsonFile(path.join(statusDir, entry)))
		.filter((value): value is TelegramWorkerStatusLike => Boolean(value && typeof value === "object"));
}

function telegramBotPayload(identity: TelegramBotIdentity) {
	return {
		id: identity.id,
		name: identity.name,
		username: identity.username,
		webUrl: identity.username ? `https://web.telegram.org/k/#@${identity.username}` : undefined,
		appUrl: identity.username ? `tg://resolve?domain=${identity.username}` : undefined,
	};
}

export class ChatConfigManagementService {
	readonly #configPath: string;
	readonly #workerStatusDir: string;

	constructor(options: ChatConfigManagementServiceOptions = {}) {
		const agentDir = options.agentDir ?? getAgentDir();
		this.#configPath = path.join(agentDir, "chat", "config.json");
		this.#workerStatusDir = path.join(agentDir, "chat", "worker-status");
	}

	async request(operation: string, params: Record<string, unknown>): Promise<ChatConfigManagementResult> {
		try {
			switch (operation) {
				case "read_chat_config":
					return { ok: true, data: readConfigFile(this.#configPath, "{}") };
				case "write_chat_config":
					writeConfigFile(this.#configPath, params.content);
					return { ok: true, data: { path: this.#configPath } };
				case "telegram_validate":
					return { ok: true, data: await this.#validateTelegram(params) };
				case "telegram_bind":
					return { ok: true, data: await this.#bindTelegram(params) };
				case "telegram_doctor":
					return { ok: true, data: await this.#buildTelegramDoctor() };
				default:
					throw new Error(`Unsupported chat configuration operation: ${operation}`);
			}
		} catch (error) {
			return { ok: false, error: errorMessage(error) };
		}
	}

	async #validateTelegram(params: Record<string, unknown>) {
		const botToken = asString(params.botToken);
		if (!botToken) throw new Error("botToken required");
		const identity = await getTelegramBotIdentity(botToken);
		const afterUpdateId = await getLatestTelegramUpdateId(botToken);
		return { bot: telegramBotPayload(identity), afterUpdateId };
	}

	async #bindTelegram(params: Record<string, unknown>) {
		const botToken = asString(params.botToken);
		if (!botToken) throw new Error("botToken required");
		const identity = await getTelegramBotIdentity(botToken);
		const dm = await observeTelegramPrivateDm(botToken, identity.id, {
			afterUpdateId: asNumber(params.afterUpdateId),
			timeoutMs: 90_000,
		});
		if (!dm) {
			throw new Error("Timed out waiting for a private Telegram message. Send /start to the bot and try again.");
		}

		const existingConfig = fs.existsSync(this.#configPath)
			? (JSON.parse(fs.readFileSync(this.#configPath, "utf8")) as Record<string, unknown>)
			: {};
		const nextConfig = buildTelegramDmConfig(existingConfig, { botToken, identity, dm });
		const content = `${JSON.stringify(nextConfig, null, "\t")}\n`;
		writeConfigFile(this.#configPath, content);
		return {
			content,
			bot: telegramBotPayload(identity),
			dm,
			path: this.#configPath,
		};
	}

	async #buildTelegramDoctor() {
		const config = fs.existsSync(this.#configPath)
			? (JSON.parse(fs.readFileSync(this.#configPath, "utf8")) as Record<string, unknown>)
			: {};
		const telegramAccount = Object.values((config as { accounts?: Record<string, unknown> }).accounts || {}).find(
			account =>
				typeof account === "object" &&
				account !== null &&
				(account as { service?: unknown }).service === "telegram",
		) as { botToken?: string } | undefined;
		let bot: TelegramBotIdentity | undefined;
		let botError: string | undefined;
		if (telegramAccount?.botToken) {
			try {
				bot = await getTelegramBotIdentity(telegramAccount.botToken);
			} catch (error) {
				botError = errorMessage(error);
			}
		}
		return {
			report: buildTelegramDoctorReport(config, {
				bot,
				botError,
				workerStatuses: getChatWorkerStatuses(this.#workerStatusDir),
			}),
		};
	}
}
