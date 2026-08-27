// ABOUTME: Controls the active session's Skill Profile through native OMP RPC.
// ABOUTME: Renders only server-provided memberStates and resolver outcomes; it never selects winners locally.

import { getLocale, onLocaleChange, t } from "../../i18n.js";
import { createIcon } from "../../icons.js";
import { enhanceSelect } from "../../ui/select-menu.js";
import {
  compactSkillPath,
  renderSkillPanelMessage,
  skillDisplayDescription,
  skillDisplayName,
  skillDisplayPath,
  skillElement,
} from "./skills-management-ui.js";
import { manageModalDialog } from "./skills-modal.js";

const SESSION_GROUPS = ["active", "shadowed", "disabled", "inactive", "unavailable"];
const SESSION_GROUP_LABELS = {
  active: "settings.skills.groupActive",
  shadowed: "settings.skills.groupConflicts",
  disabled: "settings.skills.groupDisabled",
  inactive: "settings.skills.groupInactive",
  unavailable: "settings.skills.groupUnavailable",
};
const SESSION_STATUS_LABELS = {
  active: "settings.skills.statusActive",
  shadowed: "settings.skills.statusShadowed",
  disabled: "settings.skills.statusDisabled",
  inactive: "settings.skills.statusInactive",
  unavailable: "settings.skills.statusUnavailable",
  available: "settings.skills.statusAvailable",
  missing: "settings.skills.statusMissing",
  invalid: "settings.skills.statusInvalid",
  eligible: "settings.skills.statusEligible",
  blocked: "settings.skills.statusBlocked",
  out_of_scope: "settings.skills.statusOutOfScope",
  unknown: "settings.skills.statusUnknown",
};

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

function profileCollections(profile) {
  return [profile?.baseCollection, ...(profile?.additionalCollections ?? [])].filter(Boolean);
}

function memberGroup(member) {
  if (member.availability !== "available" || member.eligibility !== "eligible") {
    return "unavailable";
  }
  return SESSION_GROUPS.includes(member.runtimeStatus) ? member.runtimeStatus : "inactive";
}

function previewHasChanges(value) {
  return Boolean(
    value &&
      [
        value.addedSkillIds,
        value.removedSkillIds,
        value.newConflictNames,
        value.winnerChanges,
      ].some((items) => (items?.length ?? 0) > 0),
  );
}

function statusLabel(status) {
  return t(SESSION_STATUS_LABELS[status] ?? SESSION_STATUS_LABELS.unknown);
}

function textButton(label, iconName, props = {}) {
  const button = skillElement("button", props);
  const icon = iconName ? createIcon(iconName, { size: 15 }) : null;
  if (icon) button.append(icon);
  button.append(document.createTextNode(label));
  return button;
}

function iconButton(label, iconName, props = {}) {
  const { dataset, ...attributes } = props;
  const button = skillElement("button", {
    ...attributes,
    "aria-label": label,
    title: label,
    dataset: { ...dataset, tooltip: label },
  });
  const icon = createIcon(iconName, { size: 15 });
  if (icon) button.append(icon);
  return button;
}

export function setupSessionSkillsPanel({ container, client, showError, showSuccess }) {
  let state = null;
  let collections = null;
  let catalog = null;
  let preview = null;
  let activation = null;
  let dialogRestore = null;
  let busy = false;
  let loadSequence = 0;
  let activeFilter = "all";
  let searchQuery = "";
  let sourcesExpanded = false;
  const expandedSkillIds = new Set();
  const unsubscribeLocale = onLocaleChange(() => render());

  function currentState() {
    return sessionState(state);
  }

  function versionContext() {
    const current = currentState();
    return {
      expectedActiveLeafId: current?.activeLeafId,
      expectedRevision: current?.profile?.revision ?? current?.revision,
    };
  }

  function entryForSkill(skillId, fallback) {
    return catalogEntries(catalog).find((entry) => entry.skillId === skillId) ?? fallback;
  }

  function nameForSkill(skillId) {
    const entry = entryForSkill(skillId);
    return skillDisplayName(entry) || skillId || "-";
  }

  function collectionNameForSkill(skillId, profile) {
    if (profile?.addedSkillIds?.includes(skillId)) return t("settings.skills.manualAddition");
    const source = profileCollections(profile).find((snapshot) =>
      snapshot.skillIds?.includes(skillId),
    );
    return source?.collectionName ?? source?.name ?? source?.collectionId ?? "";
  }

  function formatUpdatedAt(value) {
    if (!value) return "-";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    try {
      const locale = { en: "en-US", es: "es-ES", ja: "ja-JP", zh: "zh-CN" }[getLocale()];
      return new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
    } catch {
      return value;
    }
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
      activation = null;
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
      const nextPreview = await client.sessionSyncPreview();
      if (previewHasChanges(nextPreview)) {
        preview = nextPreview;
      } else {
        preview = null;
        showSuccess?.(t("settings.skills.syncUpToDate"));
      }
    } catch (error) {
      preview = null;
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

  function renderSourceRow(snapshot, action) {
    const name = snapshot?.collectionName ?? snapshot?.name ?? snapshot?.collectionId ?? "-";
    return skillElement("div", { class: "skill-session-source-row" }, [
      skillElement("div", { class: "skill-session-source-info" }, [
        skillElement("strong", { class: "skill-session-source-name", text: name }),
        skillElement("span", {
          class: "skill-session-source-meta",
          text: t("settings.skills.skillCount", { count: snapshot?.skillIds?.length ?? 0 }),
        }),
      ]),
      action,
    ]);
  }

  function renderSources(profile) {
    const selected = profileCollections(profile);
    const selectedIds = new Set(selected.map((snapshot) => snapshot.collectionId));

    const addSelect = skillElement(
      "select",
      {
        class: "ui-select",
        dataset: { sessionAddCollection: "" },
        "aria-label": t("settings.skills.chooseCollection"),
      },
      [
        skillElement("option", { value: "", text: t("settings.skills.chooseCollection") }),
        ...collectionOptions(null, selectedIds),
      ],
    );
    const confirmAddButton = textButton(t("settings.skills.addCollection"), null, {
      type: "button",
      class: "ui-button ui-button--sm ui-button--primary",
      disabled: true,
      onClick: () => {
        if (!addSelect.value) return;
        void mutate((context) =>
          client.sessionAddCollection({ ...context, collectionId: addSelect.value }),
        );
      },
    });
    const cancelAddButton = textButton(t("settings.installSkills.cancel"), null, {
      type: "button",
      class: "ui-button ui-button--sm ui-button--ghost",
    });
    const collectionEditor = skillElement(
      "div",
      {
        class: "skill-session-source-editor",
        dataset: { sessionCollectionEditor: "" },
        hidden: true,
      },
      [
        addSelect,
        skillElement("div", { class: "skill-session-source-editor-actions" }, [
          cancelAddButton,
          confirmAddButton,
        ]),
      ],
    );
    const showCollectionEditorButton = textButton(t("settings.skills.addCollection"), "plus", {
      type: "button",
      class: "ui-button ui-button--sm ui-button--ghost skill-session-add-collection",
      onClick: () => {
        collectionEditor.hidden = false;
        showCollectionEditorButton.hidden = true;
        collectionEditor.querySelector('[role="combobox"]')?.focus();
      },
    });
    cancelAddButton.addEventListener("click", () => {
      addSelect.value = "";
      addSelect.dispatchEvent(new Event("change", { bubbles: true }));
      collectionEditor.hidden = true;
      showCollectionEditorButton.hidden = false;
      showCollectionEditorButton.focus();
    });
    const updateAddAction = () => {
      confirmAddButton.disabled = busy || !addSelect.value;
    };
    addSelect.addEventListener("change", updateAddAction);
    updateAddAction();

    const closeButton = iconButton(t("settings.skills.closeSourceConfig"), "x", {
      type: "button",
      class: "ui-icon-button ui-icon-button--sm ui-icon-button--ghost skill-session-source-close",
      onClick: () => {
        sourcesExpanded = false;
        container.querySelector(".skill-session-layout")?.classList.remove("is-sources-open");
      },
    });
    return skillElement(
      "aside",
      {
        class: "skill-session-sources",
        "aria-label": t("settings.skills.sourceConfig"),
      },
      [
        skillElement("div", { class: "skill-session-source-heading" }, [
          skillElement("strong", { text: t("settings.skills.sourceConfig") }),
          closeButton,
        ]),
        skillElement("div", { class: "skill-session-source-list" }, [
          selected.length === 0
            ? skillElement("div", {
                class: "skill-session-source-empty",
                dataset: { sessionCollectionsEmpty: "" },
                role: "status",
                text: t("settings.skills.noCollectionsSelected"),
              })
            : null,
          ...selected.map((snapshot) => {
            const name = snapshot.collectionName ?? snapshot.name ?? snapshot.collectionId ?? "-";
            return renderSourceRow(
              snapshot,
              iconButton(t("settings.skills.removeCollectionNamed", { name }), "x", {
                type: "button",
                class: "ui-icon-button ui-icon-button--xs ui-icon-button--ghost",
                disabled: busy,
                dataset: { sessionRemoveCollection: "", collectionId: snapshot.collectionId },
                onClick: () =>
                  void mutate((context) =>
                    client.sessionRemoveCollection({
                      ...context,
                      collectionId: snapshot.collectionId,
                    }),
                  ),
              }),
            );
          }),
        ]),
        showCollectionEditorButton,
        collectionEditor,
      ],
    );
  }

  function renderStatus(status) {
    return skillElement(
      "span",
      { class: `ui-badge skill-session-status skill-session-status--${status}` },
      [
        skillElement("span", { class: "skill-session-status-dot", "aria-hidden": "true" }),
        statusLabel(status),
      ],
    );
  }

  function activationImpact(skillId) {
    const resolution = currentState()?.resolved?.resolutions?.find((candidate) =>
      candidate.candidateSkillIds?.includes(skillId),
    );
    return (resolution?.candidateSkillIds ?? [])
      .filter((candidateSkillId) => candidateSkillId !== skillId)
      .map((candidateSkillId) => ({
        skillId: candidateSkillId,
        name: nameForSkill(candidateSkillId),
      }));
  }

  function requestActivation(member, name) {
    const impact = activationImpact(member.skillId);
    if (impact.length === 0) {
      void mutate((context) => client.sessionActivate({ ...context, skillId: member.skillId }));
      return;
    }
    activation = { skillId: member.skillId, name, impact };
    dialogRestore = { type: "activation", skillId: member.skillId };
    render();
  }

  function renderMember(member, profile) {
    const entry = entryForSkill(member.skillId, member.entry);
    const name = skillDisplayName(entry) || member.name || member.skillId;
    const description = skillDisplayDescription(entry) || member.description || "";
    const path = skillDisplayPath(entry);
    const source = entry?.effectiveSource;
    const sourceName = collectionNameForSkill(member.skillId, profile);
    const sourceMetadata = [source?.providerId, source?.level, source?.discoveryKind]
      .filter(Boolean)
      .join(" · ");
    const summary = [sourceName || sourceMetadata, description].filter(Boolean).join(" · ");
    const group = memberGroup(member);
    const detailsId = `session-skill-details-${member.skillId}`;
    const expanded = expandedSkillIds.has(member.skillId);
    const details = skillElement(
      "div",
      { id: detailsId, class: "skill-session-member-details", hidden: !expanded },
      [
        path
          ? skillElement("div", { class: "skill-session-detail-row" }, [
              skillElement("span", {
                class: "skill-session-detail-label",
                text: t("settings.skills.skillPath"),
              }),
              skillElement("code", { text: compactSkillPath(path), title: path }),
            ])
          : null,
        sourceMetadata
          ? skillElement("div", { class: "skill-session-detail-row" }, [
              skillElement("span", {
                class: "skill-session-detail-label",
                text: t("settings.skills.skillProvider"),
              }),
              skillElement("span", { text: sourceMetadata }),
            ])
          : null,
        skillElement("div", { class: "skill-session-detail-row" }, [
          skillElement("span", { text: `availability: ${statusLabel(member.availability)}` }),
          skillElement("span", { text: `eligibility: ${statusLabel(member.eligibility)}` }),
        ]),
        (member.reasons?.length ?? 0) > 0
          ? skillElement(
              "ul",
              { class: "skill-session-reason-list" },
              member.reasons.map((reason) => skillElement("li", { text: reason })),
            )
          : null,
      ],
    );
    const expandButton = iconButton(
      t(expanded ? "settings.skills.hideSkillDetails" : "settings.skills.showSkillDetails"),
      "chevron-right",
      {
        type: "button",
        class: "ui-icon-button ui-icon-button--xs ui-icon-button--ghost skill-session-expand",
        "aria-controls": detailsId,
        "aria-expanded": expanded ? "true" : "false",
        onClick: () => {
          const nextExpanded = !expandedSkillIds.has(member.skillId);
          if (nextExpanded) expandedSkillIds.add(member.skillId);
          else expandedSkillIds.delete(member.skillId);
          details.hidden = !nextExpanded;
          expandButton.setAttribute("aria-expanded", nextExpanded ? "true" : "false");
          expandButton.setAttribute(
            "aria-label",
            t(
              nextExpanded
                ? "settings.skills.hideSkillDetails"
                : "settings.skills.showSkillDetails",
            ),
          );
          expandButton.title = expandButton.getAttribute("aria-label");
        },
      },
    );
    const actions = [renderStatus(group)];
    if (member.runtimeStatus === "disabled") {
      actions.push(
        textButton(t("settings.skills.restore"), null, {
          type: "button",
          class: "ui-button ui-button--sm ui-button--secondary",
          disabled: busy,
          onClick: () =>
            void mutate((context) =>
              client.sessionRestore({ ...context, skillId: member.skillId }),
            ),
        }),
      );
    } else {
      if (group !== "active" && group !== "unavailable") {
        actions.push(
          textButton(t("settings.skills.activate"), null, {
            type: "button",
            class: "ui-button ui-button--sm ui-button--secondary",
            disabled: busy,
            dataset: { sessionActivateSkill: "", skillId: member.skillId },
            onClick: () => requestActivation(member, name),
          }),
        );
      }
      actions.push(
        textButton(t("settings.skills.disable"), null, {
          type: "button",
          class: "ui-button ui-button--sm ui-button--ghost",
          disabled: busy,
          onClick: () =>
            void mutate((context) =>
              client.sessionDisable({ ...context, skillId: member.skillId }),
            ),
        }),
      );
    }
    const searchText = [
      name,
      description,
      path,
      sourceName,
      sourceMetadata,
      member.runtimeStatus,
      member.availability,
      member.eligibility,
      ...(member.reasons ?? []),
    ]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase();
    return skillElement(
      "article",
      {
        class: "skill-session-member",
        dataset: { skillId: member.skillId, sessionSearchText: searchText },
      },
      [
        skillElement("div", { class: "skill-session-member-summary" }, [
          skillElement("div", { class: "skill-session-member-main" }, [
            expandButton,
            skillElement("div", { class: "skill-session-member-copy" }, [
              skillElement("strong", { class: "skill-session-member-name", text: name }),
              summary
                ? skillElement("span", {
                    class: "skill-session-member-meta",
                    text: summary,
                    title: summary,
                  })
                : null,
            ]),
          ]),
          skillElement("div", { class: "skill-session-member-actions" }, actions),
        ]),
        details,
      ],
    );
  }

  function applyMemberFilters() {
    if (!container) return;
    const query = searchQuery.trim().toLocaleLowerCase();
    let visibleCount = 0;
    for (const group of container.querySelectorAll("[data-session-member-group]")) {
      const matchesStatus =
        activeFilter === "all" || group.dataset.sessionMemberGroup === activeFilter;
      let groupVisibleCount = 0;
      for (const member of group.querySelectorAll("[data-skill-id]")) {
        const matchesQuery = !query || member.dataset.sessionSearchText?.includes(query);
        member.hidden = !matchesStatus || !matchesQuery;
        if (!member.hidden) groupVisibleCount += 1;
      }
      group.hidden = groupVisibleCount === 0;
      visibleCount += groupVisibleCount;
    }
    const empty = container.querySelector("[data-session-member-empty]");
    if (empty) empty.hidden = visibleCount !== 0;
  }

  function renderMembers(current) {
    const profile = current?.profile;
    const members = current?.memberStates ?? [];
    const grouped = Object.fromEntries(SESSION_GROUPS.map((status) => [status, []]));
    for (const member of members) grouped[memberGroup(member)].push(member);
    const availableToAdd = catalogEntries(catalog).filter(
      (entry) => !members.some((member) => member.skillId === entry.skillId),
    );
    const addSelect = skillElement(
      "select",
      {
        class: "ui-select ui-select--sm skill-session-add-select",
        "aria-label": t("settings.skills.chooseSkill"),
      },
      [
        skillElement("option", { value: "", text: t("settings.skills.chooseSkill") }),
        ...availableToAdd.map((entry) =>
          skillElement("option", {
            value: entry.skillId,
            text: entry.name ?? entry.lastKnownName ?? entry.skillId,
          }),
        ),
      ],
    );
    const addButton = textButton(t("settings.skills.addSkill"), "plus", {
      type: "button",
      class: "ui-button ui-button--sm ui-button--primary",
      disabled: true,
      onClick: () => {
        if (!addSelect.value) return;
        void mutate((context) => client.sessionAdd({ ...context, skillId: addSelect.value }));
      },
    });
    const updateAddButton = () => {
      addButton.disabled = busy || !addSelect.value;
    };
    addSelect.addEventListener("change", updateAddButton);
    updateAddButton();
    const search = skillElement("input", {
      type: "search",
      class: "ui-input",
      value: searchQuery,
      placeholder: t("settings.skills.searchSessionSkills"),
      onInput: (event) => {
        searchQuery = event.currentTarget.value;
        applyMemberFilters();
      },
    });
    const searchIcon = createIcon("search", { size: 15 });
    const filters = ["all", ...SESSION_GROUPS].map((status) => {
      const count = status === "all" ? members.length : grouped[status].length;
      const label =
        status === "all"
          ? t("settings.skills.allMembers")
          : t(SESSION_STATUS_LABELS[status] ?? SESSION_STATUS_LABELS.unknown);
      return skillElement("button", {
        type: "button",
        class: `ui-button ui-button--sm ui-button--ghost skill-session-filter${activeFilter === status ? " is-active" : ""}`,
        text: `${label} ${count}`,
        dataset: { sessionStatusFilter: status },
        "aria-pressed": activeFilter === status ? "true" : "false",
        onClick: (event) => {
          activeFilter = status;
          for (const button of container.querySelectorAll("[data-session-status-filter]")) {
            const selected = button === event.currentTarget;
            button.classList.toggle("is-active", selected);
            button.setAttribute("aria-pressed", selected ? "true" : "false");
          }
          applyMemberFilters();
        },
      });
    });
    const mobileSources = textButton(
      t("settings.skills.sourceConfigSummary", {
        count: profileCollections(profile).length,
      }),
      "folder",
      {
        type: "button",
        class: "ui-button ui-button--secondary skill-session-mobile-sources",
        onClick: () => {
          sourcesExpanded = true;
          container.querySelector(".skill-session-layout")?.classList.add("is-sources-open");
          container.querySelector(".skill-session-source-close")?.focus();
        },
      },
    );
    return skillElement("main", { class: "skill-session-main" }, [
      mobileSources,
      skillElement("div", { class: "skill-session-toolbar" }, [
        skillElement("label", { class: "skill-session-search" }, [
          skillElement("span", {
            class: "skill-session-sr-only",
            text: t("settings.skills.searchSessionSkills"),
          }),
          searchIcon,
          search,
        ]),
        skillElement("div", { class: "skill-session-add-control" }, [addSelect, addButton]),
      ]),
      skillElement(
        "div",
        {
          class: "skill-session-filter-bar",
          "aria-label": t("settings.skills.filterSessionSkills"),
        },
        filters,
      ),
      ...SESSION_GROUPS.map((status) =>
        skillElement(
          "section",
          {
            class: `skill-session-member-group skill-session-member-group--${status}`,
            dataset: { sessionMemberGroup: status },
          },
          [
            skillElement("div", { class: "skill-session-group-heading" }, [
              skillElement("span", {
                class: `skill-session-group-dot skill-session-group-dot--${status}`,
                "aria-hidden": "true",
              }),
              skillElement("h3", {
                class: "skill-session-group-title",
                text: t(SESSION_GROUP_LABELS[status]),
              }),
              skillElement("span", {
                class: "skill-session-group-count",
                text: String(grouped[status].length),
              }),
            ]),
            skillElement(
              "div",
              { class: "skill-session-member-list" },
              grouped[status].map((member) => renderMember(member, profile)),
            ),
          ],
        ),
      ),
      skillElement("div", {
        class: "skill-management-message skill-session-member-empty",
        dataset: { sessionMemberEmpty: "" },
        hidden: true,
        role: "status",
        text: t("settings.skills.noMatchingSkills"),
      }),
    ]);
  }

  function closeDialog() {
    preview = null;
    activation = null;
    render();
  }

  function renderActivationDialog() {
    if (!activation) return null;
    const titleId = "session-skills-activation-title";
    const descriptionId = "session-skills-activation-description";
    const primary = textButton(t("settings.skills.confirmActivation"), null, {
      type: "button",
      class: "ui-button ui-button--primary",
      disabled: busy,
      dataset: { sessionDialogPrimary: "" },
      onClick: () =>
        void mutate((context) =>
          client.sessionActivate({ ...context, skillId: activation.skillId }),
        ),
    });
    const dialog = skillElement(
      "aside",
      {
        class: "skill-session-dialog skill-session-dialog--confirmation",
        role: "alertdialog",
        "aria-modal": "true",
        "aria-labelledby": titleId,
        "aria-describedby": descriptionId,
        dataset: { sessionDialog: "activation" },
      },
      [
        skillElement("div", { class: "skill-session-dialog-heading" }, [
          skillElement("h3", {
            id: titleId,
            class: "skill-session-dialog-title",
            text: t("settings.skills.activationTitle"),
          }),
          iconButton(t("settings.installSkills.cancel"), "x", {
            type: "button",
            class: "ui-icon-button ui-icon-button--sm ui-icon-button--ghost",
            disabled: busy,
            onClick: closeDialog,
          }),
        ]),
        skillElement("p", {
          id: descriptionId,
          class: "skill-session-dialog-description",
          text: t("settings.skills.activationDescription", {
            name: activation.name,
            count: activation.impact.length,
          }),
        }),
        skillElement(
          "div",
          { class: "skill-session-impact-list" },
          activation.impact.map((item) =>
            skillElement("div", { class: "skill-session-change-row" }, [
              skillElement("strong", { text: item.name }),
              skillElement("code", {
                text: compactSkillPath(skillDisplayPath(entryForSkill(item.skillId))),
              }),
            ]),
          ),
        ),
        skillElement("div", { class: "skill-session-dialog-actions" }, [
          textButton(t("settings.installSkills.cancel"), null, {
            type: "button",
            class: "ui-button ui-button--secondary",
            disabled: busy,
            onClick: closeDialog,
          }),
          primary,
        ]),
      ],
    );
    return skillElement(
      "div",
      {
        class: "skill-session-dialog-backdrop",
        onClick: (event) => {
          if (event.target === event.currentTarget && !busy) closeDialog();
        },
      },
      dialog,
    );
  }

  function renderChangeSection(label, rows) {
    if (rows.length === 0) return null;
    return skillElement("section", { class: "skill-session-change-section" }, [
      skillElement("h4", { class: "skill-session-change-title", text: label }),
      ...rows.map((row) => skillElement("div", { class: "skill-session-change-row" }, row)),
    ]);
  }

  function renderSyncDialog() {
    if (!preview) return null;
    const titleId = "session-skills-sync-title";
    const descriptionId = "session-skills-sync-description";
    const addedNames = (preview.addedSkillIds ?? []).map(nameForSkill);
    const removedNames = (preview.removedSkillIds ?? []).map(nameForSkill);
    const winnerRows = (preview.winnerChanges ?? []).map((change) => [
      skillElement("strong", { text: change.name }),
      skillElement("span", {
        text: `${nameForSkill(change.previousSkillId)} -> ${nameForSkill(change.nextSkillId)}`,
      }),
    ]);
    const primary = textButton(t("settings.skills.confirmSync"), null, {
      type: "button",
      class: "ui-button ui-button--primary",
      disabled: busy,
      dataset: { sessionDialogPrimary: "" },
      onClick: () => void commitSync(),
    });
    const dialog = skillElement(
      "aside",
      {
        class: "skill-session-dialog skill-session-dialog--sync",
        role: "dialog",
        "aria-modal": "true",
        "aria-labelledby": titleId,
        "aria-describedby": descriptionId,
        dataset: { sessionDialog: "sync" },
      },
      [
        skillElement("div", { class: "skill-session-dialog-heading" }, [
          skillElement("h3", {
            id: titleId,
            class: "skill-session-dialog-title",
            text: t("settings.skills.syncPreview"),
          }),
          iconButton(t("settings.installSkills.cancel"), "x", {
            type: "button",
            class: "ui-icon-button ui-icon-button--sm ui-icon-button--ghost",
            disabled: busy,
            onClick: closeDialog,
          }),
        ]),
        skillElement("p", {
          id: descriptionId,
          class: "skill-session-dialog-description",
          text: t("settings.skills.syncDescription"),
        }),
        skillElement("div", { class: "skill-session-sync-summary" }, [
          skillElement("span", {
            class: "skill-session-sync-count skill-session-sync-count--added",
            text: t("settings.skills.syncAddedCount", { count: addedNames.length }),
          }),
          skillElement("span", {
            class: "skill-session-sync-count skill-session-sync-count--removed",
            text: t("settings.skills.syncRemovedCount", { count: removedNames.length }),
          }),
          skillElement("span", {
            class: "skill-session-sync-count skill-session-sync-count--winner",
            text: t("settings.skills.syncWinnerCount", { count: winnerRows.length }),
          }),
        ]),
        renderChangeSection(
          t("settings.skills.syncAdded"),
          addedNames.map((name) => [skillElement("strong", { text: name })]),
        ),
        renderChangeSection(
          t("settings.skills.syncRemoved"),
          removedNames.map((name) => [skillElement("strong", { text: name })]),
        ),
        renderChangeSection(t("settings.skills.syncWinnerChanges"), winnerRows),
        renderChangeSection(
          t("settings.skills.syncConflicts"),
          (preview.newConflictNames ?? []).map((name) => [skillElement("strong", { text: name })]),
        ),
        skillElement("div", { class: "skill-session-dialog-actions" }, [
          textButton(t("settings.installSkills.cancel"), null, {
            type: "button",
            class: "ui-button ui-button--secondary",
            disabled: busy,
            onClick: closeDialog,
          }),
          primary,
        ]),
      ],
    );
    return skillElement(
      "div",
      {
        class: "skill-session-dialog-backdrop",
        onClick: (event) => {
          if (event.target === event.currentTarget && !busy) closeDialog();
        },
      },
      dialog,
    );
  }

  function renderHeader(current) {
    const grouped = Object.fromEntries(SESSION_GROUPS.map((status) => [status, 0]));
    for (const member of current?.memberStates ?? []) grouped[memberGroup(member)] += 1;
    const refreshButton = textButton(t("settings.skills.refresh"), "refresh-cw", {
      type: "button",
      class: "ui-button ui-button--ghost skill-session-refresh",
      title: t("settings.skills.refreshDescription"),
      disabled: busy,
      "aria-busy": busy ? "true" : undefined,
      onClick: () =>
        void mutate(() => client.sessionRefresh(), t("settings.skills.refreshComplete")),
    });
    const syncButton = textButton(t("settings.skills.sync"), "refresh", {
      type: "button",
      class: "ui-button ui-button--secondary",
      disabled: busy,
      "aria-busy": busy ? "true" : undefined,
      dataset: { sessionSync: "" },
      onClick: () => {
        dialogRestore = { type: "sync" };
        void loadPreview();
      },
    });
    return skillElement("header", { class: "skill-session-page-header" }, [
      skillElement("div", { class: "skill-session-title-block" }, [
        skillElement("div", { class: "skill-session-title-row" }, [
          skillElement("h2", {
            class: "skill-session-title",
            text: t("settings.skills.sessionMembers"),
          }),
          skillElement("span", {
            class: "skill-session-profile-meta",
            text: t("settings.skills.profileRevision", {
              revision: current.profile.revision,
              updatedAt: formatUpdatedAt(current.profile.updatedAt),
            }),
          }),
        ]),
        skillElement("div", { class: "skill-session-summary" }, [
          skillElement("span", { class: "skill-session-summary-item" }, [
            skillElement("span", {
              class: "skill-session-summary-dot skill-session-summary-dot--active",
              "aria-hidden": "true",
            }),
            skillElement("strong", { text: String(grouped.active) }),
            t("settings.skills.statusActive"),
          ]),
          skillElement("span", { class: "skill-session-summary-item" }, [
            skillElement("span", {
              class: "skill-session-summary-dot skill-session-summary-dot--shadowed",
              "aria-hidden": "true",
            }),
            skillElement("strong", { text: String(grouped.shadowed) }),
            t("settings.skills.groupConflicts"),
          ]),
          skillElement("span", { class: "skill-session-summary-item" }, [
            skillElement("span", {
              class: "skill-session-summary-dot skill-session-summary-dot--unavailable",
              "aria-hidden": "true",
            }),
            skillElement("strong", { text: String(grouped.unavailable) }),
            t("settings.skills.statusUnavailable"),
          ]),
        ]),
      ]),
      skillElement("div", { class: "skill-session-header-actions" }, [refreshButton, syncButton]),
    ]);
  }

  function resolveDialogOpener() {
    if (dialogRestore?.type === "sync") return container?.querySelector("[data-session-sync]");
    if (dialogRestore?.type === "activation") {
      return [...(container?.querySelectorAll("[data-session-activate-skill]") ?? [])].find(
        (button) => button.dataset.skillId === dialogRestore.skillId,
      );
    }
    return null;
  }

  function finishRender(scrollContainer, scrollTop) {
    for (const select of container.querySelectorAll("select.ui-select")) enhanceSelect(select);
    applyMemberFilters();
    if (scrollContainer) scrollContainer.scrollTop = scrollTop;
    const dialog = container.querySelector("[data-session-dialog]");
    if (dialog) {
      manageModalDialog(dialog, {
        initialFocus: dialog.querySelector("[data-session-dialog-primary]"),
        restoreFocusTo: resolveDialogOpener,
        inertRoot: document.body,
        owner: "session-skills",
        onCancel: busy ? undefined : closeDialog,
      });
    } else {
      const restoreTarget = busy ? null : resolveDialogOpener();
      manageModalDialog(null, { owner: "session-skills" });
      if (!busy) {
        restoreTarget?.focus();
        dialogRestore = null;
      }
    }
  }

  function render() {
    if (!container) return;
    const scrollContainer = container.closest(".settings-content");
    const scrollTop = scrollContainer?.scrollTop ?? 0;
    if (busy && !state) {
      manageModalDialog(null, { owner: "session-skills" });
      renderSkillPanelMessage(container, t("settings.skills.loading"), "loading");
      if (scrollContainer) scrollContainer.scrollTop = scrollTop;
      return;
    }
    const current = currentState();
    if (!current?.profile) {
      manageModalDialog(null, { owner: "session-skills" });
      renderSkillPanelMessage(container, t("settings.skills.sessionUnavailable"));
      if (scrollContainer) scrollContainer.scrollTop = scrollTop;
      return;
    }
    const modal = activation ? renderActivationDialog() : renderSyncDialog();
    const root = skillElement("div", { class: "skill-session-root" }, [
      renderHeader(current),
      skillElement(
        "div",
        { class: `skill-session-layout${sourcesExpanded ? " is-sources-open" : ""}` },
        [renderSources(current.profile), renderMembers(current)],
      ),
      modal,
    ]);
    container.replaceChildren(root);
    finishRender(scrollContainer, scrollTop);
  }

  return {
    activate: load,
    reload: load,
    destroy: () => {
      manageModalDialog(null, { owner: "session-skills" });
      unsubscribeLocale?.();
      container?.replaceChildren();
    },
  };
}
