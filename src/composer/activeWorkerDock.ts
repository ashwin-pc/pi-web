import { isMinimalDensity } from "../app/appearance.js";
import { iconElement } from "../app/icons.js";
import { createSessionRefChip } from "../app/sessionRefs.js";
import type { ActiveWorker, WaitingInfo } from "../sessions/lineage.js";

export type ActiveWorkerDockController = {
  refresh: () => void;
  destroy: () => void;
};

/** One owner for the existing worker strip, outside the focus-sensitive composer. */
export function createActiveWorkerDock(options: {
  container: HTMLElement;
  getWorkers: () => readonly ActiveWorker[];
  getWaiting: () => WaitingInfo | undefined;
  openSession: (sessionId: string, cwd?: string) => void;
}): ActiveWorkerDockController {
  const { container, getWorkers, getWaiting, openSession } = options;
  const pills = new Map<string, HTMLAnchorElement>();
  let minimalMode: boolean | undefined;
  let waitingLabel: HTMLSpanElement | undefined;

  function workersForMode(): readonly ActiveWorker[] {
    if (isMinimalDensity()) return getWorkers();
    return (getWaiting()?.sessions || []).map(session => ({ ...session, status: "running" as const }));
  }

  function updatePill(pill: HTMLAnchorElement, worker: ActiveWorker, minimal: boolean) {
    pill.href = `/?sessionId=${encodeURIComponent(worker.sessionId)}`;
    pill.title = minimal ? `Open ${worker.status} worker ${worker.name}` : `Open ${worker.name}`;
    if (minimal) pill.setAttribute("aria-label", pill.title);
    else pill.removeAttribute("aria-label");
    pill.dataset.workerName = worker.name;
    pill.dataset.workerStatus = worker.status;
    const dot = document.createElement("span");
    dot.className = minimal ? `activeWorkerDot activeWorkerDot--${worker.status}` : "waitingSessionSpinner";
    dot.setAttribute("aria-hidden", "true");
    if (minimal) {
      const name = document.createElement("span");
      name.className = "activeWorkerName";
      name.textContent = worker.name;
      const status = document.createElement("span");
      status.className = "activeWorkerStatus";
      status.textContent = worker.status;
      pill.replaceChildren(dot, name, status);
    } else pill.replaceChildren(dot, document.createTextNode(worker.name));
  }

  function refresh() {
    const minimal = isMinimalDensity();
    const workers = workersForMode();
    if (minimalMode !== minimal) {
      minimalMode = minimal;
      container.replaceChildren();
      pills.clear();
      waitingLabel = undefined;
      container.classList.toggle("activeWorkerDock", minimal);
      container.setAttribute("aria-label", minimal ? "Active spawned workers" : "Running spawned sessions");
    }

    if (!minimal && workers.length) {
      if (!waitingLabel) {
        waitingLabel = document.createElement("span");
        waitingLabel.className = "waitingSessionsLabel";
        waitingLabel.title = "This session stays usable while its spawned sessions run.";
        waitingLabel.append(iconElement("hourglass"), document.createTextNode(""));
        container.prepend(waitingLabel);
      }
      const label = `Waiting on ${workers.length} spawned session${workers.length === 1 ? "" : "s"}`;
      if (waitingLabel.lastChild!.textContent !== label) waitingLabel.lastChild!.textContent = label;
    } else if (waitingLabel) {
      waitingLabel.remove();
      waitingLabel = undefined;
    }

    const wanted = new Set(workers.map(worker => worker.sessionId));
    for (const [id, pill] of pills) {
      if (!wanted.has(id)) { pill.remove(); pills.delete(id); }
    }
    const offset = waitingLabel ? 1 : 0;
    workers.forEach((worker, index) => {
      let pill = pills.get(worker.sessionId);
      if (!pill) {
        pill = createSessionRefChip({ sessionId: worker.sessionId, name: worker.name }, {
          className: minimal ? "activeWorkerPill" : "waitingSessionChip",
          openSession: id => openSession(id, workersForMode().find(item => item.sessionId === id)?.cwd),
        });
        pill.dataset.sessionId = worker.sessionId;
        pills.set(worker.sessionId, pill);
      }
      if (pill.dataset.workerName !== worker.name || pill.dataset.workerStatus !== worker.status) updatePill(pill, worker, minimal);
      if (container.children[index + offset] !== pill) container.insertBefore(pill, container.children[index + offset] || null);
    });
    container.hidden = workers.length === 0;
  }

  return {
    refresh,
    destroy() {
      container.hidden = true;
      container.classList.remove("activeWorkerDock");
      container.replaceChildren();
      pills.clear();
    },
  };
}
