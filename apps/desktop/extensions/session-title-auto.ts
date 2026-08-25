// ABOUTME: Starts automatic session naming alongside the first main-agent turn.
// ABOUTME: Uses OMP's native title generator so naming never enters the live session queue.

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { generateTitleForPrompt } from "./session-title";

type AutomaticTitleOptions = {
  generateTitle?: (prompt: string, ctx: ExtensionContext) => Promise<string>;
};

async function generateWithNativeTitlePipeline(
  prompt: string,
  ctx: ExtensionContext,
): Promise<string> {
  return generateTitleForPrompt(prompt, {
    model: ctx.model,
    modelRegistry: ctx.modelRegistry,
    sessionId: ctx.sessionManager.getSessionId(),
  });
}

export function registerAutomaticSessionTitle(
  pi: ExtensionAPI,
  options: AutomaticTitleOptions = {},
): void {
  const generateTitle = options.generateTitle ?? generateWithNativeTitlePipeline;
  let attempted = false;
  let inFlight = false;

  pi.on("before_agent_start", (event, ctx) => {
    const prompt = event.prompt.trim();
    if (!prompt || attempted || inFlight || pi.getSessionName()) return;

    attempted = true;
    inFlight = true;
    void generateTitle(prompt, ctx)
      .then((title) => {
        // Preserve a manual or externally generated name chosen while the
        // independent title agent was still running.
        if (!pi.getSessionName()) pi.setSessionName(title);
      })
      .catch(() => {})
      .finally(() => {
        inFlight = false;
      });
  });
}
