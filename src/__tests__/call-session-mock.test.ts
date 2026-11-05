import { afterEach, describe, expect, it } from "vitest";

import {
  CURRENT_CALL_ID,
  closeCall,
  currentCallSession,
  finishCall,
  keepCall,
  resetCall,
  resumeCall,
  startCall,
} from "@/data/call-session";
import { mockRecordingId } from "@/features/recording/backend";

/*
 * The call session in the browser and the tests (`CallSessionBackend
 * .layerMock`): the demo call in the page, synchronous like the Tauri
 * contract's order of states. Every action has changed the session by the
 * time it returns, before its promise settles.
 */

afterEach(() => {
  resetCall();
});

describe("CallSessionBackend.layerMock", () => {
  it("starts, finishes, resumes and closes the demo call at once", () => {
    startCall({ participantIds: ["olga"], projectId: "telemedia" });
    const started = currentCallSession();
    expect(started).toMatchObject({
      callId: CURRENT_CALL_ID,
      participantIds: ["olga"],
      projectId: "telemedia",
      status: "live",
    });
    expect(started.participants).toHaveLength(1);
    expect(started.recordingId).toBe(mockRecordingId());

    // A second «Начать» keeps the call.
    startCall({ projectId: null });
    expect(currentCallSession().projectId).toBe("telemedia");

    finishCall();
    expect(currentCallSession().status).toBe("finishing");
    expect(mockRecordingId()).toBeNull();

    resumeCall();
    expect(currentCallSession().status).toBe("live");
    expect(currentCallSession().recordingId).not.toBe(started.recordingId);

    keepCall();
    finishCall();
    closeCall(CURRENT_CALL_ID);
    expect(currentCallSession()).toMatchObject({
      callId: null,
      status: "idle",
    });
  });

  it("starts a call without a project, but not with people", async () => {
    const refused = await startCall({
      participantIds: ["olga"],
      projectId: null,
    });
    expect(refused.ok).toBe(false);
    expect(currentCallSession().status).toBe("idle");

    await startCall({ projectId: null });
    expect(currentCallSession()).toMatchObject({
      participants: [],
      projectId: null,
      status: "live",
    });
  });
});
