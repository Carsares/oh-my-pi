// ABOUTME: Controls the active session's Skill Profile through native OMP RPC.
// ABOUTME: Renders only server-provided memberStates and resolver outcomes; it never selects winners locally.

import { onLocaleChange, t } from "../../i18n.js";
import {
  compactSkillPath,
  renderSkillPanelMessage,
  skillDisplayDescription,
  skillDisplayName,
  skillDisplayPath,
  skillElement,
  skillStatusBadge,
} from "./skills-management-ui.js";

function sessionState(payload) {
  return payload?.state ?? payload;
}

function collectionViews(payload) {
  const state = payload?.state ?? payload;
  const listed = payload?.collections ?? state?.collections ?? [];
  const localAll = payload?.localAll ?? payload?.localAllCollection;
  return localAll && !listed.some((collection) => collection.collectionId === "local-all")
    ? [localAll, ...listed]
    : listed;
}

function catalogEntries(payload) {
  return (
    payload?.state?.entries ?? payload?.catalog?.entries ?? payload?.entries ?? payload?.items ?? []
  );
}

export function setupSessionSkillsPanel({ container, client, showError, showSuccess }) {
  let state = null;
  let collections = null;
  let catalog = null;
  let preview = null;
  let busy = false;
  let loadSequence = 0;
  const unsubscribeLocale = onLocaleChange(() => render());

  function versionContext() {
    const current = sessionState(state);
    return {
      expectedActiveLeafId: current?.activeLeafId,
      expectedRevision: current?.profile?.revision ?? current?.revision,
    };
  }

  async function load() {
    const sequence = ++loadSequence;
    busy = true;
    render();
    if (!client) {
      busy = false;
      render();
      return;
    }
    try {
      const [nextState, nextCollections, nextCatalog] = await Promise.all([
        client.sessionGet(),
        client.collectionsList(),
        client.catalogList(),
      ]);
      if (sequence !== loadSequence) return;
      state = nextState;
      collections = nextCollections;
      catalog = nextCatalog;
      preview = null;
    } catch (error) {
      if (sequence !== loadSequence) return;
      showError?.(error);
    } finally {
      if (sequence === loadSequence) {
        busy = false;
        render();
      }
    }
  }

  async function mutate(action, successMessage) {
    busy = true;
    render();
    try {
      await action(versionContext());
      showSuccess?.(successMessage ?? t("settings.skills.sessionSaved"));
      await load();
    } catch (error) {
      showError?.(error);
      await load();
    }
  }

  async function loadPreview() {
    busy = true;
    render();
    try {
      preview = await client.sessionSyncPreview();
    } catch (error) {
      showError?.(error);
    } finally {
      busy = false;
      render();
    }
  }

  async function commitSync() {
    if (!preview) return;
    await mutate(
      (context) =>
        client.sessionSync({
          ...context,
          expectedRevision: preview.profileRevision ?? context.expectedRevision,
          previewRevisions: {
            expectedProfileRevision: preview.profileRevision,
            expectedCollectionsRevision: preview.collectionsRevision,
            expectedCatalogRevision: preview.catalogRevision,
          },
        }),
      t("settings.skills.syncComplete"),
    );
  }

  function collectionOptions(selectedId, excludedIds = new Set()) {
    return collectionViews(collections)
      .filter((collection) => !excludedIds.has(collection.collectionId))
      .map((collection) =>
        skillElement("option", {
          value: collection.collectionId,
          text: collection.name ?? collection.collectionId,
          selected: collection.collectionId === selectedId,
        }),
      );
  }

  function renderCollections(profile) {
    const baseId = profile?.baseCollection?.collectionId;
    const additional = profile?.additionalCollections ?? [];
    const additionalIds = new Set(additional.map((snapshot) => snapshot.collectionId));
    const baseSelect = skillElement(
      "select",
      { class: "ui-select", dataset: { sessionBaseCollection: "" } },
      collectionOptions(baseId),
    );
    const addSelect = skillElement(
      "select",
      { class: "ui-select", dataset: { sessionAddCollection: "" } },
      [
        skillElement("option", { value: "", text: t("settings.skills.chooseCollection") }),
        ...collectionOptions(null, new Set([baseId, ...additionalIds])),
      ],
    );
    return skillElement("section", { class: "ui-panel skill-session-collections" }, [
      skillElement("h3", { text: t("settings.skills.sessionCollections") }),
      skillElement("div", { class: "skill-management-form-row" }, [
        skillElement("label", { class: "skill-management-field skill-management-grow" }, [
          skillElement("span", { text: t("settings.skills.baseCollection") }),
          baseSelect,
        ]),
        skillElement("button", {
          type: "button",
          class: "ui-button ui-button--secondary",
          text: t("settings.skills.changeBase"),
          disabled: busy,
          onClick: () =>
            void mutate((context) =>
              client.sessionSetBaseCollection({
                ...context,
                collectionId: baseSelect.value,
              }),
            ),
        }),
      ]),
      skillElement(
        "div",
        { class: "skill-management-list" },
        additional.map((snapshot) =>
          skillElement("div", { class: "skill-management-member" }, [
            skillElement("span", {
              text: snapshot.collectionName ?? snapshot.name ?? snapshot.collectionId,
            }),
            skillElement("button", {
              type: "button",
              class: "ui-button ui-button--sm ui-button--ghost",
              text: t("settings.skills.removeCollection"),
              disabled: busy,
              onClick: () =>
                void mutate((context) =>
                  client.sessionRemoveCollection({
                    ...context,
                    collectionId: snapshot.collectionId,
                  }),
                ),
            }),
          ]),
        ),
      ),
      skillElement("div", { class: "skill-management-form-row" }, [
        addSelect,
        skillElement("button", {
          type: "button",
          class: "ui-button ui-button--secondary",
          text: t("settings.skills.addCollection"),
          disabled: busy,
          onClick: () => {
            if (addSelect.value) {
              void mutate((context) =>
                client.sessionAddCollection({ ...context, collectionId: addSelect.value }),
              );
            }
          },
        }),
      ]),
    ]);
  }

  function renderMember(member) {
    const entry =
      catalogEntries(catalog).find((candidate) => candidate.skillId === member.skillId) ??
      member.entry;
    const name = skillDisplayName(entry) || member.name || member.skillId;
    const description = skillDisplayDescription(entry) || member.description || "";
    const path = skillDisplayPath(entry);
    const source = entry?.effectiveSource;
    const unavailable = member.availability !== "available" || member.eligibility !== "eligible";
    const actions = [];
    if (member.runtimeStatus === "disabled") {
      actions.push(
        skillElement("button", {
          type: "button",
          class: "ui-button ui-button--sm ui-button--secondary",
          text: t("settings.skills.restore"),
          disabled: busy,
          onClick: () =>
            void mutate((context) =>
              client.sessionRestore({ ...context, skillId: member.skillId }),
            ),
        }),
      );
    } else {
      actions.push(
        skillElement("button", {
          type: "button",
          class: "ui-button ui-button--sm ui-button--ghost",
          text: t("settings.skills.disable"),
          disabled: busy,
          onClick: () =>
            void mutate((context) =>
              client.sessionDisable({ ...context, skillId: member.skillId }),
            ),
        }),
      );
    }
    if (!unavailable && member.runtimeStatus !== "active") {
      actions.push(
        skillElement("button", {
          type: "button",
          class: "ui-button ui-button--sm ui-button--primary",
          text: t("settings.skills.activate"),
          disabled: busy,
          onClick: () =>
            void mutate((context) =>
              client.sessionActivate({ ...context, skillId: member.skillId }),
            ),
        }),
      );
    }
    return skillElement(
      "article",
      { class: "skill-management-member", dataset: { skillId: member.skillId } },
      [
        skillElement("div", { class: "skill-management-grow" }, [
          skillElement("div", { class: "skill-management-member-header" }, [
            skillElement("strong", { class: "skill-management-member-name", text: name }),
            path
              ? skillElement("code", {
                  class: "skill-management-path skill-management-member-path",
                  text: compactSkillPath(path),
                  title: path,
                })
              : null,
          ]),
          description
            ? skillElement("p", {
                class: "skill-management-muted skill-management-member-description",
                text: description,
                title: description,
              })
            : null,
          source
            ? skillElement("span", {
                class: "skill-management-muted",
                text: [source.providerId, source.level, source.discoveryKind]
                  .filter(Boolean)
                  .join(" · "),
              })
            : null,
          skillElement("div", { class: "skill-management-sources" }, [
            skillStatusBadge(member.runtimeStatus),
            skillStatusBadge(member.availability),
            skillStatusBadge(member.eligibility),
          ]),
          ...(member.reasons ?? []).map((reason) =>
            skillElement("p", { class: "skill-management-muted", text: reason }),
          ),
        ]),
        skillElement("div", { class: "skill-management-actions" }, actions),
      ],
    );
  }

  function renderMembers(current) {
    const members = current?.memberStates ?? [];
    const conflictCount = (current?.resolved?.resolutions ?? []).filter(
      (resolution) => (resolution.shadowedSkillIds?.length ?? 0) > 0,
    ).length;
    const availableToAdd = catalogEntries(catalog).filter(
      (entry) => !members.some((member) => member.skillId === entry.skillId),
    );
    const addSelect = skillElement("select", { class: "ui-select skill-management-grow" }, [
      skillElement("option", { value: "", text: t("settings.skills.chooseSkill") }),
      ...availableToAdd.map((entry) =>
        skillElement("option", {
          value: entry.skillId,
          text: entry.name ?? entry.lastKnownName ?? entry.skillId,
        }),
      ),
    ]);
    return skillElement("section", { class: "ui-panel skill-session-members" }, [
      skillElement("div", { class: "skill-management-row" }, [
        skillElement("h3", { text: t("settings.skills.sessionMembers") }),
        skillElement("div", { class: "skill-management-sources" }, [
          skillElement("span", { class: "ui-badge", text: String(members.length) }),
          conflictCount
            ? skillElement("span", {
                class: "ui-badge skill-management-status--shadowed",
                text: t("settings.skills.sessionConflictCount", { count: conflictCount }),
              })
            : null,
        ]),
      ]),
      skillElement("div", { class: "skill-management-form-row" }, [
        addSelect,
        skillElement("button", {
          type: "button",
          class: "ui-button ui-button--secondary",
          text: t("settings.skills.addSkill"),
          disabled: busy,
          onClick: () => {
            if (addSelect.value)
              void mutate((context) => client.sessionAdd({ ...context, skillId: addSelect.value }));
          },
        }),
      ]),
      skillElement("div", { class: "skill-management-list" }, members.map(renderMember)),
    ]);
  }

  function renderPreview() {
    if (!preview) return null;
    return skillElement("section", { class: "ui-panel skill-sync-preview" }, [
      skillElement("h3", { text: t("settings.skills.syncPreview") }),
      skillElement("p", {
        class: "skill-management-muted",
        text: t("settings.skills.syncSummary", {
          added: preview.addedSkillIds?.length ?? 0,
          removed: preview.removedSkillIds?.length ?? 0,
          conflicts: preview.newConflictNames?.length ?? 0,
        }),
      }),
      ...(preview.winnerChanges ?? []).map((change) =>
        skillElement("div", {
          class: "skill-management-member",
          text: `${change.name}: ${change.previousSkillId ?? "-"} → ${change.nextSkillId ?? "-"}`,
        }),
      ),
      skillElement("div", { class: "skill-management-actions" }, [
        skillElement("button", {
          type: "button",
          class: "ui-button ui-button--primary",
          text: t("settings.skills.confirmSync"),
          disabled: busy,
          onClick: () => void commitSync(),
        }),
        skillElement("button", {
          type: "button",
          class: "ui-button ui-button--secondary",
          text: t("settings.installSkills.cancel"),
          onClick: () => {
            preview = null;
            render();
          },
        }),
      ]),
    ]);
  }

  function render() {
    if (!container) return;
    if (busy && !state) {
      renderSkillPanelMessage(container, t("settings.skills.loading"), "loading");
      return;
    }
    const current = sessionState(state);
    if (!current?.profile) {
      renderSkillPanelMessage(container, t("settings.skills.sessionUnavailable"));
      return;
    }
    const content = [
      skillElement("div", { class: "skill-management-row skill-session-header" }, [
        skillElement("div", { class: "skill-management-grow" }, [
          skillElement("strong", { text: t("settings.skills.sessionProfile") }),
          skillElement("p", {
            class: "skill-management-muted",
            text: t("settings.skills.profileRevision", {
              revision: current.profile.revision,
              updatedAt: current.profile.updatedAt ?? "-",
            }),
          }),
        ]),
        skillElement("button", {
          type: "button",
          class: "ui-button ui-button--secondary",
          text: t("settings.skills.refresh"),
          disabled: busy,
          onClick: () => void mutate(() => client.sessionRefresh()),
        }),
        skillElement("button", {
          type: "button",
          class: "ui-button ui-button--primary",
          text: t("settings.skills.sync"),
          disabled: busy,
          onClick: () => void loadPreview(),
        }),
      ]),
      renderPreview(),
      renderCollections(current.profile),
      renderMembers(current),
    ].filter(Boolean);
    container.replaceChildren(...content);
  }

  return {
    activate: load,
    reload: load,
    destroy: () => unsubscribeLocale?.(),
  };
}
