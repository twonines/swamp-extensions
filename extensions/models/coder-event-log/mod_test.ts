// ABOUTME: Unit tests for coder-event-log extension model.
// ABOUTME: Validates webhook payload parsing and event recording.
import { assertEquals, assertRejects } from "jsr:@std/assert";
import { createModelTestContext } from "@systeminit/swamp-testing";
import { model } from "./mod.ts";

Deno.test("record - parses valid Coder notification payload", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
    methodName: "record",
  });

  const payload = JSON.stringify({
    msg_id: "msg-abc-123",
    title: "Workspace sandbox started",
    body: "Your workspace is now running",
    payload: {
      notification_name: "workspace_started",
      labels: { workspace: "sandbox", owner: "admin" },
      actions: [
        { label: "Open workspace", url: "http://localhost:3000/workspace/sandbox" },
      ],
    },
  });

  const result = await model.methods.record.execute({ payload }, context);
  assertEquals(result.dataHandles.length, 1);

  const resources = getWrittenResources();
  // deno-lint-ignore no-explicit-any
  const data = resources[0].data as any;
  assertEquals(data.msgId, "msg-abc-123");
  assertEquals(data.title, "Workspace sandbox started");
  assertEquals(data.body, "Your workspace is now running");
  assertEquals(data.notificationName, "workspace_started");
  assertEquals(data.labels.workspace, "sandbox");
  assertEquals(data.actions.length, 1);
  assertEquals(data.actions[0].label, "Open workspace");
  assertEquals(typeof data.receivedAt, "string");
  assertEquals(data.rawPayloadSize, payload.length);
  assertEquals(resources[0].name, "msg-abc-123");
});

Deno.test("record - handles minimal payload without optional fields", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
    methodName: "record",
  });

  const payload = JSON.stringify({
    msg_id: "msg-minimal",
    title: "Something happened",
  });

  await model.methods.record.execute({ payload }, context);

  // deno-lint-ignore no-explicit-any
  const data = getWrittenResources()[0].data as any;
  assertEquals(data.msgId, "msg-minimal");
  assertEquals(data.notificationName, undefined);
  assertEquals(data.labels, undefined);
  assertEquals(data.actions, undefined);
});

Deno.test("record - throws on invalid JSON", async () => {
  const { context } = createModelTestContext({
    globalArgs: {},
    methodName: "record",
  });

  await assertRejects(
    () => model.methods.record.execute({ payload: "not valid json{{{" }, context),
    Error,
    "Invalid JSON payload",
  );
});

Deno.test("record - handles missing msg_id gracefully", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: {},
    methodName: "record",
  });

  const payload = JSON.stringify({ title: "No ID event" });

  await model.methods.record.execute({ payload }, context);

  // deno-lint-ignore no-explicit-any
  const data = getWrittenResources()[0].data as any;
  assertEquals(data.msgId, "unknown");
});
