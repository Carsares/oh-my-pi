const MUTATION_TYPES = new Set([
  "prompt",
  "steer",
  "follow_up",
  "compact",
  "bash",
  "branch",
  "clone",
  "navigate_tree",
  "set_model",
  "set_thinking_level",
  "set_auto_compaction",
  "set_auto_retry",
  "set_steering_mode",
  "set_follow_up_mode",
  "skills_catalog_rescan",
  "skills_collection_create",
  "skills_collection_update",
  "skills_collection_delete",
  "skills_collection_set_default",
  "session_skills_set_base_collection",
  "session_skills_add_collection",
  "session_skills_remove_collection",
  "session_skills_add",
  "session_skills_disable",
  "session_skills_restore",
  "session_skills_activate",
  "session_skills_sync",
  "session_skills_refresh",
]);

function assertTarget(target) {
  if (!target?.workspaceId || !target?.sessionId || !target?.instanceId) {
    throw new Error("Runtime target requires workspaceId, sessionId, and instanceId");
  }
}

export class RuntimeGateway {
  #adapter;
  #generation = 0;
  #listeners = new Set();
  #nextRequestId = 1;
  #pending = new Map();

  constructor(adapter) {
    this.#adapter = adapter;
    adapter.setReceiver((frame) => this.#receive(frame));
    adapter.setConnectionListener((connected) => this.#connectionChanged(connected));
  }

  request(command, target, options = {}) {
    try {
      assertTarget(target);
      if (MUTATION_TYPES.has(command?.type) && !options.idempotencyKey) {
        throw new Error(`Runtime mutation ${command.type} requires idempotencyKey`);
      }
      this.#adapter.subscribeTarget?.(target);
      return this.#send({
        type: "runtime_request",
        target,
        command,
        ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  // Send a host_request (control plane) operation for host-side state mutations.
  sendHostRequest(payload, requestIdOverride = null) {
    return this.#send(
      {
        type: "host_request",
        ...payload,
      },
      requestIdOverride,
    );
  }

  snapshot(sessionId) {
    if (!sessionId) return Promise.reject(new Error("snapshot requires sessionId"));
    return this.#send({ type: "runtime_snapshot_request", sessionId });
  }

  git(command, target) {
    try {
      assertTarget(target);
      this.#adapter.subscribeTarget?.(target);
      return this.#send(
        {
          type: command?.type === "git_ai_commit_message" ? "git_ai_commit_message" : "git_command",
          workspaceId: target.workspaceId,
          command: command?.type === "git_ai_commit_message" ? undefined : command,
        },
        command?.requestId,
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }

  capabilities(instanceId) {
    if (!instanceId) return Promise.reject(new Error("capabilities requires instanceId"));
    return this.#send({ type: "runtime_capabilities_request", instanceId });
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #send(frame, requestIdOverride = null) {
    const requestId = requestIdOverride || `client-${this.#nextRequestId++}`;
    const generation = this.#generation;
    return new Promise((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject, generation });
      try {
        this.#adapter.send({ ...frame, requestId });
      } catch (error) {
        this.#pending.delete(requestId);
        reject(error);
      }
    });
  }

  #receive(frame) {
    if (frame?.requestId) {
      const pending = this.#pending.get(frame.requestId);
      if (pending && pending.generation === this.#generation) {
        this.#pending.delete(frame.requestId);
        const error =
          frame.error ??
          (frame.type === "runtime_response" && frame.response?.success === false
            ? frame.response
            : null);
        if (error) {
          const detail =
            typeof error === "object" && error !== null ? (error.error ?? error) : error;
          const message =
            typeof detail === "string" ? detail : (detail.message ?? JSON.stringify(detail));
          const failure = new Error(message);
          if (typeof error === "object" && error !== null) {
            if ("code" in error) failure.code = error.code;
            if ("current" in error) failure.current = error.current;
            if (typeof detail === "object" && detail !== null) {
              if (!("code" in failure) && "code" in detail) failure.code = detail.code;
              if (!("current" in failure) && "current" in detail) failure.current = detail.current;
            }
          }
          pending.reject(failure);
        } else pending.resolve(frame);
        return;
      }
    }
    for (const listener of this.#listeners) listener(frame);
  }

  #connectionChanged(connected) {
    if (connected) return;
    this.#generation += 1;
    for (const pending of this.#pending.values()) {
      pending.reject(new Error("Runtime disconnected before the request completed"));
    }
    this.#pending.clear();
  }
}

export function createInMemoryRuntimeAdapter() {
  let connected = true;
  const receivers = new Set();
  const connectionListeners = new Set();
  const sent = [];
  return {
    send(frame) {
      if (!connected) throw new Error("Runtime adapter is disconnected");
      sent.push(structuredClone(frame));
    },
    setReceiver(listener) {
      receivers.add(listener);
      return () => receivers.delete(listener);
    },
    setConnectionListener(listener) {
      connectionListeners.add(listener);
      return () => connectionListeners.delete(listener);
    },
    takeSent() {
      return sent.shift();
    },
    receive(frame) {
      for (const receiver of receivers) receiver(structuredClone(frame));
    },
    disconnect() {
      connected = false;
      for (const listener of connectionListeners) listener(false);
    },
    reconnect() {
      connected = true;
      for (const listener of connectionListeners) listener(true);
    },
  };
}
