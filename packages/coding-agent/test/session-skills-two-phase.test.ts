import { afterEach, describe, expect, it } from "bun:test";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	getActiveSkills,
	resetActiveSkillsForTests,
	type Skill,
	setActiveSkills,
} from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

function skill(name: string): Skill {
	return {
		name,
		description: `${name} description`,
		filePath: `/tmp/${name}/SKILL.md`,
		baseDir: `/tmp/${name}`,
		source: "test:user",
	};
}

describe("AgentSession two-phase Skill runtime update", () => {
	let session: AgentSession | undefined;

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		resetActiveSkillsForTests();
	});

	function createSession(options: { failFor?: string } = {}): AgentSession {
		const initial = skill("initial");
		setActiveSkills([initial]);
		const rebuildSystemPrompt = async (
			_toolNames: string[],
			_tools: Map<string, AgentTool>,
			rebuildOptions?: { skills?: readonly Skill[] },
		) => {
			const names = rebuildOptions?.skills?.map(candidate => candidate.name) ?? [];
			if (options.failFor && names.includes(options.failFor)) throw new Error("candidate prompt failed");
			return { systemPrompt: [`skills:${names.join(",")}`] };
		};
		session = new AgentSession({
			agent: new Agent({
				initialState: { systemPrompt: ["skills:initial"], tools: [], messages: [] },
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
			skills: [initial],
			rebuildSystemPrompt,
		});
		return session;
	}

	it("prepares candidate Skills without changing runtime state, then commits synchronously", async () => {
		const current = createSession();
		let metadataUpdates = 0;
		current.subscribeCommandMetadataChanged(() => {
			metadataUpdates++;
		});

		const prepared = await current.prepareResolvedSkills([skill("candidate")], []);

		expect(prepared.systemPrompt).toEqual(["skills:candidate"]);
		expect(current.skills.map(item => item.name)).toEqual(["initial"]);
		expect(current.systemPrompt).toEqual(["skills:initial"]);
		expect(getActiveSkills().map(item => item.name)).toEqual(["initial"]);
		expect(metadataUpdates).toBe(0);

		const result = current.commitResolvedSkills(prepared);

		expect(result).toBeUndefined();
		expect(current.skills.map(item => item.name)).toEqual(["candidate"]);
		expect(current.systemPrompt).toEqual(["skills:candidate"]);
		expect(getActiveSkills().map(item => item.name)).toEqual(["candidate"]);
		expect(metadataUpdates).toBe(1);
	});

	it("keeps the current runtime unchanged when candidate prompt preparation fails", async () => {
		const current = createSession({ failFor: "invalid" });
		let metadataUpdates = 0;
		current.subscribeCommandMetadataChanged(() => {
			metadataUpdates++;
		});

		await expect(current.applyResolvedSkills([skill("invalid")], [])).rejects.toThrow("candidate prompt failed");

		expect(current.skills.map(item => item.name)).toEqual(["initial"]);
		expect(current.systemPrompt).toEqual(["skills:initial"]);
		expect(getActiveSkills().map(item => item.name)).toEqual(["initial"]);
		expect(metadataUpdates).toBe(0);
	});
});
