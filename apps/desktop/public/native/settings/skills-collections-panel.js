// ABOUTME: Manages OMP-owned global Skill Collections from Settings.
// ABOUTME: Uses revision CAS and renders member diagnostics exactly as returned by OMP.

import { onLocaleChange, t } from "../../i18n.js";
import {
  compactSkillPath,
  renderSkillPanelMessage,
  skillDisplayName,
  skillDisplayPath,
  skillElement,
  skillStatusBadge,
} from "./skills-management-ui.js";

const LOCAL_ALL = "local-all";

function collectionsState(payload) {
  return (
    payload?.state ?? payload ?? { revision: 0, defaultCollectionId: LOCAL_ALL, collections: [] }
  );
}

function collectionViews(payload) {
  const state = collectionsState(payload);
  const listed = payload?.collections ?? state.collections ?? [];
  const localAll = payload?.localAll ?? payload?.localAllCollection;
  const views =
    localAll && !listed.some((collection) => collection.collectionId === LOCAL_ALL)
      ? [localAll, ...listed]
      : [...listed];
  if (!views.some((collection) => collection.collectionId === LOCAL_ALL)) {
    views.unshift({
      collectionId: LOCAL_ALL,
      name: t("settings.skills.localAll"),
      virtual: true,
      skillIds: [],
    });
  }
  return views;
}

function catalogEntries(payload) {
  return (
    payload?.state?.entries ?? payload?.catalog?.entries ?? payload?.entries ?? payload?.items ?? []
  );
}

export function setupSkillsCollectionsPanel({ container, client, showError, showSuccess }) {
  let payload = null;
  let catalog = null;
  let detail = null;
  let selectedId = LOCAL_ALL;
  let draft = null;
  let busy = false;
  let loadSequence = 0;
  let detailSequence = 0;
  const unsubscribeLocale = onLocaleChange(() => render());

  async function load(preferredId = selectedId) {
    const sequence = ++loadSequence;
    detailSequence += 1;
    busy = true;
    render();
    try {
      const [nextPayload, nextCatalog] = await Promise.all([
        client.collectionsList(),
        client.catalogList(),
      ]);
      const views = collectionViews(nextPayload);
      const nextSelectedId = views.some((collection) => collection.collectionId === preferredId)
        ? preferredId
        : (collectionsState(nextPayload).defaultCollectionId ?? LOCAL_ALL);
      const nextDetail = await client.collectionGet(nextSelectedId);
      if (sequence !== loadSequence) return;
      payload = nextPayload;
      catalog = nextCatalog;
      selectedId = nextSelectedId;
      detail = nextDetail;
      draft = null;
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

  async function loadDetail(collectionId, rerender = true) {
    const sequence = ++detailSequence;
    selectedId = collectionId;
    draft = null;
    try {
      const nextDetail = await client.collectionGet(collectionId);
      if (sequence !== detailSequence) return;
      detail = nextDetail;
    } catch (error) {
      if (sequence !== detailSequence) return;
      detail = null;
      showError?.(error);
    }
    if (rerender) render();
  }

  function currentCollection() {
    return (
      detail?.collection ??
      collectionViews(payload).find((collection) => collection.collectionId === selectedId)
    );
  }

  function catalogEntry(skillId) {
    return catalogEntries(catalog).find((entry) => entry.skillId === skillId);
  }

  function nameConflicts(skillIds) {
    const groups = new Map();
    for (const skillId of skillIds ?? []) {
      const entry = catalogEntry(skillId);
      const name = skillDisplayName(entry);
      if (!name) continue;
      const ids = groups.get(name) ?? [];
      ids.push(skillId);
      groups.set(name, ids);
    }
    return [...groups.entries()].filter(([, ids]) => ids.length > 1).map(([name]) => name);
  }

  function renderConflictWarning(skillIds) {
    const conflicts = nameConflicts(skillIds);
    if (!conflicts.length) return null;
    return skillElement("p", {
      class: "skill-management-warning",
      role: "status",
      text: t("settings.skills.collectionConflictSummary", {
        count: conflicts.length,
        names: conflicts.join(", "),
      }),
    });
  }

  function startCreate() {
    detail = null;
    selectedId = null;
    draft = { name: "", description: "", skillIds: [] };
    render();
  }

  function startEdit() {
    const collection = currentCollection();
    if (!collection || collection.collectionId === LOCAL_ALL) return;
    draft = {
      collectionId: collection.collectionId,
      name: collection.name ?? "",
      description: collection.description ?? "",
      skillIds: [...(collection.skillIds ?? [])],
    };
    render();
  }

  async function saveDraft() {
    if (!draft?.name.trim()) {
      showError?.(new Error(t("settings.skills.collectionNameRequired")));
      return;
    }
    busy = true;
    render();
    try {
      const revision = collectionsState(payload).revision;
      if (draft.collectionId) {
        await client.collectionUpdate({
          collectionId: draft.collectionId,
          patch: {
            name: draft.name.trim(),
            description: draft.description.trim() || null,
            skillIds: draft.skillIds,
          },
          expectedRevision: revision,
        });
        selectedId = draft.collectionId;
      } else {
        const result = await client.collectionCreate({
          name: draft.name.trim(),
          description: draft.description.trim() || undefined,
          skillIds: draft.skillIds,
          expectedRevision: revision,
        });
        selectedId = result.collection.collectionId;
      }
      showSuccess?.(t("settings.skills.collectionSaved"));
      await load(selectedId);
    } catch (error) {
      showError?.(error);
      await load(selectedId);
    }
  }

  async function setDefault(collectionId) {
    busy = true;
    render();
    try {
      await client.collectionSetDefault({
        collectionId,
        expectedRevision: collectionsState(payload).revision,
      });
      showSuccess?.(t("settings.skills.defaultCollectionSaved"));
      await load(collectionId);
    } catch (error) {
      showError?.(error);
      await load(collectionId);
    }
  }

  async function deleteCollection(collectionId) {
    if (!confirm(t("settings.skills.confirmDeleteCollection"))) return;
    busy = true;
    render();
    try {
      await client.collectionDelete({
        collectionId,
        expectedRevision: collectionsState(payload).revision,
      });
      showSuccess?.(t("settings.skills.collectionDeleted"));
      selectedId = collectionsState(payload).defaultCollectionId;
      await load(selectedId);
    } catch (error) {
      showError?.(error);
      await load();
    }
  }

  function renderCollectionList() {
    const state = collectionsState(payload);
    return skillElement("aside", { class: "skill-collections-list" }, [
      skillElement("div", { class: "skill-management-row" }, [
        skillElement("strong", { text: t("settings.skills.collections") }),
        skillElement("button", {
          type: "button",
          class: "ui-button ui-button--sm ui-button--primary",
          text: t("settings.skills.newCollection"),
          disabled: busy,
          onClick: startCreate,
        }),
      ]),
      ...collectionViews(payload).map((collection) =>
        skillElement(
          "button",
          {
            type: "button",
            class: `skill-collection-select${selectedId === collection.collectionId ? " active" : ""}`,
            dataset: { collectionId: collection.collectionId },
            disabled: busy,
            onClick: () => void loadDetail(collection.collectionId),
          },
          [
            skillElement("span", { text: collection.name ?? collection.collectionId }),
            state.defaultCollectionId === collection.collectionId
              ? skillElement("span", { class: "ui-badge", text: t("settings.skills.default") })
              : null,
          ],
        ),
      ),
    ]);
  }

  function renderMemberPicker() {
    const entries = catalogEntries(catalog);
    if (!entries.length)
      return skillElement("p", {
        class: "skill-management-muted",
        text: t("settings.skills.empty"),
      });
    return skillElement(
      "div",
      { class: "skill-collection-members" },
      entries.map((entry) => {
        const checked = draft.skillIds.includes(entry.skillId);
        const path = skillDisplayPath(entry);
        const description = entry.description ?? entry.lastKnownDescription ?? "";
        return skillElement("label", { class: "skill-collection-member-option" }, [
          skillElement("input", {
            type: "checkbox",
            checked,
            onChange: (event) => {
              if (event.currentTarget.checked)
                draft.skillIds = [...new Set([...draft.skillIds, entry.skillId])];
              else draft.skillIds = draft.skillIds.filter((skillId) => skillId !== entry.skillId);
              render();
            },
          }),
          skillElement("div", { class: "skill-collection-member-info" }, [
            skillElement("strong", {
              class: "skill-collection-member-name",
              text: skillDisplayName(entry),
            }),
            description
              ? skillElement("p", {
                  class: "skill-collection-member-description",
                  text: description,
                })
              : null,
            path
              ? skillElement("code", {
                  class: "skill-management-path",
                  text: compactSkillPath(path),
                  title: path,
                })
              : null,
          ]),
          skillElement("div", { class: "skill-collection-member-status" }, [
            skillStatusBadge(entry.status),
            entry.eligibility ? skillStatusBadge(entry.eligibility) : null,
          ]),
        ]);
      }),
    );
  }

  function renderEditor() {
    return skillElement("section", { class: "ui-panel skill-collection-editor" }, [
      skillElement("label", { class: "skill-management-field" }, [
        skillElement("span", { text: t("settings.skills.collectionName") }),
        skillElement("input", {
          class: "ui-input",
          value: draft.name,
          onInput: (event) => {
            draft.name = event.currentTarget.value;
          },
        }),
      ]),
      skillElement("label", { class: "skill-management-field" }, [
        skillElement("span", { text: t("settings.skills.collectionDescription") }),
        skillElement("textarea", {
          class: "ui-textarea",
          text: draft.description,
          onInput: (event) => {
            draft.description = event.currentTarget.value;
          },
        }),
      ]),
      skillElement("strong", { text: t("settings.skills.collectionMembers") }),
      renderConflictWarning(draft.skillIds),
      renderMemberPicker(),
      skillElement("div", { class: "skill-management-actions" }, [
        skillElement("button", {
          type: "button",
          class: "ui-button ui-button--primary",
          text: t("settings.skills.saveCollection"),
          disabled: busy,
          onClick: () => void saveDraft(),
        }),
        skillElement("button", {
          type: "button",
          class: "ui-button ui-button--secondary",
          text: t("settings.installSkills.cancel"),
          onClick: () => {
            draft = null;
            render();
          },
        }),
      ]),
    ]);
  }

  function renderDetail() {
    if (draft) return renderEditor();
    const collection = currentCollection();
    if (!collection)
      return skillElement("div", {
        class: "skill-management-message",
        text: t("settings.skills.selectCollection"),
      });
    const state = collectionsState(payload);
    return skillElement("section", { class: "ui-panel skill-collection-detail" }, [
      skillElement("div", { class: "skill-management-row" }, [
        skillElement("div", { class: "skill-management-grow" }, [
          skillElement("h3", { text: collection.name ?? collection.collectionId }),
          collection.description
            ? skillElement("p", { class: "skill-management-muted", text: collection.description })
            : null,
        ]),
        state.defaultCollectionId !== collection.collectionId
          ? skillElement("button", {
              type: "button",
              class: "ui-button ui-button--sm ui-button--secondary",
              text: t("settings.skills.setDefault"),
              disabled: busy,
              onClick: () => void setDefault(collection.collectionId),
            })
          : null,
      ]),
      renderConflictWarning(collection.skillIds),
      skillElement(
        "div",
        { class: "skill-management-list" },
        (collection.skillIds ?? []).map((skillId) => {
          const entry = catalogEntry(skillId);
          const path = skillDisplayPath(entry);
          return skillElement("div", { class: "skill-management-member" }, [
            skillElement("div", { class: "skill-management-grow" }, [
              skillElement("strong", { text: skillDisplayName(entry) || skillId }),
              path
                ? skillElement("code", {
                    class: "skill-management-path",
                    text: compactSkillPath(path),
                    title: path,
                  })
                : skillElement("code", { class: "skill-management-path", text: skillId }),
              ...(entry?.reasons ?? []).map((reason) =>
                skillElement("p", { class: "skill-management-muted", text: reason }),
              ),
            ]),
            skillElement("div", { class: "skill-management-sources" }, [
              entry ? skillStatusBadge(entry.status) : skillStatusBadge("missing"),
              entry?.eligibility ? skillStatusBadge(entry.eligibility) : null,
            ]),
          ]);
        }),
      ),
      collection.collectionId !== LOCAL_ALL
        ? skillElement("div", { class: "skill-management-actions" }, [
            skillElement("button", {
              type: "button",
              class: "ui-button ui-button--secondary",
              text: t("settings.skills.editCollection"),
              onClick: startEdit,
            }),
            skillElement("button", {
              type: "button",
              class: "ui-button ui-button--danger",
              text: t("settings.skills.deleteCollection"),
              disabled: state.defaultCollectionId === collection.collectionId || busy,
              onClick: () => void deleteCollection(collection.collectionId),
            }),
          ])
        : null,
    ]);
  }

  function render() {
    if (!container) return;
    if (busy && !payload) {
      renderSkillPanelMessage(container, t("settings.skills.loading"), "loading");
      return;
    }
    container.replaceChildren(
      skillElement("div", { class: "skill-collections-layout" }, [
        renderCollectionList(),
        renderDetail(),
      ]),
    );
  }

  return {
    activate: load,
    reload: load,
    destroy: () => unsubscribeLocale?.(),
  };
}
