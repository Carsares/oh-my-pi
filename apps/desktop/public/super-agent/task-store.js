// Read-modify-write helper for the Agent Inbox task list persisted through the
// picot-config data plane (`read_super_agent_tasks` / `write_super_agent_tasks`).
//
// Dispatch runs asynchronously and must not clobber concurrent edits made by
// the Runtime panel, so every mutation re-reads the latest tasks, applies the
// updater to the matching task, and writes the whole list back.

import { normalizeSuperAgentTasks } from "./task-state.js";

export async function updateSuperAgentTask(call, taskId, updater) {
  if (typeof call !== "function") return null;
  const result = await call("read_super_agent_tasks");
  if (!result?.ok) throw new Error("Failed to read Agent Inbox tasks");
  const tasks = normalizeSuperAgentTasks(result.data?.tasks || []);
  const index = tasks.findIndex((task) => task.id === taskId);
  if (index < 0) return null;
  const next = updater(tasks[index]);
  if (!next) return null;
  tasks[index] = next;
  const write = await call("write_super_agent_tasks", { tasks });
  if (!write?.ok) throw new Error("Failed to persist Agent Inbox tasks");
  return next;
}
