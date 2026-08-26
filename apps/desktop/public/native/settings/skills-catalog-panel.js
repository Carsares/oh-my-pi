// ABOUTME: Browses and rescans the OMP-owned Skill Catalog in Settings.
// ABOUTME: Filters server entries for display but never derives runtime winners.

import { onLocaleChange, t } from "../../i18n.js";
import {
  compactSkillPath,
  renderSkillPanelMessage,
  skillDisplayName,
  skillDisplayPath,
  skillElement,
  skillStatusBadge,
} from "./skills-management-ui.js";

function catalogEntries(payload) {
  const state = payload?.state ?? payload?.catalog ?? payload;
  return state?.entries ?? payload?.items ?? [];
}

function nameCounts(entries) {
  const counts = new Map();
  for (const entry of entries) {
    const name = skillDisplayName(entry);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

export function setupSkillsCatalogPanel({ container, client, showError }) {
  let payload = null;
  let selectedEntry = null;
  let query = "";
  let status = "all";
  let provider = "all";
  let busy = false;
  let requestSequence = 0;
  let detailSequence = 0;
  const unsubscribeLocale = onLocaleChange(() => render());

  async function load() {
    const sequence = ++requestSequence;
    detailSequence += 1;
    busy = true;
    render();
    try {
      const nextPayload = await client.catalogList();
      if (sequence !== requestSequence) return;
      payload = nextPayload;
      selectedEntry = null;
    } catch (error) {
      if (sequence !== requestSequence) return;
      payload = null;
      showError?.(error);
    } finally {
      if (sequence === requestSequence) {
        busy = false;
        render();
      }
    }
  }

  async function rescan() {
    const sequence = ++requestSequence;
    detailSequence += 1;
    busy = true;
    render();
    try {
      let nextPayload = await client.catalogRescan();
      if (catalogEntries(nextPayload).length === 0) nextPayload = await client.catalogList();
      if (sequence !== requestSequence) return;
      payload = nextPayload;
      selectedEntry = null;
    } catch (error) {
      if (sequence !== requestSequence) return;
      showError?.(error);
    } finally {
      if (sequence === requestSequence) {
        busy = false;
        render();
      }
    }
  }

  async function showDetails(skillId) {
    const sequence = ++detailSequence;
    try {
      const result = await client.catalogGet(skillId);
      if (sequence !== detailSequence) return;
      selectedEntry = result?.entry ?? result;
      render();
    } catch (error) {
      if (sequence !== detailSequence) return;
      showError?.(error);
    }
  }

  function providerIds(entries) {
    return [
      ...new Set(
        entries
          .flatMap((entry) => (entry.sources ?? []).map((source) => source.providerId))
          .filter(Boolean),
      ),
    ].sort();
  }

  function filteredEntries(entries) {
    const text = query.trim().toLocaleLowerCase();
    return entries.filter((entry) => {
      if (status !== "all" && entry.status !== status) return false;
      if (
        provider !== "all" &&
        !(entry.sources ?? []).some((source) => source.providerId === provider)
      )
        return false;
      if (!text) return true;
      return [
        entry.name,
        entry.lastKnownName,
        entry.description,
        entry.lastKnownDescription,
        skillDisplayPath(entry),
      ]
        .filter(Boolean)
        .some((value) => String(value).toLocaleLowerCase().includes(text));
    });
  }

  function renderEntry(entry, duplicateCounts) {
    const name = skillDisplayName(entry);
    const description = entry.description ?? entry.lastKnownDescription ?? "";
    const path = skillDisplayPath(entry);
    const duplicateCount = duplicateCounts.get(name) ?? 0;
    return skillElement(
      "article",
      { class: "ui-card skill-catalog-entry", dataset: { skillId: entry.skillId } },
      [
        skillElement("div", { class: "skill-management-row" }, [
          skillElement("div", { class: "skill-management-grow" }, [
            skillElement("strong", { text: name }),
            description
              ? skillElement("p", { class: "skill-management-muted", text: description })
              : null,
          ]),
          skillStatusBadge(entry.status),
          duplicateCount > 1
            ? skillElement("span", {
                class: "ui-badge skill-management-status--shadowed",
                text: t("settings.skills.sameNamePaths", { count: duplicateCount }),
              })
            : null,
          skillElement("button", {
            type: "button",
            class: "ui-button ui-button--sm ui-button--ghost",
            text: t("settings.skills.details"),
            onClick: () => void showDetails(entry.skillId),
          }),
        ]),
        path
          ? skillElement("code", {
              class: "skill-management-path",
              text: compactSkillPath(path),
              title: path,
            })
          : null,
        skillElement(
          "div",
          { class: "skill-management-sources" },
          (entry.sources ?? []).map((source) =>
            skillElement("span", {
              class: "ui-badge",
              text: [source.providerId, source.level, source.discoveryKind]
                .filter(Boolean)
                .join(" · "),
            }),
          ),
        ),
      ],
    );
  }

  function renderDetails() {
    if (!selectedEntry) return null;
    return skillElement("section", { class: "ui-panel skill-catalog-detail" }, [
      skillElement("div", { class: "skill-management-row" }, [
        skillElement("strong", {
          text: selectedEntry.name ?? selectedEntry.lastKnownName ?? selectedEntry.skillId,
        }),
        skillElement("button", {
          type: "button",
          class: "ui-button ui-button--sm ui-button--ghost",
          text: t("settings.skills.closeDetails"),
          onClick: () => {
            selectedEntry = null;
            render();
          },
        }),
      ]),
      selectedEntry.parseError
        ? skillElement("p", { class: "skill-management-error", text: selectedEntry.parseError })
        : null,
      skillElement("code", {
        class: "skill-management-path",
        text: skillDisplayPath(selectedEntry),
      }),
      ...(selectedEntry.reasons ?? []).map((reason) =>
        skillElement("p", { class: "skill-management-muted", text: reason }),
      ),
    ]);
  }

  function render() {
    if (!container) return;
    if (busy && !payload) {
      renderSkillPanelMessage(container, t("settings.skills.loading"), "loading");
      return;
    }
    const entries = catalogEntries(payload);
    const filtered = filteredEntries(entries);
    const providerOptions = providerIds(entries);
    const duplicateCounts = nameCounts(entries);
    const queryInput = skillElement("input", {
      type: "search",
      class: "ui-input skill-management-search",
      placeholder: t("settings.skills.searchCatalog"),
      value: query,
      onInput: (event) => {
        query = event.currentTarget.value;
        render();
      },
    });
    const statusSelect = skillElement(
      "select",
      {
        class: "ui-select",
        onChange: (event) => {
          status = event.currentTarget.value;
          render();
        },
      },
      [
        skillElement("option", { value: "all", text: t("settings.skills.allStatuses") }),
        ...["available", "missing", "invalid"].map((value) =>
          skillElement("option", { value, text: value, selected: value === status }),
        ),
      ],
    );
    const providerSelect = skillElement(
      "select",
      {
        class: "ui-select",
        onChange: (event) => {
          provider = event.currentTarget.value;
          render();
        },
      },
      [
        skillElement("option", { value: "all", text: t("settings.skills.allProviders") }),
        ...providerOptions.map((value) =>
          skillElement("option", { value, text: value, selected: value === provider }),
        ),
      ],
    );
    const content = [
      skillElement("div", { class: "skill-management-toolbar ui-toolbar" }, [
        queryInput,
        statusSelect,
        providerSelect,
        skillElement("button", {
          type: "button",
          class: "ui-button ui-button--secondary",
          text: t("settings.skills.rescan"),
          disabled: busy,
          onClick: () => void rescan(),
        }),
      ]),
      renderDetails(),
      filtered.length
        ? skillElement(
            "div",
            { class: "skill-management-list" },
            filtered.map((entry) => renderEntry(entry, duplicateCounts)),
          )
        : skillElement("div", {
            class: "skill-management-message",
            text: t("settings.skills.empty"),
          }),
    ].filter(Boolean);
    container.replaceChildren(...content);
  }

  return {
    activate: load,
    reload: load,
    destroy: () => unsubscribeLocale?.(),
  };
}
