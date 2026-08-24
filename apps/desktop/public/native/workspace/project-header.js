import { onLocaleChange, t } from "../../i18n.js";

/**
 * project-header — populates the chat header with workspace path and git
 * branch info fetched from the host data plane.
 *
 * Responsibilities:
 *  - Show the full workspace path in the #workspace-indicator label inside
 *    #file-sidebar-toggle.
 *  - Show the current git branch in the #git-branch-indicator label inside
 *    #diff-sidebar-toggle.
 *  - Both labels are hidden when data is unavailable.
 *  - Click handling stays on the toggle buttons in app.js: the path label is
 *    display-only, matching the git-branch label.
 */

/**
 * @param {object} options
 * @param {import('./data-gateway.js').HostDataGateway} options.data
 * @param {string} options.workspaceId
 */
export async function setupProjectHeader({ data, workspaceId } = {}) {
  const workspaceEl = document.getElementById("workspace-indicator");
  const filesToggleEl = workspaceEl?.closest("#file-sidebar-toggle");
  // #git-branch-indicator is the label span inside #diff-sidebar-toggle.
  // The toggle button itself carries the hidden class and is shown only when
  // git info is available.
  const branchLabelEl = document.getElementById("git-branch-indicator");
  const diffToggleEl = branchLabelEl?.closest("#diff-sidebar-toggle");
  if (!workspaceEl && !branchLabelEl) return;

  let info;
  try {
    const response = await data.workspaceInfo(workspaceId);
    info = response?.info;
  } catch {
    // Network or host error — leave pills hidden.
    return;
  }
  if (!info) return;

  if (workspaceEl && info.path) {
    workspaceEl.textContent = info.path;
    workspaceEl.classList.remove("hidden");
    if (filesToggleEl) {
      const applyLabels = () => {
        filesToggleEl.title = info.path;
        filesToggleEl.setAttribute(
          "aria-label",
          t("migrated.index.ariaLabel.openFilesPanel", { path: info.path }),
        );
      };
      applyLabels();
      // Keep the label current when the user switches language mid-session.
      onLocaleChange(applyLabels);
    }
  }

  if (diffToggleEl) {
    if (info.gitBranch) {
      if (branchLabelEl) branchLabelEl.textContent = info.gitBranch;
      diffToggleEl.title = t("git.changesWithBranch", { branch: info.gitBranch });
      diffToggleEl.classList.remove("hidden");
    } else {
      diffToggleEl.classList.add("hidden");
    }
  }
}
