// ABOUTME: Generates model-backed titles through OMP's native title pipeline.
// ABOUTME: Keeps persisted transcript shaping isolated and testable.

import { type ExtensionContext, SessionManager, settings } from "@oh-my-pi/pi-coding-agent";
import { generateSessionTitle } from "@oh-my-pi/pi-coding-agent/utils/title-generator";

const MAX_TRANSCRIPT_LENGTH = 24_000;

type MessageEntry = {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
};

function messageText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        Boolean(block) &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("\n")
    .trim();
}

export function buildTitleTranscript(entries: MessageEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const role = entry.message?.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = messageText(entry.message?.content);
    if (!text) continue;
    lines.push(`${role === "user" ? "User" : "Assistant"}: ${text}`);
  }

  const transcript = lines.join("\n\n");
  if (transcript.length <= MAX_TRANSCRIPT_LENGTH) return transcript;
  return transcript.slice(0, MAX_TRANSCRIPT_LENGTH).trimEnd();
}

export type GenerateTitleRuntime = {
  model?: ExtensionContext["model"];
  modelRegistry: ExtensionContext["modelRegistry"];
  sessionId?: string;
  signal?: AbortSignal;
};

async function generateTitle(text: string, runtime: GenerateTitleRuntime): Promise<string> {
  const title = await generateSessionTitle(
    text,
    runtime.modelRegistry,
    settings,
    runtime.sessionId,
    runtime.model,
    undefined,
    undefined,
    runtime.signal,
  );
  if (!title) throw new Error("The model did not return a usable title");
  return title;
}

export async function generateTitleForSession(
  sessionFile: string,
  runtime: GenerateTitleRuntime,
): Promise<string> {
  const manager = await SessionManager.open(sessionFile);
  const transcript = buildTitleTranscript(manager.getEntries() as MessageEntry[]);
  if (!transcript.includes("User:")) throw new Error("The session has no user messages to name");
  return generateTitle(transcript, runtime);
}

export async function generateTitleForPrompt(
  prompt: string,
  runtime: GenerateTitleRuntime,
): Promise<string> {
  const text = prompt.trim();
  if (!text) throw new Error("The prompt is empty");
  return generateTitle(text, runtime);
}
