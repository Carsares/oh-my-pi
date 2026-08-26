/** Internal structured configuration operations used by Picot's Host. */

import * as os from "node:os";
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { initializeWithSettings } from "../capability";
import { ConfigManagementService, configOperationNeedsModelRegistry } from "../config/config-management-service";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { AgentRegistry } from "../registry/agent-registry";
import { createAgentSession } from "../sdk";
import { discoverAuthStorage } from "../session/auth-broker-config";
import type { AuthStorage } from "../session/auth-storage";
import { SessionManager } from "../session/session-manager";

type ConfigRequestPayload = {
	operation?: string;
	params?: Record<string, unknown>;
};

function requestError(message: string): never {
	throw new Error(`Invalid configuration request: ${message}`);
}

function parseRequest(value: string | undefined): ConfigRequestPayload {
	if (!value) requestError("--request is required");
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch (error) {
		requestError(`request is not valid JSON: ${String(error)}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) requestError("request must be an object");
	const request = parsed as ConfigRequestPayload;
	if (!request.operation) requestError("operation is required");
	if (
		request.params !== undefined &&
		(!request.params || typeof request.params !== "object" || Array.isArray(request.params))
	) {
		requestError("params must be an object");
	}
	return request;
}

export default class ConfigRequest extends Command {
	static description = "Run a structured Picot configuration request";
	static hidden = true;

	static flags = {
		request: Flags.string({ description: "JSON configuration request", required: true }),
		cwd: Flags.string({ description: "Project scope directory" }),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(ConfigRequest);
		const request = parseRequest(flags.request);
		const cwd = flags.cwd?.trim() || os.homedir();
		const settings = await Settings.loadIsolated({ cwd });
		initializeWithSettings(settings);
		let authStorage: AuthStorage | undefined;
		try {
			const needsRegistry = configOperationNeedsModelRegistry(request.operation!);
			authStorage = needsRegistry ? await discoverAuthStorage() : undefined;
			const modelRegistry = authStorage ? new ModelRegistry(authStorage, undefined, { settings }) : undefined;
			if (modelRegistry) await modelRegistry.refresh("offline");
			const service = new ConfigManagementService({
				modelRegistry,
				settings,
				cwd,
				createAgentSession,
				createSessionManager: () => SessionManager.inMemory(cwd),
				createAgentRegistry: () => new AgentRegistry(),
			});
			const result = await service.request(request.operation!, request.params ?? {});
			process.stdout.write(`${JSON.stringify(result)}\n`);
		} finally {
			authStorage?.close();
		}
	}
}
