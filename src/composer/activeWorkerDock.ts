import { createSessionRefChip } from "../app/sessionRefs.js";
import type { ActiveWorker } from "../sessions/lineage.js";

export type ActiveWorkerDockController = {
  refresh: () => void;
  destroy: () => void;
};

/** Generic linked session dependencies, rendered identically at every density. */
export function createActiveWorkerDock(options: {
  container: HTMLElement;
  getWorkers: () => readonly ActiveWorker[];
  openSession: (sessionId: string, cwd?: string) => void;
}): ActiveWorkerDockController {
  const { container, getWorkers, openSession } = options;
  const pills = new Map<string, HTMLAnchorElement>();
  container.classList.add("activeWorkerDock");
  container.setAttribute("aria-label", "Active linked sessions");

  function updatePill(pill: HTMLAnchorElement, worker: ActiveWorker) {
    pill.href = `/?sessionId=${encodeURIComponent(worker.sessionId)}`;
    pill.title = `Open running session ${worker.name}`;
    pill.setAttribute("aria-label", pill.title);
    pill.dataset.workerName = worker.name;
    pill.dataset.workerStatus = "running";
    const dot = document.createElement("span");
    dot.className = "activeWorkerDot";
    dot.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.className = "activeWorkerName";
    name.textContent = worker.name;
    pill.replaceChildren(dot, name);
  }

  function refresh() {
    const workers = getWorkers();
    const wanted = new Set(workers.map(worker => worker.sessionId));
    for (const [id, pill] of pills) {
      if (!wanted.has(id)) { pill.remove(); pills.delete(id); }
    }
    workers.forEach((worker, index) => {
      let pill = pills.get(worker.sessionId);
      if (!pill) {
        pill = createSessionRefChip({ sessionId: worker.sessionId, name: worker.name }, {
          className: "activeWorkerPill",
          openSession: id => openSession(id, getWorkers().find(item => item.sessionId === id)?.cwd),
        });
        pill.dataset.sessionId = worker.sessionId;
        pills.set(worker.sessionId, pill);
      }
      if (pill.dataset.workerName !== worker.name) updatePill(pill, worker);
      if (container.children[index] !== pill) container.insertBefore(pill, container.children[index] || null);
    });
    container.hidden = workers.length === 0;
  }

  return {
    refresh,
    destroy() {
      container.hidden = true;
      container.replaceChildren();
      pills.clear();
    },
  };
}
