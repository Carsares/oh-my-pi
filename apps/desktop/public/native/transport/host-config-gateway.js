// Root-page configuration gateway. Configuration data is owned by OMP but does
// not require a live session, so requests go through the Host's embedded OMP
// command instead of the session-bound `/picot-config` RPC bridge.
export class HostConfigGateway {
  #control;

  constructor(control) {
    this.#control = control;
  }

  async call(operation, params = {}) {
    if (operation === "open_external") {
      await this.#control.openExternal(params.url);
      return { ok: true };
    }
    return this.#control.configManagementRequest({ operation, params });
  }
}
