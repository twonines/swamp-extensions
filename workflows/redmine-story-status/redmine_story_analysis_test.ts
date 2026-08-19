import {
  buildEvidence,
  extractGitlabReferences,
  parseMeetingDocument,
  stripHtml,
} from "./redmine_story_analysis_shared.ts";

Deno.test("parses VTT speakers and timestamps while preserving source lines", () => {
  const document = parseMeetingDocument(
    "/tmp/design-session.vtt",
    "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nAlice: We agreed to ship it.\n\n",
  );
  if (document.format !== "vtt") throw new Error("Expected VTT format");
  if (document.segments.length !== 1) {
    throw new Error("Expected one VTT segment");
  }
  const segment = document.segments[0];
  if (segment.speaker !== "Alice") {
    throw new Error("Expected speaker attribution");
  }
  if (segment.start !== "00:00:01.000") {
    throw new Error("Expected start timestamp");
  }
  if (!segment.text.includes("We agreed")) {
    throw new Error("Expected transcript text");
  }
});

Deno.test("extracts explicit GitLab references from URLs and project references", () => {
  const references = new Map<
    string,
    Parameters<typeof extractGitlabReferences>[4] extends Map<string, infer V>
      ? V
      : never
  >();
  extractGitlabReferences(
    "story",
    "See https://gitlab.example.com/group/app/-/merge_requests/12 and group/app!12.",
    "redmine:issue:123.description",
    "gitlab.example.com",
    references,
  );
  if (references.size !== 1) {
    throw new Error(
      `Expected one deduplicated reference, got ${references.size}`,
    );
  }
  const reference = [...references.values()][0];
  if (reference.reference !== "group/app!12") {
    throw new Error("Unexpected reference value");
  }
  if (reference.sourceLocators.length !== 1) {
    throw new Error("Expected one source locator");
  }
});

Deno.test("chunks long evidence so the sanitizer does not drop the rest of a document", () => {
  const body = "x".repeat(12001);
  const evidence = buildEvidence(
    999999,
    {
      id: 999999,
      subject: "Long story",
      description: body,
      status: { name: "In Progress" },
      tracker: { name: "Story" },
    },
    [],
    { documents: [], warnings: [] },
    { mergeRequests: [], unresolved: [] },
    "https://redmine.example.com",
  );
  const storyItems = evidence.items.filter((item) =>
    item.kind === "redmine-story"
  );
  if (storyItems.length !== 3) {
    throw new Error(`Expected three chunks, got ${storyItems.length}`);
  }
  if (storyItems.some((item) => item.body.length > 5000)) {
    throw new Error("A chunk exceeded the sanitizer-safe size");
  }
});

Deno.test("strips Teams HTML markup and decodes common entities", () => {
  const text = stripHtml(
    "<p>Hello <strong>Teams</strong></p><p>Decision &amp; rationale<br>next</p>" +
      "<script>ignore this</script>",
  );
  if (text !== "Hello Teams\nDecision & rationale\nnext") {
    throw new Error(`Unexpected stripped HTML: ${text}`);
  }
});

Deno.test("builds cited Teams evidence with attribution, locator, and facts", () => {
  const evidence = buildEvidence(
    123,
    {
      id: 123,
      subject: "Story",
      description: "Description",
      status: { name: "In Progress" },
      tracker: { name: "Story" },
    },
    [],
    { documents: [], warnings: [] },
    { mergeRequests: [], unresolved: [] },
    "https://redmine.example",
    {
      teamId: "team-1",
      channelId: "channel-1",
      channelName: "Example Channel",
      parentMessageId: "parent-1",
      root: {
        id: "root-1",
        createdDateTime: "2026-08-11T12:00:00Z",
        from: { user: { displayName: "Alice" } },
        body: { content: "<p>Decision text</p>" },
      },
      replies: [{
        id: "reply-1",
        createdDateTime: "2026-08-11T12:05:00Z",
        from: { user: { displayName: "Bob" } },
        body: { content: "<p>Follow-up</p>" },
      }],
      totalReplies: 1,
      truncated: false,
      fetchedAt: "2026-08-11T12:06:00Z",
    },
  );

  const teamsItems = evidence.items.filter((item) =>
    item.kind === "teams-message"
  );
  if (teamsItems.length !== 2) {
    throw new Error(`Expected two Teams items, got ${teamsItems.length}`);
  }
  if (teamsItems[0].body !== "Decision text") {
    throw new Error("Expected stripped root body");
  }
  if (
    !teamsItems[0].title.includes("Alice") ||
    !teamsItems[0].title.includes("2026-08-11T12:00:00Z")
  ) {
    throw new Error("Expected root author and timestamp in the title");
  }
  if (teamsItems[1].body !== "Follow-up") {
    throw new Error("Expected stripped reply body");
  }

  const rootCitation = evidence.citations.find((citation) =>
    citation.id === teamsItems[0].id
  );
  if (rootCitation?.source !== "teams") {
    throw new Error("Expected Teams citation source");
  }
  if (rootCitation.locator !== "teams:channel-1/parent-1#message=root-1") {
    throw new Error(`Unexpected Teams locator: ${rootCitation?.locator}`);
  }

  const teamsFacts = evidence.facts.teams as Record<string, unknown>;
  if (teamsFacts.channelName !== "Example Channel") {
    throw new Error("Expected channel name fact");
  }
  if (teamsFacts.totalReplies !== 1) {
    throw new Error("Expected reply count fact");
  }
  if (teamsFacts.truncated !== false) {
    throw new Error("Expected non-truncated fact");
  }
  if (
    JSON.stringify(teamsFacts.participants) !== JSON.stringify(["Alice", "Bob"])
  ) {
    throw new Error("Expected unique Teams participants");
  }
});

Deno.test("chunks a long Teams message while retaining its citation locator", () => {
  const evidence = buildEvidence(
    123,
    { id: 123, subject: "Story", description: "", status: {}, tracker: {} },
    [],
    { documents: [], warnings: [] },
    { mergeRequests: [], unresolved: [] },
    "https://redmine.example",
    {
      channelId: "channel-1",
      parentMessageId: "parent-1",
      root: {
        id: "long-1",
        from: { user: { displayName: "Alice" } },
        createdDateTime: "2026-08-11T12:00:00Z",
        body: { content: `<p>${"x".repeat(12001)}</p>` },
      },
      replies: [],
      totalReplies: 0,
      truncated: false,
    },
  );
  const teamsItems = evidence.items.filter((item) =>
    item.kind === "teams-message"
  );
  if (teamsItems.length !== 3) {
    throw new Error(`Expected three Teams chunks, got ${teamsItems.length}`);
  }
  if (
    teamsItems.some((item) =>
      item.body.length > 5000 || item.body.includes("<p>")
    )
  ) {
    throw new Error("Teams chunks were not safely stripped or bounded");
  }
  const citations = evidence.citations.filter((citation) =>
    citation.id.startsWith("teams-message-long-1")
  );
  if (
    citations.length !== 3 ||
    citations.some((citation) => !citation.locator.includes("#message=long-1"))
  ) {
    throw new Error("Expected a locator for every Teams chunk");
  }
});

Deno.test("absent or empty Teams threads add no evidence and do not crash", () => {
  const args: [
    number,
    Record<string, unknown>,
    Array<Record<string, unknown>>,
    Record<string, unknown>,
    Record<string, unknown>,
    string,
  ] = [
    123,
    { id: 123, subject: "Story", description: "", status: {}, tracker: {} },
    [],
    { documents: [], warnings: [] },
    { mergeRequests: [], unresolved: [] },
    "https://redmine.example",
  ];
  for (const evidence of [buildEvidence(...args), buildEvidence(...args, {})]) {
    if (evidence.items.some((item) => item.kind === "teams-message")) {
      throw new Error("An empty Teams thread produced evidence");
    }
    if ("teams" in evidence.facts) {
      throw new Error("An absent Teams thread produced facts");
    }
  }
});

Deno.test("turns Redmine journal notes into citable comment evidence, skipping field-change records", () => {
  const evidence = buildEvidence(
    999999,
    {
      id: 999999,
      subject: "Story with discussion",
      description: "Story body.",
      status: { name: "In Progress" },
      tracker: { name: "Story" },
      journals: [
        // Field-change only: no notes, must not become evidence.
        {
          id: 1,
          user: { id: 7, name: "Ada Lovelace" },
          notes: "",
          createdOn: "2026-08-01T10:00:00Z",
          details: [{
            property: "attr",
            name: "status_id",
            oldValue: "1",
            newValue: "2",
          }],
        },
        // Whitespace-only notes are field changes too.
        {
          id: 2,
          user: { id: 7, name: "Ada Lovelace" },
          notes: "   \n  ",
          createdOn: "2026-08-02T10:00:00Z",
          details: [],
        },
        // Real discussion.
        {
          id: 3,
          user: { id: 8, name: "Grace Hopper" },
          notes:
            "We ruled out the batch approach; the registry scan is the blocker.",
          createdOn: "2026-08-03T10:00:00Z",
          details: [],
        },
      ],
    },
    [],
    { documents: [], warnings: [] },
    { mergeRequests: [], unresolved: [] },
    "https://redmine.example.com",
  );

  const comments = evidence.items.filter((item) =>
    item.kind === "redmine-comment"
  );
  if (comments.length !== 1) {
    throw new Error(
      `Expected only the notes-bearing journal, got ${comments.length}`,
    );
  }
  if (comments[0].id !== "redmine-comment-3") {
    throw new Error(`Unexpected comment item id: ${comments[0].id}`);
  }
  if (!comments[0].body.includes("ruled out the batch approach")) {
    throw new Error("Expected the note text in the evidence body");
  }
  if (!comments[0].title.includes("Grace Hopper")) {
    throw new Error("Expected the comment author in the title");
  }

  const citation = evidence.citations.find((entry) =>
    entry.id === "redmine-comment-3"
  );
  if (!citation) throw new Error("Expected a citation for the comment");
  if (citation.source !== "redmine") {
    throw new Error(`Unexpected citation source: ${citation.source}`);
  }
  if (citation.locator !== "issue:999999#journal=3") {
    throw new Error(`Unexpected citation locator: ${citation.locator}`);
  }

  const discussion = evidence.facts.discussion;
  if (!Array.isArray(discussion) || discussion.length !== 1) {
    throw new Error("Expected one discussion fact");
  }
  const comment = discussion[0] as Record<string, unknown>;
  if (comment.id !== 3 || comment.author !== "Grace Hopper") {
    throw new Error("Unexpected discussion fact contents");
  }
  if (comment.evidenceId !== "redmine-comment-3") {
    throw new Error("Discussion fact must cite its evidence item");
  }
});

Deno.test("chunks a long Redmine comment and keeps every chunk citable", () => {
  const evidence = buildEvidence(
    999999,
    {
      id: 999999,
      subject: "Story with a long comment",
      description: "",
      status: { name: "In Progress" },
      tracker: { name: "Story" },
      journals: [{
        id: 42,
        user: { id: 9, name: "Katherine Johnson" },
        notes: "y".repeat(12001),
        createdOn: "2026-08-04T10:00:00Z",
        details: [],
      }],
    },
    [],
    { documents: [], warnings: [] },
    { mergeRequests: [], unresolved: [] },
    "https://redmine.example.com",
  );
  const comments = evidence.items.filter((item) =>
    item.kind === "redmine-comment"
  );
  if (comments.length !== 3) {
    throw new Error(`Expected three comment chunks, got ${comments.length}`);
  }
  if (comments.some((item) => item.body.length > 5000)) {
    throw new Error("A comment chunk exceeded the sanitizer-safe size");
  }
  const discussion = evidence.facts.discussion as Record<string, unknown>[];
  const evidenceIds = discussion[0].evidenceIds as string[];
  if (evidenceIds.length !== 3) {
    throw new Error("Expected the discussion fact to list all three chunk ids");
  }
  for (const id of evidenceIds) {
    if (!evidence.citations.some((entry) => entry.id === id)) {
      throw new Error(`Chunk ${id} has no citation`);
    }
  }
});

Deno.test("a story with no journals produces no discussion evidence", () => {
  const evidence = buildEvidence(
    999999,
    {
      id: 999999,
      subject: "Quiet story",
      description: "Story body.",
      status: { name: "New" },
      tracker: { name: "Story" },
    },
    [],
    { documents: [], warnings: [] },
    { mergeRequests: [], unresolved: [] },
    "https://redmine.example.com",
  );
  if (evidence.items.some((item) => item.kind === "redmine-comment")) {
    throw new Error("Expected no comment evidence without journals");
  }
  const discussion = evidence.facts.discussion;
  if (!Array.isArray(discussion) || discussion.length !== 0) {
    throw new Error("Expected an empty discussion array, not a missing key");
  }
});
