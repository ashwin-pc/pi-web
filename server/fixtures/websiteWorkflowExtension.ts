import type { PiWebExtensionAPI, PiWebPanelEvent, PiWebPanelView } from "@ashwin-pc/pi-web/extensions";

const PANEL_KEY = "website-launch-board";

function renderLaunchBoard(event?: PiWebPanelEvent): PiWebPanelView {
  const status = event?.action === "approve" ? "Launch brief approved for handoff." : "3 decisions ready for launch";
  return {
    title: "Launch decisions",
    html: `<style>
      .launchBoard { display: grid; gap: 14px; font-size: 13.5px; }
      .launchBoardSummary { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px; border: 1px solid color-mix(in srgb, var(--accent) 42%, var(--border)); border-radius: 12px; background: color-mix(in srgb, var(--accent) 8%, var(--panel-2)); }
      .launchBoardSummary strong { display: block; margin-bottom: 3px; color: var(--text); }
      .launchBoardSummary span, .launchDecisionMeta { color: var(--muted); font-size: 11.5px; }
      .launchDecisionList { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
      .launchDecision { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 10px; padding: 11px; border: 1px solid var(--border); border-radius: 11px; background: color-mix(in srgb, var(--panel-2) 62%, transparent); }
      .launchDecisionIcon { display: grid; place-items: center; width: 25px; height: 25px; border-radius: 8px; background: color-mix(in srgb, var(--accent) 16%, var(--panel-2)); color: var(--accent); font-weight: 700; }
      .launchDecisionTitle { margin-bottom: 4px; color: var(--text); font-weight: 650; line-height: 1.35; }
      .launchDecisionMeta { display: flex; flex-wrap: wrap; gap: 6px; }
      .launchDecisionTag { color: var(--accent); }
      .launchBoardActions { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
      .launchBoardStatus { color: var(--muted); font-size: 12px; }
    </style>
    <div class="launchBoard">
      <div class="launchBoardSummary">
        <div><strong>Spring launch brief</strong><span>Research synthesized · owners aligned</span></div>
        <span>Ready</span>
      </div>
      <ul class="launchDecisionList">
        <li class="launchDecision"><span class="launchDecisionIcon">1</span><div><div class="launchDecisionTitle">Lead with faster team handoffs</div><div class="launchDecisionMeta"><span>Owner: Maya</span><span class="launchDecisionTag">#positioning</span></div></div></li>
        <li class="launchDecision"><span class="launchDecisionIcon">2</span><div><div class="launchDecisionTitle">Use the interview proof points</div><div class="launchDecisionMeta"><span>Owner: Research</span><span class="launchDecisionTag">#evidence</span></div></div></li>
        <li class="launchDecision"><span class="launchDecisionIcon">3</span><div><div class="launchDecisionTitle">Ship the one-page visual brief</div><div class="launchDecisionMeta"><span>Owner: Studio</span><span class="launchDecisionTag">#deliverable</span></div></div></li>
      </ul>
      <div class="launchBoardActions"><span class="launchBoardStatus" role="status">${status}</span><button class="webPanelButton" type="button" data-web-panel-action="approve">Approve brief</button></div>
    </div>`,
  };
}

export default function websiteWorkflowExtension(pi: PiWebExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.web.contribute(PANEL_KEY, {
      slot: "panel",
      kind: "rendered",
      title: "Launch decisions",
      label: "Decisions",
      icon: "list-checks",
      render: renderLaunchBoard,
    });
    ctx.ui.web.contribute(`${PANEL_KEY}-launcher`, {
      slot: "fab",
      kind: "static",
      title: "Launch decisions",
      label: "Decisions",
      icon: "list-checks",
      opens: PANEL_KEY,
    });
  });
}
