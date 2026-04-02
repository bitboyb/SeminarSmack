import {
  closeRoomChannel,
  getConfigStatus,
  openRoomChannel,
  sendBroadcast
} from "./supabase.js";

const COOLDOWN_MS = 25000;
const PRESENTER_HEARTBEAT_MS = 5000;
const SNAPSHOT_DEBOUNCE_MS = 180;
const DEVICE_STORAGE_KEY = "seminarsmack:device-id";
const ROOM_PREFIXES = [
  "loop",
  "gdev",
  "teach",
  "scope",
  "studio",
  "chalk",
  "spark",
  "forum"
];
const SUPPORTED_ACTIVITY_TYPES = new Set(["poll", "text", "quiz"]);
const SUBMISSION_LIMITS = {
  poll: 1,
  quiz: 1,
  text: 2
};

document.addEventListener("DOMContentLoaded", () => {
  installCopyDelegation();

  const page = document.body.dataset.page;

  if (page === "index") {
    initIndexPage();
    return;
  }

  if (page === "join" || page === "embed") {
    void initAudiencePage(page);
    return;
  }

  if (page === "present") {
    void initPresenterPage();
  }
});

function installCopyDelegation() {
  document.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-copy-target]");

    if (!button) {
      return;
    }

    const targetId = button.getAttribute("data-copy-target");
    const input = targetId ? document.getElementById(targetId) : null;
    const value =
      input && "value" in input ? String(input.value || "") : String(input?.textContent || "");

    if (!value) {
      return;
    }

    try {
      await copyText(value);
      flashButtonState(button, "Copied");
    } catch (error) {
      flashButtonState(button, "Copy failed");
    }
  });
}

function initIndexPage() {
  const roomInput = document.getElementById("builder-room");
  const sessionInput = document.getElementById("builder-session");
  const hostInput = document.getElementById("builder-host");
  const configStatus = document.getElementById("config-status");
  const randomizeButton = document.getElementById("builder-randomize");

  if (!roomInput || !sessionInput || !hostInput) {
    return;
  }

  const status = getConfigStatus();

  if (configStatus) {
    configStatus.textContent = status.ok
      ? "Realtime config loaded"
      : "Realtime config missing locally";
    configStatus.className = `config-pill ${status.ok ? "badge-open" : "badge-locked"}`;
  }

  roomInput.value = readOrFallback(roomInput.value, generateRoomCode());
  sessionInput.value = readOrFallback(sessionInput.value, "sample-session");
  hostInput.value = readOrFallback(hostInput.value, randomToken(18));

  const refreshLinks = () => {
    const room = sanitizeSimpleToken(roomInput.value) || generateRoomCode();
    const session = normalizeSessionName(sessionInput.value) || "sample-session";
    const host = sanitizeHostToken(hostInput.value) || randomToken(18);

    roomInput.value = room;
    sessionInput.value = session;
    hostInput.value = host;

    const presenterLink = document.getElementById("presenter-link");
    const joinLink = document.getElementById("join-link");
    const embedLink = document.getElementById("embed-link");
    const secureEmbedLink = document.getElementById("secure-embed-link");

    if (presenterLink) {
      presenterLink.value = buildPageUrl("present", { room, session, host });
    }

    if (joinLink) {
      joinLink.value = buildPageUrl("join", { room, session });
    }

    if (embedLink) {
      embedLink.value = buildPageUrl("embed", { room, session });
    }

    if (secureEmbedLink) {
      secureEmbedLink.value = buildPageUrl("embed", { room, session, host });
    }
  };

  roomInput.addEventListener("input", refreshLinks);
  sessionInput.addEventListener("input", refreshLinks);
  hostInput.addEventListener("input", refreshLinks);
  randomizeButton?.addEventListener("click", () => {
    roomInput.value = generateRoomCode();
    hostInput.value = randomToken(18);
    refreshLinks();
  });

  refreshLinks();
}

async function initAudiencePage(page) {
  const params = new URLSearchParams(window.location.search);
  const room = sanitizeSimpleToken(params.get("room"));
  const sessionParam = normalizeSessionName(params.get("session"));
  const hostToken = sanitizeHostToken(params.get("host"));
  const runtime = {
    page,
    room,
    sessionParam,
    hostToken,
    deviceId: getOrCreateDeviceId(),
    channel: null,
    client: null,
    session: null,
    sessionHash: "",
    sessionSource: sessionParam ? `${sessionParam}.json` : "not loaded",
    sharedState: null,
    connectionLabel: "Not connected",
    connectionTone: "muted",
    textDraft: "",
    bannerMessage: "",
    bannerTone: "info",
    submissionStoreKey: buildSubmissionStoreKey(room, sessionParam || "default")
  };

  if (!room || !sessionParam) {
    runtime.bannerMessage = "Add both ?room= and ?session= to the URL to join a live room.";
    runtime.bannerTone = "warning";
    renderAudience(runtime);
    return;
  }

  const loadedSession = await loadSessionFromFile(sessionParam);

  if (loadedSession.ok) {
    runtime.session = loadedSession.session;
    runtime.sessionHash = hashString(stableStringify(loadedSession.session));
    runtime.sessionSource = loadedSession.sourceLabel;
    runtime.sharedState = createPublicState(runtime.session);
    runtime.submissionStoreKey = buildSubmissionStoreKey(room, runtime.sessionHash);
  } else {
    runtime.bannerMessage =
      "Could not load the session JSON from /docs/sessions/. Waiting for the presenter to publish session state.";
    runtime.bannerTone = "warning";
  }

  const configStatus = getConfigStatus();

  if (!configStatus.ok) {
    runtime.connectionLabel = "Realtime unavailable";
    runtime.connectionTone = "warning";
    if (!runtime.bannerMessage) {
      runtime.bannerMessage =
        "Realtime is disabled until docs/config.js is populated locally or generated during GitHub Pages deployment.";
      runtime.bannerTone = "warning";
    }
    renderAudience(runtime);
    return;
  }

  renderAudience(runtime);

  try {
    const { channel, client } = await openRoomChannel(room, {
      activity_changed: async (payload) => {
        const accepted = await verifyEventIfNeeded(runtime, "activity_changed", payload);
        if (!accepted || !runtime.session || !runtime.sharedState) {
          return;
        }

        const nextRevision = Number(payload.revision) || 0;
        if (nextRevision < runtime.sharedState.revision) {
          return;
        }

        const nextIndex = clampIndex(
          Number(payload.currentActivityIndex),
          runtime.session.activities.length
        );
        runtime.sharedState.currentActivityIndex = nextIndex;
        runtime.sharedState.submissionsLocked = Boolean(payload.submissionsLocked);
        runtime.sharedState.revision = nextRevision;
        renderAudience(runtime);
      },
      session_reset: async (payload) => {
        const accepted = await verifyEventIfNeeded(runtime, "session_reset", payload);
        if (!accepted || !runtime.session || !runtime.sharedState) {
          return;
        }

        const nextRevision = Number(payload.revision) || 0;
        if (nextRevision < runtime.sharedState.revision) {
          return;
        }

        const activity = getActivityById(runtime.session, payload.activityId);
        if (!activity) {
          return;
        }

        const state = runtime.sharedState.activityStates[activity.id];
        state.counts = Array.isArray(activity.options) ? activity.options.map(() => 0) : [];
        state.texts = [];
        state.resetCount = Number(payload.resetCount) || state.resetCount + 1;
        runtime.sharedState.revision = nextRevision;
        resetLocalSubmissionEntry(runtime, activity.id, state.resetCount);
        renderAudience(runtime);
      },
      submissions_locked: async (payload) => {
        const accepted = await verifyEventIfNeeded(runtime, "submissions_locked", payload);
        if (!accepted || !runtime.sharedState) {
          return;
        }

        const nextRevision = Number(payload.revision) || 0;
        if (nextRevision < runtime.sharedState.revision) {
          return;
        }

        runtime.sharedState.submissionsLocked = Boolean(payload.locked);
        runtime.sharedState.revision = nextRevision;
        renderAudience(runtime);
      },
      reveal_answer: async (payload) => {
        const accepted = await verifyEventIfNeeded(runtime, "reveal_answer", payload);
        if (!accepted || !runtime.session || !runtime.sharedState) {
          return;
        }

        const nextRevision = Number(payload.revision) || 0;
        if (nextRevision < runtime.sharedState.revision) {
          return;
        }

        const activityId = String(payload.activityId || "");
        const isRevealed = Boolean(payload.revealed);

        if (isRevealed) {
          runtime.sharedState.revealedActivityIds.add(activityId);
        } else {
          runtime.sharedState.revealedActivityIds.delete(activityId);
        }

        runtime.sharedState.revision = nextRevision;
        renderAudience(runtime);
      },
      state_snapshot: async (payload) => {
        const accepted = await verifyEventIfNeeded(runtime, "state_snapshot", payload);
        if (!accepted) {
          return;
        }

        const applied = applySnapshotToAudience(runtime, payload);

        if (applied) {
          runtime.bannerMessage = "";
          runtime.bannerTone = "info";
          renderAudience(runtime);
        }
      }
    });

    runtime.channel = channel;
    runtime.client = client;
    runtime.connectionLabel = "Realtime connected";
    runtime.connectionTone = "success";

    if (!runtime.bannerMessage) {
      runtime.bannerMessage = "Connected. Waiting for presenter state if this room has not started yet.";
      runtime.bannerTone = "info";
    }
  } catch (error) {
    runtime.connectionLabel = "Realtime failed";
    runtime.connectionTone = "warning";
    runtime.bannerMessage =
      "The Supabase room could not be reached. Check the published config values and your room code.";
    runtime.bannerTone = "warning";
  }

  renderAudience(runtime);
  installAudienceCleanup(runtime);
}

async function initPresenterPage() {
  const params = new URLSearchParams(window.location.search);
  const room = sanitizeSimpleToken(params.get("room"));
  const sessionParam = normalizeSessionName(params.get("session"));
  const hostToken = sanitizeHostToken(params.get("host"));
  const runtime = {
    page: "present",
    room,
    sessionParam,
    hostToken,
    channel: null,
    client: null,
    session: null,
    sessionHash: "",
    sessionSource: sessionParam ? `${sessionParam}.json` : "not loaded",
    presenterState: null,
    authoringDraft: "",
    bannerMessage: "",
    bannerTone: "info",
    connectionLabel: "Not connected",
    connectionTone: "muted",
    snapshotTimer: null,
    heartbeatId: null
  };

  if (!room || !sessionParam) {
    runtime.bannerMessage = "Add both ?room= and ?session= to the presenter URL.";
    runtime.bannerTone = "warning";
  }

  if (!hostToken) {
    runtime.bannerMessage =
      "Presenter controls require a host token in the URL, for example &host=your-secret-token.";
    runtime.bannerTone = "warning";
  }

  if (sessionParam) {
    const loadedSession = await loadSessionFromFile(sessionParam);

    if (loadedSession.ok) {
      attachSessionToPresenter(runtime, loadedSession.session, loadedSession.sourceLabel);
    } else if (!runtime.bannerMessage) {
      runtime.bannerMessage =
        "Could not load the requested session JSON. You can paste session JSON into the import panel below.";
      runtime.bannerTone = "warning";
    }
  }

  const configStatus = getConfigStatus();

  if (!configStatus.ok) {
    runtime.connectionLabel = "Local preview only";
    runtime.connectionTone = "warning";
    if (!runtime.bannerMessage) {
      runtime.bannerMessage =
        "Realtime is disabled until docs/config.js exists locally or GitHub Actions injects it during deployment.";
      runtime.bannerTone = "warning";
    }
    renderPresenter(runtime);
    return;
  }

  if (!room || !hostToken) {
    renderPresenter(runtime);
    return;
  }

  renderPresenter(runtime);

  try {
    const { channel, client } = await openRoomChannel(room, {
      vote_submitted: async (payload) => {
        await handlePresenterSubmission(runtime, "poll", payload);
      },
      quiz_submitted: async (payload) => {
        await handlePresenterSubmission(runtime, "quiz", payload);
      },
      text_submitted: async (payload) => {
        await handlePresenterSubmission(runtime, "text", payload);
      },
      activity_changed: async (payload) => {
        const accepted = await verifyEventIfNeeded(runtime, "activity_changed", payload);
        if (!accepted || !runtime.session || !runtime.presenterState) {
          return;
        }

        const nextRevision = Number(payload.revision) || 0;
        if (nextRevision < runtime.presenterState.revision) {
          return;
        }

        runtime.presenterState.currentActivityIndex = clampIndex(
          Number(payload.currentActivityIndex),
          runtime.session.activities.length
        );
        runtime.presenterState.submissionsLocked = Boolean(payload.submissionsLocked);
        runtime.presenterState.revision = nextRevision;
        renderPresenter(runtime);
      },
      session_reset: async (payload) => {
        const accepted = await verifyEventIfNeeded(runtime, "session_reset", payload);
        if (!accepted || !runtime.session || !runtime.presenterState) {
          return;
        }

        const nextRevision = Number(payload.revision) || 0;
        if (nextRevision < runtime.presenterState.revision) {
          return;
        }

        const activity = getActivityById(runtime.session, payload.activityId);

        if (!activity) {
          return;
        }

        resetPresenterActivity(runtime, activity, {
          silent: true,
          nextResetCount: Number(payload.resetCount) || undefined,
          nextRevision: nextRevision || undefined
        });
        renderPresenter(runtime);
      },
      submissions_locked: async (payload) => {
        const accepted = await verifyEventIfNeeded(runtime, "submissions_locked", payload);
        if (!accepted || !runtime.presenterState) {
          return;
        }

        const nextRevision = Number(payload.revision) || 0;
        if (nextRevision < runtime.presenterState.revision) {
          return;
        }

        runtime.presenterState.submissionsLocked = Boolean(payload.locked);
        runtime.presenterState.revision = nextRevision;
        renderPresenter(runtime);
      },
      reveal_answer: async (payload) => {
        const accepted = await verifyEventIfNeeded(runtime, "reveal_answer", payload);
        if (!accepted || !runtime.presenterState) {
          return;
        }

        const nextRevision = Number(payload.revision) || 0;
        if (nextRevision < runtime.presenterState.revision) {
          return;
        }

        const activityId = String(payload.activityId || "");
        if (Boolean(payload.revealed)) {
          runtime.presenterState.revealedActivityIds.add(activityId);
        } else {
          runtime.presenterState.revealedActivityIds.delete(activityId);
        }

        runtime.presenterState.revision = nextRevision;
        renderPresenter(runtime);
      }
    });

    runtime.channel = channel;
    runtime.client = client;
    runtime.connectionLabel = "Realtime connected";
    runtime.connectionTone = "success";
    runtime.bannerMessage = "Presenter controls are live. Share the join link when you are ready.";
    runtime.bannerTone = "success";

    if (runtime.session && runtime.presenterState) {
      await broadcastSnapshot(runtime, "presenter_connected");
      runtime.heartbeatId = window.setInterval(() => {
        void broadcastSnapshot(runtime, "heartbeat");
      }, PRESENTER_HEARTBEAT_MS);
    }
  } catch (error) {
    runtime.connectionLabel = "Realtime failed";
    runtime.connectionTone = "warning";
    runtime.bannerMessage =
      "The presenter room could not be opened. Verify your Supabase config and the room code.";
    runtime.bannerTone = "warning";
  }

  renderPresenter(runtime);
  installPresenterCleanup(runtime);
}

function renderAudience(runtime) {
  const sessionSummary = document.getElementById("session-summary");
  const activityStage = document.getElementById("activity-stage");
  const resultsStage = document.getElementById("results-stage");
  const pageStatus = document.getElementById("page-status");
  const activeTextInput =
    document.activeElement?.id === "text-response-input" ? document.activeElement : null;
  const textSelectionStart =
    typeof activeTextInput?.selectionStart === "number" ? activeTextInput.selectionStart : null;
  const textSelectionEnd =
    typeof activeTextInput?.selectionEnd === "number" ? activeTextInput.selectionEnd : null;

  setBanner(pageStatus, runtime.bannerMessage, runtime.bannerTone);

  if (!sessionSummary || !activityStage || !resultsStage) {
    return;
  }

  const activity = getCurrentActivity(runtime.session, runtime.sharedState);
  const activityState = activity ? runtime.sharedState?.activityStates[activity.id] : null;
  const totalResponses = activity ? getResponseTotal(activity, activityState) : 0;

  sessionSummary.innerHTML = runtime.session
    ? `
      <div class="session-meta">
        <div class="summary-row">
          <div>
            <p class="section-kicker">${runtime.page === "join" ? "Live session" : "Marp embed"}</p>
            <h2 class="session-title">${escapeHtml(runtime.session.title)}</h2>
            <p class="body-copy">${escapeHtml(runtime.session.description || defaultDescription(runtime.page))}</p>
          </div>
          <div class="stack">
            <span class="badge ${runtime.sharedState?.submissionsLocked ? "badge-locked" : "badge-open"}">
              ${runtime.sharedState?.submissionsLocked ? "Submissions closed" : "Submissions open"}
            </span>
            ${
              runtime.page === "embed" && runtime.hostToken
                ? `<span class="badge badge-open">Verified control feed</span>`
                : runtime.page === "embed"
                  ? `<span class="badge badge-accent">Read-only feed</span>`
                  : ""
            }
          </div>
        </div>
        <div class="metric-grid">
          ${renderMetricCard("Room", `<span class="mono">${escapeHtml(runtime.room || "n/a")}</span>`, "Broadcast channel")}
          ${renderMetricCard("Activities", String(runtime.session.activities.length), "Loaded from JSON")}
          ${renderMetricCard("Current prompt", activity ? `${getActivityNumber(runtime.session, activity.id)} / ${runtime.session.activities.length}` : "Waiting", "Presenter-controlled")}
          ${renderMetricCard("Connection", escapeHtml(runtime.connectionLabel), runtime.connectionTone === "success" ? "Supabase active" : "No live link")}
        </div>
      </div>
    `
    : renderEmptyState(
        runtime.page === "join" ? "Waiting for session" : "Waiting for presenter",
        runtime.page === "join"
          ? "This page will render the current activity as soon as a session file or presenter snapshot is available."
          : "The embed view updates when the presenter publishes room state."
      );

  activityStage.innerHTML = activity
    ? renderAudienceActivity(runtime, activity, activityState)
    : renderEmptyState(
        "No active activity",
        "A presenter has not published an activity yet, or the session file is still loading."
      );

  resultsStage.innerHTML = activity
    ? `
      <div class="results-shell">
        <div class="title-row">
          <div>
            <p class="section-kicker">Live results</p>
            <h2 class="activity-title">${escapeHtml(activity.question)}</h2>
          </div>
          <div class="stack">
            <span class="badge badge-accent">${totalResponses} response${totalResponses === 1 ? "" : "s"}</span>
            ${
              activity.type === "quiz" && isActivityRevealed(runtime.sharedState, activity.id)
                ? `<span class="badge badge-open">Answer revealed</span>`
                : ""
            }
          </div>
        </div>
        ${renderResultsForActivity(runtime, activity, activityState)}
      </div>
    `
    : renderEmptyState("No results yet", "Results appear here once the presenter opens an activity.");

  bindAudienceInteractions(runtime, activity);

  if (activeTextInput) {
    const nextTextInput = document.getElementById("text-response-input");
    nextTextInput?.focus();
    if (
      nextTextInput &&
      typeof textSelectionStart === "number" &&
      typeof textSelectionEnd === "number"
    ) {
      nextTextInput.setSelectionRange(textSelectionStart, textSelectionEnd);
    }
  }
}

function renderPresenter(runtime) {
  const sessionSummary = document.getElementById("session-summary");
  const controlPanel = document.getElementById("control-panel");
  const activityStage = document.getElementById("activity-stage");
  const resultsStage = document.getElementById("results-stage");
  const authoringPanel = document.getElementById("authoring-panel");
  const pageStatus = document.getElementById("page-status");
  const activeJsonInput =
    document.activeElement?.id === "session-json-input" ? document.activeElement : null;
  const jsonSelectionStart =
    typeof activeJsonInput?.selectionStart === "number" ? activeJsonInput.selectionStart : null;
  const jsonSelectionEnd =
    typeof activeJsonInput?.selectionEnd === "number" ? activeJsonInput.selectionEnd : null;

  setBanner(pageStatus, runtime.bannerMessage, runtime.bannerTone);

  if (!sessionSummary || !controlPanel || !activityStage || !resultsStage || !authoringPanel) {
    return;
  }

  const activity = getCurrentActivity(runtime.session, runtime.presenterState);
  const activityState = activity ? runtime.presenterState?.activityStates[activity.id] : null;
  const controlsDisabled = !runtime.hostToken || !runtime.session || !runtime.presenterState;
  const canReveal = Boolean(activity && activity.type === "quiz");
  const isRevealed = activity ? isActivityRevealed(runtime.presenterState, activity.id) : false;
  const joinLink = runtime.room && runtime.sessionParam
    ? buildPageUrl("join", { room: runtime.room, session: runtime.sessionParam })
    : "";
  const embedLink = runtime.room && runtime.sessionParam
    ? buildPageUrl("embed", { room: runtime.room, session: runtime.sessionParam })
    : "";
  const verifiedEmbedLink =
    runtime.room && runtime.sessionParam && runtime.hostToken
      ? buildPageUrl("embed", {
          room: runtime.room,
          session: runtime.sessionParam,
          host: runtime.hostToken
        })
      : "";

  sessionSummary.innerHTML = runtime.session
    ? `
      <div class="session-meta">
        <div class="summary-row">
          <div>
            <p class="section-kicker">Session loaded</p>
            <h2 class="session-title">${escapeHtml(runtime.session.title)}</h2>
            <p class="body-copy">${escapeHtml(runtime.session.description || "No description provided.")}</p>
          </div>
          <div class="stack">
            <span class="badge ${runtime.presenterState?.submissionsLocked ? "badge-locked" : "badge-open"}">
              ${runtime.presenterState?.submissionsLocked ? "Submissions closed" : "Submissions open"}
            </span>
            <span class="badge ${runtime.hostToken ? "badge-open" : "badge-locked"}">
              ${runtime.hostToken ? "Host token active" : "Host token missing"}
            </span>
          </div>
        </div>
        <div class="metric-grid">
          ${renderMetricCard("Room", `<span class="mono">${escapeHtml(runtime.room || "n/a")}</span>`, "Broadcast channel")}
          ${renderMetricCard("Activities", String(runtime.session.activities.length), runtime.sessionSource)}
          ${renderMetricCard("Current prompt", activity ? `${getActivityNumber(runtime.session, activity.id)} / ${runtime.session.activities.length}` : "Waiting", activity ? humanizeType(activity.type) : "No activity")}
          ${renderMetricCard("Connection", escapeHtml(runtime.connectionLabel), runtime.connectionTone === "success" ? "Supabase active" : "No live link")}
        </div>
      </div>
    `
    : renderEmptyState(
        "Load a session",
        "Use ?session=filename to load JSON from /docs/sessions/, or paste session JSON into the import panel."
      );

  controlPanel.innerHTML = `
    <div class="controls-shell">
      <div class="title-row">
        <div>
          <p class="section-kicker">Controls</p>
          <h2 class="activity-title">Drive the current activity</h2>
        </div>
        ${
          activity
            ? `<span class="badge badge-accent">${escapeHtml(humanizeType(activity.type))}</span>`
            : ""
        }
      </div>
      <div class="control-row">
        <button id="prev-activity" class="button button-ghost" type="button" ${controlsDisabled || !activity || getActivityNumber(runtime.session, activity.id) === 1 ? "disabled" : ""}>Previous</button>
        <button id="next-activity" class="button button-primary" type="button" ${controlsDisabled || !activity || getActivityNumber(runtime.session, activity.id) === runtime.session?.activities.length ? "disabled" : ""}>Next</button>
        <button id="toggle-lock" class="button button-secondary" type="button" ${controlsDisabled || !activity ? "disabled" : ""}>
          ${runtime.presenterState?.submissionsLocked ? "Open submissions" : "Close submissions"}
        </button>
        <button id="reset-activity" class="button button-danger" type="button" ${controlsDisabled || !activity ? "disabled" : ""}>Reset activity</button>
        <button id="toggle-reveal" class="button button-ghost" type="button" ${controlsDisabled || !canReveal ? "disabled" : ""}>
          ${isRevealed ? "Hide answer" : "Reveal answer"}
        </button>
      </div>
      <div class="divider"></div>
      <div class="stack">
        <label class="field">
          <span>Join link</span>
          <div class="copy-row">
            <input id="presenter-join-link" type="text" readonly value="${escapeAttribute(joinLink)}" />
            <button class="button button-ghost" type="button" data-copy-target="presenter-join-link">Copy</button>
          </div>
        </label>
        <label class="field">
          <span>Embed link</span>
          <div class="copy-row">
            <input id="presenter-embed-link" type="text" readonly value="${escapeAttribute(embedLink)}" />
            <button class="button button-ghost" type="button" data-copy-target="presenter-embed-link">Copy</button>
          </div>
        </label>
        <label class="field">
          <span>Verified embed link</span>
          <div class="copy-row">
            <input id="presenter-verified-embed-link" type="text" readonly value="${escapeAttribute(verifiedEmbedLink)}" />
            <button class="button button-ghost" type="button" data-copy-target="presenter-verified-embed-link">Copy</button>
          </div>
        </label>
      </div>
      <p class="footer-note">
        The verified embed URL includes the host token so the embed page can ignore forged control events.
      </p>
    </div>
  `;

  activityStage.innerHTML = activity
    ? `
      <div class="activity-shell">
        <div class="title-row">
          <div>
            <p class="section-kicker">Current activity</p>
            <h2 class="activity-title">${escapeHtml(activity.question)}</h2>
          </div>
          <div class="stack">
            <span class="badge badge-accent">Activity ${getActivityNumber(runtime.session, activity.id)} of ${runtime.session.activities.length}</span>
            ${
              activity.type === "quiz"
                ? `<span class="badge ${isRevealed ? "badge-open" : "badge-locked"}">${isRevealed ? "Correct answer visible" : "Answer hidden"}</span>`
                : ""
            }
          </div>
        </div>
        <p class="body-copy">
          ${activity.type === "text"
            ? `Participants can send up to ${SUBMISSION_LIMITS.text} short responses with a ${Math.round(COOLDOWN_MS / 1000)} second cooldown.`
            : `Each participant can submit once for this ${escapeHtml(humanizeType(activity.type).toLowerCase())}.`}
        </p>
        ${renderPresenterActivityPreview(runtime, activity, activityState)}
      </div>
    `
    : renderEmptyState(
        "No active activity",
        "Load a session file or import JSON to start driving the room."
      );

  resultsStage.innerHTML = activity
    ? `
      <div class="results-shell">
        <div class="title-row">
          <div>
            <p class="section-kicker">Results</p>
            <h2 class="activity-title">${escapeHtml(activity.question)}</h2>
          </div>
          <div class="stack">
            <span class="badge badge-accent">${getResponseTotal(activity, activityState)} response${getResponseTotal(activity, activityState) === 1 ? "" : "s"}</span>
          </div>
        </div>
        ${renderResultsForActivity(runtime, activity, activityState)}
      </div>
    `
    : renderEmptyState("No results yet", "Results appear here once participants submit responses.");

  authoringPanel.innerHTML = `
    <div class="authoring-shell">
      <div class="title-row">
        <div>
          <p class="section-kicker">Session JSON</p>
          <h2 class="activity-title">Import or export content</h2>
        </div>
        ${
          runtime.sessionSource
            ? `<span class="badge badge-accent">${escapeHtml(runtime.sessionSource)}</span>`
            : ""
        }
      </div>
      <p class="body-copy">
        Paste session JSON to replace the live presenter session for this room. Imported sessions are ephemeral and last only while this presenter tab remains open.
      </p>
      <details open>
        <summary>Open editor</summary>
        <div class="stack-lg">
          <label class="field">
            <span>Session JSON</span>
            <textarea id="session-json-input" spellcheck="false">${escapeHtml(
              runtime.authoringDraft || (runtime.session ? JSON.stringify(runtime.session, null, 2) : "")
            )}</textarea>
          </label>
          <div class="control-row">
            <button id="load-session-json" class="button button-secondary" type="button">Load JSON in presenter</button>
            <button id="copy-session-json" class="button button-ghost" type="button">Copy JSON</button>
            <button id="download-session-json" class="button button-ghost" type="button">Download JSON</button>
          </div>
        </div>
      </details>
    </div>
  `;

  bindPresenterInteractions(runtime);

  if (activeJsonInput) {
    const nextJsonInput = document.getElementById("session-json-input");
    nextJsonInput?.focus();
    if (
      nextJsonInput &&
      typeof jsonSelectionStart === "number" &&
      typeof jsonSelectionEnd === "number"
    ) {
      nextJsonInput.setSelectionRange(jsonSelectionStart, jsonSelectionEnd);
    }
  }
}

function bindAudienceInteractions(runtime, activity) {
  if (runtime.page !== "join" || !activity) {
    return;
  }

  document.querySelectorAll("[data-submit-choice]").forEach((button) => {
    button.addEventListener("click", async () => {
      const optionIndex = Number(button.getAttribute("data-submit-choice"));
      await submitAudienceChoice(runtime, activity, optionIndex);
    });
  });

  const textInput = document.getElementById("text-response-input");
  const textForm = document.getElementById("text-response-form");

  textInput?.addEventListener("input", () => {
    runtime.textDraft = textInput.value;
  });

  textForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await submitAudienceText(runtime, activity);
  });
}

function bindPresenterInteractions(runtime) {
  document.getElementById("prev-activity")?.addEventListener("click", async () => {
    await shiftPresenterActivity(runtime, -1);
  });

  document.getElementById("next-activity")?.addEventListener("click", async () => {
    await shiftPresenterActivity(runtime, 1);
  });

  document.getElementById("toggle-lock")?.addEventListener("click", async () => {
    await togglePresenterLock(runtime);
  });

  document.getElementById("reset-activity")?.addEventListener("click", async () => {
    await resetPresenterCurrentActivity(runtime);
  });

  document.getElementById("toggle-reveal")?.addEventListener("click", async () => {
    await togglePresenterReveal(runtime);
  });

  const jsonInput = document.getElementById("session-json-input");

  jsonInput?.addEventListener("input", () => {
    runtime.authoringDraft = jsonInput.value;
  });

  document.getElementById("load-session-json")?.addEventListener("click", async () => {
    await loadSessionFromDraft(runtime);
  });

  document.getElementById("copy-session-json")?.addEventListener("click", async () => {
    const value = runtime.authoringDraft || (runtime.session ? JSON.stringify(runtime.session, null, 2) : "");

    if (!value) {
      return;
    }

    try {
      await copyText(value);
      setBanner(document.getElementById("page-status"), "Session JSON copied to the clipboard.", "success");
    } catch (error) {
      setBanner(document.getElementById("page-status"), "Copy failed for the session JSON.", "warning");
    }
  });

  document.getElementById("download-session-json")?.addEventListener("click", () => {
    const value = runtime.authoringDraft || (runtime.session ? JSON.stringify(runtime.session, null, 2) : "");

    if (!value) {
      return;
    }

    downloadText(`${runtime.sessionParam || "session"}.json`, value);
  });
}

async function submitAudienceChoice(runtime, activity, optionIndex) {
  const gate = getAudienceSubmissionGate(runtime, activity);

  if (!gate.canSubmit) {
    runtime.bannerMessage = gate.message;
    runtime.bannerTone = gate.tone;
    renderAudience(runtime);
    return;
  }

  try {
    await sendBroadcast(runtime.channel, activity.type === "quiz" ? "quiz_submitted" : "vote_submitted", {
      activityId: activity.id,
      deviceId: runtime.deviceId,
      optionIndex,
      sentAt: new Date().toISOString()
    });

    recordLocalSubmission(runtime, activity.id, {
      countIncrement: 1,
      choiceIndex: optionIndex
    });
    runtime.bannerMessage = "Submission sent. Waiting for presenter sync.";
    runtime.bannerTone = "success";
  } catch (error) {
    runtime.bannerMessage = "Submission failed to send. Check your connection and try again.";
    runtime.bannerTone = "warning";
  }

  renderAudience(runtime);
}

async function submitAudienceText(runtime, activity) {
  const gate = getAudienceSubmissionGate(runtime, activity);
  const textInput = document.getElementById("text-response-input");
  const message = typeof textInput?.value === "string" ? textInput.value.trim() : runtime.textDraft.trim();

  if (!gate.canSubmit) {
    runtime.bannerMessage = gate.message;
    runtime.bannerTone = gate.tone;
    renderAudience(runtime);
    return;
  }

  if (!message) {
    runtime.bannerMessage = "Enter a short response before submitting.";
    runtime.bannerTone = "warning";
    renderAudience(runtime);
    return;
  }

  if (message.length > getTextMaxLength(activity)) {
    runtime.bannerMessage = `Keep responses within ${getTextMaxLength(activity)} characters.`;
    runtime.bannerTone = "warning";
    renderAudience(runtime);
    return;
  }

  try {
    await sendBroadcast(runtime.channel, "text_submitted", {
      activityId: activity.id,
      deviceId: runtime.deviceId,
      text: message,
      sentAt: new Date().toISOString()
    });

    recordLocalSubmission(runtime, activity.id, {
      countIncrement: 1
    });
    runtime.textDraft = "";
    runtime.bannerMessage = "Text response sent. Waiting for presenter sync.";
    runtime.bannerTone = "success";
  } catch (error) {
    runtime.bannerMessage = "Text response failed to send. Check your connection and try again.";
    runtime.bannerTone = "warning";
  }

  renderAudience(runtime);
}

async function handlePresenterSubmission(runtime, expectedType, payload) {
  if (!runtime.session || !runtime.presenterState) {
    return;
  }

  const activity = getCurrentActivity(runtime.session, runtime.presenterState);

  if (!activity || activity.type !== expectedType) {
    return;
  }

  if (payload.activityId !== activity.id || runtime.presenterState.submissionsLocked) {
    return;
  }

  const deviceId = sanitizeSimpleToken(payload.deviceId);

  if (!deviceId) {
    return;
  }

  const activityState = runtime.presenterState.activityStates[activity.id];
  const submissionEntry =
    activityState.submissionsByDevice[deviceId] ||
    createLocalSubmissionEntry(activityState.resetCount);

  const now = Date.now();
  const isCoolingDown = now - submissionEntry.lastSubmittedAt < COOLDOWN_MS;

  if (isCoolingDown) {
    return;
  }

  if (expectedType === "text") {
    const text = String(payload.text || "").trim();

    if (!text || text.length > getTextMaxLength(activity)) {
      return;
    }

    if (submissionEntry.count >= SUBMISSION_LIMITS.text) {
      return;
    }

    activityState.texts.push({
      id: `${deviceId}-${now}`,
      text,
      submittedAt: new Date(now).toISOString()
    });
  } else {
    const optionIndex = Number(payload.optionIndex);

    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= activity.options.length) {
      return;
    }

    if (submissionEntry.count >= SUBMISSION_LIMITS[expectedType]) {
      return;
    }

    activityState.counts[optionIndex] = (activityState.counts[optionIndex] || 0) + 1;
    submissionEntry.choiceIndex = optionIndex;
  }

  submissionEntry.count += 1;
  submissionEntry.lastSubmittedAt = now;
  submissionEntry.resetCount = activityState.resetCount;
  activityState.submissionsByDevice[deviceId] = submissionEntry;
  runtime.presenterState.revision += 1;

  renderPresenter(runtime);
  scheduleSnapshot(runtime, "submission");
}

async function shiftPresenterActivity(runtime, delta) {
  if (!runtime.session || !runtime.presenterState || !runtime.hostToken) {
    return;
  }

  const currentActivity = getCurrentActivity(runtime.session, runtime.presenterState);
  const currentIndex = currentActivity ? getActivityNumber(runtime.session, currentActivity.id) - 1 : 0;
  const nextIndex = clampIndex(currentIndex + delta, runtime.session.activities.length);

  if (nextIndex === runtime.presenterState.currentActivityIndex) {
    return;
  }

  runtime.presenterState.currentActivityIndex = nextIndex;
  runtime.presenterState.submissionsLocked = false;
  runtime.presenterState.revision += 1;

  await sendPresenterEvent(runtime, "activity_changed", {
    activityId: runtime.session.activities[nextIndex].id,
    currentActivityIndex: nextIndex,
    submissionsLocked: false,
    revision: runtime.presenterState.revision
  });
  scheduleSnapshot(runtime, "activity_changed");
  renderPresenter(runtime);
}

async function togglePresenterLock(runtime) {
  if (!runtime.presenterState || !runtime.hostToken) {
    return;
  }

  runtime.presenterState.submissionsLocked = !runtime.presenterState.submissionsLocked;
  runtime.presenterState.revision += 1;

  await sendPresenterEvent(runtime, "submissions_locked", {
    locked: runtime.presenterState.submissionsLocked,
    revision: runtime.presenterState.revision
  });
  scheduleSnapshot(runtime, "lock_toggled");
  renderPresenter(runtime);
}

async function resetPresenterCurrentActivity(runtime) {
  if (!runtime.session || !runtime.presenterState || !runtime.hostToken) {
    return;
  }

  const activity = getCurrentActivity(runtime.session, runtime.presenterState);

  if (!activity) {
    return;
  }

  resetPresenterActivity(runtime, activity);

  await sendPresenterEvent(runtime, "session_reset", {
    activityId: activity.id,
    resetCount: runtime.presenterState.activityStates[activity.id].resetCount,
    revision: runtime.presenterState.revision
  });
  scheduleSnapshot(runtime, "activity_reset");
  renderPresenter(runtime);
}

async function togglePresenterReveal(runtime) {
  if (!runtime.session || !runtime.presenterState || !runtime.hostToken) {
    return;
  }

  const activity = getCurrentActivity(runtime.session, runtime.presenterState);

  if (!activity || activity.type !== "quiz") {
    return;
  }

  const revealed = !runtime.presenterState.revealedActivityIds.has(activity.id);

  if (revealed) {
    runtime.presenterState.revealedActivityIds.add(activity.id);
  } else {
    runtime.presenterState.revealedActivityIds.delete(activity.id);
  }

  runtime.presenterState.revision += 1;

  await sendPresenterEvent(runtime, "reveal_answer", {
    activityId: activity.id,
    revealed,
    revision: runtime.presenterState.revision
  });
  scheduleSnapshot(runtime, "reveal_toggled");
  renderPresenter(runtime);
}

async function loadSessionFromDraft(runtime) {
  const draft = runtime.authoringDraft || document.getElementById("session-json-input")?.value || "";

  if (!draft.trim()) {
    runtime.bannerMessage = "Paste valid JSON before loading a session.";
    runtime.bannerTone = "warning";
    renderPresenter(runtime);
    return;
  }

  let raw;

  try {
    raw = JSON.parse(draft);
  } catch (error) {
    runtime.bannerMessage = "The pasted session JSON is not valid JSON.";
    runtime.bannerTone = "warning";
    renderPresenter(runtime);
    return;
  }

  const validation = validateSession(raw);

  if (!validation.ok) {
    runtime.bannerMessage = validation.errors.join(" ");
    runtime.bannerTone = "warning";
    renderPresenter(runtime);
    return;
  }

  attachSessionToPresenter(runtime, validation.session, "Imported JSON");
  runtime.bannerMessage = "Session JSON loaded into the presenter.";
  runtime.bannerTone = "success";
  renderPresenter(runtime);

  if (runtime.hostToken) {
    await broadcastSnapshot(runtime, "session_imported");
  }
}

function attachSessionToPresenter(runtime, session, sourceLabel) {
  runtime.session = session;
  runtime.sessionHash = hashString(stableStringify(session));
  runtime.sessionSource = sourceLabel;
  runtime.presenterState = createPresenterState(session);
  runtime.authoringDraft = JSON.stringify(session, null, 2);
}

function resetPresenterActivity(runtime, activity, options = {}) {
  const nextState = createPresenterActivityState(activity);
  const current = runtime.presenterState.activityStates[activity.id];
  nextState.resetCount = options.nextResetCount || current.resetCount + 1;
  runtime.presenterState.activityStates[activity.id] = nextState;
  runtime.presenterState.revealedActivityIds.delete(activity.id);
  runtime.presenterState.revision = options.nextRevision || runtime.presenterState.revision + 1;

  if (!options.silent) {
    runtime.bannerMessage = "Current activity reset.";
    runtime.bannerTone = "success";
  }
}

function renderAudienceActivity(runtime, activity, activityState) {
  const gate = getAudienceSubmissionGate(runtime, activity);
  const localEntry = getLocalSubmissionEntry(runtime, activity.id, activityState?.resetCount || 0);
  const selectedIndex = Number.isInteger(localEntry.choiceIndex) ? localEntry.choiceIndex : null;

  if (runtime.page === "embed") {
    return `
      <div class="activity-shell">
        <div class="title-row">
          <div>
            <p class="section-kicker">Current activity</p>
            <h2 class="activity-title">${escapeHtml(activity.question)}</h2>
          </div>
          <div class="stack">
            <span class="badge badge-accent">${escapeHtml(humanizeType(activity.type))}</span>
            <span class="badge ${runtime.sharedState?.submissionsLocked ? "badge-locked" : "badge-open"}">
              ${runtime.sharedState?.submissionsLocked ? "Closed" : "Open"}
            </span>
          </div>
        </div>
        <p class="body-copy">Embed view is read-only and updates whenever the presenter publishes state.</p>
      </div>
    `;
  }

  if (activity.type === "text") {
    return `
      <div class="activity-shell">
        <div class="title-row">
          <div>
            <p class="section-kicker">Current activity</p>
            <h2 class="activity-title">${escapeHtml(activity.question)}</h2>
          </div>
          <div class="stack">
            <span class="badge badge-accent">Max ${getTextMaxLength(activity)} chars</span>
            <span class="badge ${runtime.sharedState?.submissionsLocked ? "badge-locked" : "badge-open"}">
              ${runtime.sharedState?.submissionsLocked ? "Closed" : "Open"}
            </span>
          </div>
        </div>
        <form id="text-response-form" class="stack-lg">
          <label class="field">
            <span>Your response</span>
            <textarea
              id="text-response-input"
              maxlength="${getTextMaxLength(activity)}"
              placeholder="Keep it short, concrete, and audience-ready."
              ${gate.canSubmit ? "" : "disabled"}
            >${escapeHtml(runtime.textDraft)}</textarea>
          </label>
          <button class="button button-primary" type="submit" ${gate.canSubmit ? "" : "disabled"}>
            Submit response
          </button>
        </form>
        <div class="notice ${gate.tone === "warning" ? "notice-warning" : "notice-info"}">${escapeHtml(gate.message)}</div>
      </div>
    `;
  }

  return `
    <div class="activity-shell">
      <div class="title-row">
        <div>
          <p class="section-kicker">Current activity</p>
          <h2 class="activity-title">${escapeHtml(activity.question)}</h2>
        </div>
        <div class="stack">
          <span class="badge badge-accent">${escapeHtml(humanizeType(activity.type))}</span>
          <span class="badge ${runtime.sharedState?.submissionsLocked ? "badge-locked" : "badge-open"}">
            ${runtime.sharedState?.submissionsLocked ? "Closed" : "Open"}
          </span>
        </div>
      </div>
      <div class="choice-grid">
        ${activity.options
          .map((option, index) => {
            const isSelected = selectedIndex === index;
            const disabled = !gate.canSubmit || (selectedIndex !== null && !isSelected);

            return `
              <article class="choice-card ${isSelected ? "is-selected" : ""} ${disabled ? "is-disabled" : ""}">
                <div class="choice-header">
                  <span>${escapeHtml(option)}</span>
                  ${isSelected ? '<span class="badge badge-open">Your choice</span>' : ""}
                </div>
                <button
                  class="button ${isSelected ? "button-secondary" : "button-ghost"} choice-select"
                  type="button"
                  data-submit-choice="${index}"
                  ${disabled ? "disabled" : ""}
                >
                  ${isSelected ? "Selected" : "Submit"}
                </button>
              </article>
            `;
          })
          .join("")}
      </div>
      <div class="notice ${gate.tone === "warning" ? "notice-warning" : "notice-info"}">${escapeHtml(gate.message)}</div>
    </div>
  `;
}

function renderPresenterActivityPreview(runtime, activity, activityState) {
  if (activity.type === "text") {
    return `
      <div class="notice notice-info">
        Audience members can submit up to ${SUBMISSION_LIMITS.text} short responses for this activity.
      </div>
      <div class="metric-grid">
        ${renderMetricCard("Responses", String(activityState?.texts.length || 0), "Current activity")}
        ${renderMetricCard("Cooldown", `${Math.round(COOLDOWN_MS / 1000)}s`, "Per device")}
        ${renderMetricCard("Character limit", String(getTextMaxLength(activity)), "Per response")}
      </div>
    `;
  }

  return `
    <div class="choice-grid">
      ${activity.options
        .map((option, index) => {
          const isCorrect =
            activity.type === "quiz" &&
            isActivityRevealed(runtime.presenterState, activity.id) &&
            activity.correctIndex === index;
          return `
            <article class="choice-card ${isCorrect ? "is-correct" : ""}">
              <div class="choice-header">
                <span>${escapeHtml(option)}</span>
                ${
                  isCorrect
                    ? '<span class="badge badge-open">Correct</span>'
                    : `<span class="badge badge-accent">Option ${index + 1}</span>`
                }
              </div>
              <div class="choice-meta">
                <span>${activity.type === "quiz" ? "Single answer" : "Single vote"}</span>
                <span>${activityState?.counts[index] || 0} live</span>
              </div>
            </article>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderResultsForActivity(runtime, activity, activityState) {
  if (!activityState) {
    return renderEmptyState("No results yet", "Waiting for responses.");
  }

  if (activity.type === "text") {
    const responses = [...activityState.texts].reverse();

    return responses.length
      ? `
        <div class="text-entry-list">
          ${responses
            .map(
              (entry, index) => `
                <article class="text-card">
                  <p>${escapeHtml(entry.text)}</p>
                  <small>Response ${responses.length - index}</small>
                </article>
              `
            )
            .join("")}
        </div>
      `
      : renderEmptyState("No text yet", "Short responses will appear here as participants submit them.");
  }

  const revealCorrect = activity.type === "quiz" && isActivityRevealed(runtime.presenterState || runtime.sharedState, activity.id);
  const total = getResponseTotal(activity, activityState);

  return `
    <div class="choice-grid">
      ${activity.options
        .map((option, index) => {
          const count = activityState.counts[index] || 0;
          const percentage = total > 0 ? Math.round((count / total) * 100) : 0;
          const isCorrect = revealCorrect && activity.correctIndex === index;
          return `
            <article class="choice-card ${isCorrect ? "is-correct" : ""}">
              <div class="choice-header">
                <span>${escapeHtml(option)}</span>
                <strong>${count}</strong>
              </div>
              <div class="meter">
                <div class="meter-fill ${isCorrect ? "correct-pill" : ""}" style="width: ${percentage}%"></div>
              </div>
              <div class="choice-meta">
                <span>${percentage}%</span>
                <span>${count} response${count === 1 ? "" : "s"}</span>
              </div>
              ${isCorrect ? '<span class="badge badge-open">Correct answer</span>' : ""}
            </article>
          `;
        })
        .join("")}
    </div>
  `;
}

function getAudienceSubmissionGate(runtime, activity) {
  if (!runtime.channel) {
    return {
      canSubmit: false,
      message: "Realtime is not connected, so submissions are currently disabled.",
      tone: "warning"
    };
  }

  if (runtime.sharedState?.submissionsLocked) {
    return {
      canSubmit: false,
      message: "The presenter has closed submissions for the current activity.",
      tone: "warning"
    };
  }

  const activityState = runtime.sharedState?.activityStates?.[activity.id];
  const entry = getLocalSubmissionEntry(runtime, activity.id, activityState?.resetCount || 0);
  const limit = SUBMISSION_LIMITS[activity.type] || 1;

  if (entry.count >= limit) {
    return {
      canSubmit: false,
      message:
        activity.type === "text"
          ? `You have reached the limit of ${limit} responses for this activity.`
          : "You have already submitted for this activity.",
      tone: "warning"
    };
  }

  const cooldownRemaining = COOLDOWN_MS - (Date.now() - entry.lastSubmittedAt);

  if (entry.lastSubmittedAt && cooldownRemaining > 0) {
    return {
      canSubmit: false,
      message: `Please wait ${Math.ceil(cooldownRemaining / 1000)} seconds before submitting again.`,
      tone: "warning"
    };
  }

  return {
    canSubmit: true,
    message:
      activity.type === "text"
        ? `You can send up to ${limit} short responses for this prompt.`
        : "Choose one option and submit once for this activity.",
    tone: "info"
  };
}

function applySnapshotToAudience(runtime, payload) {
  const revision = Number(payload.revision) || 0;

  if (runtime.sharedState && revision < runtime.sharedState.revision) {
    return false;
  }

  const validation = validateSession(payload.session);

  if (!validation.ok) {
    return false;
  }

  const session = validation.session;
  const nextSessionHash = String(payload.sessionHash || hashString(stableStringify(session)));
  runtime.submissionStoreKey = buildSubmissionStoreKey(runtime.room, nextSessionHash);
  const nextSharedState = createPublicState(session);
  nextSharedState.revision = revision;
  nextSharedState.currentActivityIndex = clampIndex(
    Number(payload.currentActivityIndex),
    session.activities.length
  );
  nextSharedState.submissionsLocked = Boolean(payload.submissionsLocked);
  nextSharedState.revealedActivityIds = new Set(
    Array.isArray(payload.revealedActivityIds) ? payload.revealedActivityIds : []
  );

  Object.entries(nextSharedState.activityStates).forEach(([activityId, state]) => {
    const incoming = payload.activityStates?.[activityId] || {};
    const activity = getActivityById(session, activityId);

    state.counts = Array.isArray(activity?.options)
      ? activity.options.map((_, index) => Number(incoming.counts?.[index]) || 0)
      : [];
    state.texts = Array.isArray(incoming.texts)
      ? incoming.texts
          .map((entry, index) => ({
            id: String(entry.id || `${activityId}-${index}`),
            text: String(entry.text || "").slice(0, getTextMaxLength(activity)),
            submittedAt: String(entry.submittedAt || "")
          }))
          .filter((entry) => entry.text)
      : [];
    state.resetCount = Number(incoming.resetCount) || 0;
    getLocalSubmissionEntry(runtime, activityId, state.resetCount);
  });

  runtime.session = session;
  runtime.sessionHash = nextSessionHash;
  runtime.sessionSource = "Presenter snapshot";
  runtime.sharedState = nextSharedState;

  return true;
}

async function sendPresenterEvent(runtime, eventName, payload) {
  if (!runtime.channel || !runtime.hostToken) {
    return;
  }

  const signedPayload = await signEvent(eventName, payload, runtime.hostToken);
  await sendBroadcast(runtime.channel, eventName, signedPayload);
}

async function broadcastSnapshot(runtime, reason) {
  if (!runtime.channel || !runtime.session || !runtime.presenterState || !runtime.hostToken) {
    return;
  }

  const snapshot = buildSnapshot(runtime, reason);
  const signedPayload = await signEvent("state_snapshot", snapshot, runtime.hostToken);
  await sendBroadcast(runtime.channel, "state_snapshot", signedPayload);
}

function scheduleSnapshot(runtime, reason) {
  if (runtime.snapshotTimer) {
    window.clearTimeout(runtime.snapshotTimer);
  }

  runtime.snapshotTimer = window.setTimeout(() => {
    runtime.snapshotTimer = null;
    void broadcastSnapshot(runtime, reason);
  }, SNAPSHOT_DEBOUNCE_MS);
}

function buildSnapshot(runtime, reason) {
  const activityStates = Object.fromEntries(
    Object.entries(runtime.presenterState.activityStates).map(([activityId, state]) => [
      activityId,
      {
        counts: [...state.counts],
        texts: state.texts.map((entry) => ({
          id: entry.id,
          text: entry.text,
          submittedAt: entry.submittedAt
        })),
        resetCount: state.resetCount
      }
    ])
  );

  return {
    reason,
    revision: runtime.presenterState.revision,
    session: runtime.session,
    sessionHash: runtime.sessionHash || hashString(stableStringify(runtime.session)),
    currentActivityIndex: runtime.presenterState.currentActivityIndex,
    submissionsLocked: runtime.presenterState.submissionsLocked,
    revealedActivityIds: [...runtime.presenterState.revealedActivityIds],
    activityStates,
    sentAt: new Date().toISOString()
  };
}

function createPresenterState(session) {
  return {
    revision: 0,
    currentActivityIndex: 0,
    submissionsLocked: false,
    revealedActivityIds: new Set(),
    activityStates: Object.fromEntries(
      session.activities.map((activity) => [activity.id, createPresenterActivityState(activity)])
    )
  };
}

function createPresenterActivityState(activity) {
  return {
    counts: Array.isArray(activity.options) ? activity.options.map(() => 0) : [],
    texts: [],
    submissionsByDevice: {},
    resetCount: 0
  };
}

function createPublicState(session) {
  return {
    revision: 0,
    currentActivityIndex: 0,
    submissionsLocked: false,
    revealedActivityIds: new Set(),
    activityStates: Object.fromEntries(
      session.activities.map((activity) => [
        activity.id,
        {
          counts: Array.isArray(activity.options) ? activity.options.map(() => 0) : [],
          texts: [],
          resetCount: 0
        }
      ])
    )
  };
}

function validateSession(raw) {
  const errors = [];

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      errors: ["Session JSON must be an object."],
      session: null
    };
  }

  const title = typeof raw.title === "string" ? raw.title.trim() : "";

  if (!title) {
    errors.push("Session title is required.");
  }

  if (!Array.isArray(raw.activities) || raw.activities.length === 0) {
    errors.push("Session activities are required.");
  }

  const activities = Array.isArray(raw.activities)
    ? raw.activities
        .map((activity, index) => normalizeActivity(activity, index))
        .filter(Boolean)
    : [];

  if (Array.isArray(raw.activities) && activities.length !== raw.activities.length) {
    errors.push("Every activity must include id, type, and question.");
  }

  const duplicateIds = findDuplicateIds(activities.map((activity) => activity.id));
  if (duplicateIds.length) {
    errors.push(`Duplicate activity ids found: ${duplicateIds.join(", ")}.`);
  }

  activities.forEach((activity) => {
    if ((activity.type === "poll" || activity.type === "quiz") && activity.options.length < 2) {
      errors.push(`${activity.id} must include at least two options.`);
    }

    if (
      activity.type === "quiz" &&
      activity.correctIndex !== null &&
      (activity.correctIndex < 0 || activity.correctIndex >= activity.options.length)
    ) {
      errors.push(`${activity.id} has an invalid correctIndex.`);
    }
  });

  return {
    ok: errors.length === 0,
    errors,
    session:
      errors.length === 0
        ? {
            title,
            description: typeof raw.description === "string" ? raw.description.trim() : "",
            activities
          }
        : null
  };
}

function normalizeActivity(activity, index) {
  if (!activity || typeof activity !== "object" || Array.isArray(activity)) {
    return null;
  }

  const id = sanitizeActivityId(activity.id, index);
  const type = typeof activity.type === "string" ? activity.type.trim().toLowerCase() : "";
  const question = typeof activity.question === "string" ? activity.question.trim() : "";

  if (!id || !SUPPORTED_ACTIVITY_TYPES.has(type) || !question) {
    return null;
  }

  const normalized = {
    id,
    type,
    question
  };

  if (type === "poll" || type === "quiz") {
    normalized.options = Array.isArray(activity.options)
      ? activity.options.map((option) => String(option || "").trim()).filter(Boolean)
      : [];
  }

  if (type === "text") {
    normalized.maxLength = clampNumber(activity.maxLength, 1, 280, 180);
  }

  if (type === "quiz") {
    normalized.correctIndex = Number.isInteger(activity.correctIndex)
      ? activity.correctIndex
      : null;
  }

  return normalized;
}

async function loadSessionFromFile(sessionParam) {
  const normalizedSession = normalizeSessionName(sessionParam);

  if (!normalizedSession) {
    return {
      ok: false,
      error: new Error("Invalid session file name.")
    };
  }

  try {
    const response = await fetch(`./sessions/${encodeURIComponent(normalizedSession)}.json`, {
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`Session file returned ${response.status}.`);
    }

    const json = await response.json();
    const validation = validateSession(json);

    if (!validation.ok) {
      throw new Error(validation.errors.join(" "));
    }

    return {
      ok: true,
      session: validation.session,
      sourceLabel: `${normalizedSession}.json`
    };
  } catch (error) {
    return {
      ok: false,
      error
    };
  }
}

function getCurrentActivity(session, state) {
  if (!session || !state || !Array.isArray(session.activities) || !session.activities.length) {
    return null;
  }

  return session.activities[clampIndex(state.currentActivityIndex, session.activities.length)];
}

function getActivityById(session, activityId) {
  return session?.activities?.find((activity) => activity.id === activityId) || null;
}

function getActivityNumber(session, activityId) {
  const index = session?.activities?.findIndex((activity) => activity.id === activityId) ?? -1;
  return index >= 0 ? index + 1 : 0;
}

function getResponseTotal(activity, activityState) {
  if (!activity || !activityState) {
    return 0;
  }

  if (activity.type === "text") {
    return activityState.texts.length;
  }

  return activityState.counts.reduce((sum, count) => sum + count, 0);
}

function isActivityRevealed(state, activityId) {
  return Boolean(state?.revealedActivityIds?.has?.(activityId));
}

function getTextMaxLength(activity) {
  return clampNumber(activity?.maxLength, 1, 280, 180);
}

function createLocalSubmissionEntry(resetCount = 0) {
  return {
    count: 0,
    lastSubmittedAt: 0,
    choiceIndex: null,
    resetCount
  };
}

function getLocalSubmissionEntry(runtime, activityId, resetCount) {
  const store = readSubmissionStore(runtime.submissionStoreKey);
  const entry = store[activityId] || createLocalSubmissionEntry(resetCount);

  if (entry.resetCount !== resetCount) {
    const fresh = createLocalSubmissionEntry(resetCount);
    store[activityId] = fresh;
    writeSubmissionStore(runtime.submissionStoreKey, store);
    return fresh;
  }

  return entry;
}

function resetLocalSubmissionEntry(runtime, activityId, resetCount) {
  const store = readSubmissionStore(runtime.submissionStoreKey);
  store[activityId] = createLocalSubmissionEntry(resetCount);
  writeSubmissionStore(runtime.submissionStoreKey, store);
}

function recordLocalSubmission(runtime, activityId, payload) {
  const store = readSubmissionStore(runtime.submissionStoreKey);
  const current = store[activityId] || createLocalSubmissionEntry();
  store[activityId] = {
    ...current,
    count: current.count + (payload.countIncrement || 0),
    lastSubmittedAt: Date.now(),
    choiceIndex:
      typeof payload.choiceIndex === "number" ? payload.choiceIndex : current.choiceIndex
  };
  writeSubmissionStore(runtime.submissionStoreKey, store);
}

function readSubmissionStore(key) {
  if (!key) {
    return {};
  }

  try {
    return JSON.parse(window.localStorage.getItem(key) || "{}");
  } catch (error) {
    return {};
  }
}

function writeSubmissionStore(key, value) {
  if (!key) {
    return;
  }

  window.localStorage.setItem(key, JSON.stringify(value));
}

function buildSubmissionStoreKey(room, sessionHash) {
  return `seminarsmack:submissions:${room || "room"}:${sessionHash || "session"}`;
}

async function verifyEventIfNeeded(runtime, eventName, payload) {
  if (!runtime.hostToken) {
    return true;
  }

  return verifySignedEvent(eventName, payload, runtime.hostToken);
}

async function signEvent(eventName, payload, secret) {
  const signature = await createSignature(`${eventName}:${stableStringify(payload)}`, secret);
  return {
    ...payload,
    _signature: signature
  };
}

async function verifySignedEvent(eventName, payload, secret) {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  const signature = payload._signature;

  if (typeof signature !== "string" || !signature) {
    return false;
  }

  const unsignedPayload = { ...payload };
  delete unsignedPayload._signature;

  const expected = await createSignature(
    `${eventName}:${stableStringify(unsignedPayload)}`,
    secret
  );

  return expected === signature;
}

async function createSignature(message, secret) {
  if (!window.crypto?.subtle) {
    return hashString(`${secret}:${message}`);
  }

  const encoder = new TextEncoder();
  const buffer = await window.crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`${secret}:${message}`)
  );

  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function renderMetricCard(label, value, note) {
  return `
    <article class="metric-card">
      <strong>${value}</strong>
      <div class="metric-meta">
        <span>${escapeHtml(label)}</span>
        <span>${escapeHtml(note)}</span>
      </div>
    </article>
  `;
}

function renderEmptyState(title, body) {
  return `
    <div class="empty-state">
      <h2 class="activity-title">${escapeHtml(title)}</h2>
      <p class="body-copy">${escapeHtml(body)}</p>
    </div>
  `;
}

function setBanner(element, message, tone = "info") {
  if (!element) {
    return;
  }

  element.textContent = message || "";
  element.className = "status-banner";

  if (!message) {
    return;
  }

  element.classList.add(`status-${tone}`);
}

function installAudienceCleanup(runtime) {
  window.addEventListener("beforeunload", () => {
    if (runtime.channel) {
      void closeRoomChannel(runtime.channel);
    }
  });
}

function installPresenterCleanup(runtime) {
  window.addEventListener("beforeunload", () => {
    if (runtime.snapshotTimer) {
      window.clearTimeout(runtime.snapshotTimer);
    }

    if (runtime.heartbeatId) {
      window.clearInterval(runtime.heartbeatId);
    }

    if (runtime.channel) {
      void closeRoomChannel(runtime.channel);
    }
  });
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const helper = document.createElement("textarea");
  helper.value = value;
  helper.setAttribute("readonly", "");
  helper.style.position = "absolute";
  helper.style.left = "-9999px";
  document.body.append(helper);
  helper.select();
  document.execCommand("copy");
  helper.remove();
}

function flashButtonState(button, text) {
  const original = button.textContent;
  button.textContent = text;
  window.setTimeout(() => {
    button.textContent = original;
  }, 1400);
}

function buildPageUrl(pageName, params) {
  const url = new URL(`./${pageName}.html`, window.location.href);
  Object.entries(params).forEach(([key, value]) => {
    if (value) {
      url.searchParams.set(key, value);
    }
  });
  return url.toString();
}

function downloadText(filename, contents) {
  const blob = new Blob([contents], { type: "application/json;charset=utf-8" });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}

function getOrCreateDeviceId() {
  const existing = window.localStorage.getItem(DEVICE_STORAGE_KEY);

  if (existing) {
    return existing;
  }

  const next = `device-${randomToken(12)}`;
  window.localStorage.setItem(DEVICE_STORAGE_KEY, next);
  return next;
}

function randomToken(length = 10) {
  const bytes = new Uint8Array(length);
  window.crypto.getRandomValues(bytes);
  return [...bytes]
    .map((byte) => "abcdefghijklmnopqrstuvwxyz0123456789"[byte % 36])
    .join("");
}

function generateRoomCode() {
  const prefix = ROOM_PREFIXES[Math.floor(Math.random() * ROOM_PREFIXES.length)];
  return `${prefix}-${randomToken(5)}`;
}

function readOrFallback(value, fallback) {
  return String(value || "").trim() || fallback;
}

function sanitizeSimpleToken(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "");
  return normalized || "";
}

function sanitizeHostToken(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9-_.~]/g, "");
  return normalized || "";
}

function normalizeSessionName(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/\.json$/i, "")
    .replace(/^\/+|\/+$/g, "");

  if (!/^[A-Za-z0-9][A-Za-z0-9-_]*$/.test(normalized)) {
    return "";
  }

  return normalized;
}

function sanitizeActivityId(value, index) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return normalized || `activity-${index + 1}`;
}

function humanizeType(type) {
  if (type === "quiz") {
    return "Quiz";
  }

  if (type === "text") {
    return "Short text";
  }

  return "Poll";
}

function defaultDescription(page) {
  return page === "join"
    ? "Answer the active prompt and stay synced with the presenter."
    : "A read-only results surface designed for Marp embeds and projected views.";
}

function clampIndex(value, total) {
  if (!Number.isFinite(value) || total <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(total - 1, Math.trunc(value)));
}

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);

  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, Math.trunc(numeric)));
}

function hashString(value) {
  let hash = 5381;

  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
  }

  return `s${(hash >>> 0).toString(36)}`;
}

function findDuplicateIds(ids) {
  const seen = new Set();
  const duplicates = new Set();

  ids.forEach((id) => {
    if (seen.has(id)) {
      duplicates.add(id);
    }
    seen.add(id);
  });

  return [...duplicates];
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}
