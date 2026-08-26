import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ChatConfigManagementService } from "../../src/config/chat-config-management-service";

const tempDirs: string[] = [];

function createService() {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-chat-config-"));
	tempDirs.push(agentDir);
	return { agentDir, service: new ChatConfigManagementService({ agentDir }) };
}

function telegramResponse(result: unknown): Response {
	return new Response(JSON.stringify({ ok: true, result }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const tempDir of tempDirs.splice(0)) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("ChatConfigManagementService", () => {
	it("reads and writes the OMP-owned chat config without a runtime", async () => {
		const { agentDir, service } = createService();
		const configPath = path.join(agentDir, "chat", "config.json");

		await expect(service.request("read_chat_config", {})).resolves.toEqual({
			ok: true,
			data: { content: "{}", path: configPath },
		});
		await expect(service.request("write_chat_config", { content: '{"botName":"pi"}' })).resolves.toEqual({
			ok: true,
			data: { path: configPath },
		});
		await expect(service.request("read_chat_config", {})).resolves.toEqual({
			ok: true,
			data: { content: '{"botName":"pi"}', path: configPath },
		});
		await expect(service.request("write_chat_config", { content: "{" })).resolves.toMatchObject({
			ok: false,
			error: expect.stringContaining("content is not valid JSON"),
		});
		expect(fs.readFileSync(configPath, "utf8")).toBe('{"botName":"pi"}');
	});

	it("validates a Telegram token and preserves the setup response contract", async () => {
		const { service } = createService();
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (input: Parameters<typeof globalThis.fetch>[0]) => {
					const url = String(input);
					if (url.endsWith("/getMe")) {
						return telegramResponse({ id: 8965277673, first_name: "Picot", username: "picot_bot" });
					}
					if (url.endsWith("/getUpdates")) return telegramResponse([{ update_id: 42 }]);
					throw new Error(`Unexpected Telegram request: ${url}`);
				},
				{ preconnect: globalThis.fetch.preconnect },
			),
		);

		await expect(service.request("telegram_validate", { botToken: " token " })).resolves.toEqual({
			ok: true,
			data: {
				bot: {
					id: "8965277673",
					name: "Picot",
					username: "picot_bot",
					webUrl: "https://web.telegram.org/k/#@picot_bot",
					appUrl: "tg://resolve?domain=picot_bot",
				},
				afterUpdateId: 42,
			},
		});
	});

	it("binds the observed private DM and reports its live listener", async () => {
		const { agentDir, service } = createService();
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
					const url = String(input);
					if (url.endsWith("/getMe")) {
						return telegramResponse({ id: 8965277673, first_name: "Picot", username: "picot_bot" });
					}
					if (url.endsWith("/deleteWebhook")) return telegramResponse(true);
					if (url.endsWith("/getUpdates")) {
						const body = JSON.parse(String(init?.body)) as { offset?: number };
						expect(body.offset).toBe(43);
						return telegramResponse([
							{
								update_id: 43,
								message: {
									message_id: 7,
									chat: { id: 6085028519, type: "private", first_name: "Shixin" },
									from: { id: 6085028519, username: "shixin" },
								},
							},
						]);
					}
					throw new Error(`Unexpected Telegram request: ${url}`);
				},
				{ preconnect: globalThis.fetch.preconnect },
			),
		);

		const result = await service.request("telegram_bind", { botToken: "token", afterUpdateId: 42 });
		expect(result).toMatchObject({
			ok: true,
			data: {
				bot: { id: "8965277673", username: "picot_bot" },
				dm: { chatId: "6085028519", userId: "6085028519", userName: "shixin" },
				path: path.join(agentDir, "chat", "config.json"),
			},
		});

		const statusDir = path.join(agentDir, "chat", "worker-status");
		fs.mkdirSync(statusDir, { recursive: true });
		fs.writeFileSync(
			path.join(statusDir, "telegram.json"),
			JSON.stringify({ state: "connected", conversationId: "telegram-main/dm-main" }),
			"utf8",
		);
		await expect(service.request("telegram_doctor", {})).resolves.toMatchObject({
			ok: true,
			data: {
				report: {
					summary: "ready",
					configured: true,
					bot: { ok: true, username: "picot_bot" },
					dm: { ok: true, chatId: "6085028519" },
					security: { ok: true, allowedUserIds: ["6085028519"] },
					listener: { ok: true, conversationId: "telegram-main/dm-main" },
				},
			},
		});
	});
});
