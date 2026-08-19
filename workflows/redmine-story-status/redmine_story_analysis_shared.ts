// deno-lint-ignore-file no-import-prefix
// Inline 'npm:' specifiers are kept deliberately: the swamp quality rubric rewards
// hermetic pinned imports, and relying on the shared root deno.json would both
// loosen the pin (zod@4 vs 4.4.3) and couple this extension to a file the other
// maintainer's extensions own. Same convention as repo-indexer/mod.ts and
// fact-store/_lib/impl.ts in this repo.
import { z } from "npm:zod@4.4.3";

export const MeetingSegmentSchema = z.object({
  id: z.string(),
  speaker: z.string().nullable(),
  start: z.string().nullable(),
  end: z.string().nullable(),
  text: z.string(),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
});

export const MeetingDocumentSchema = z.object({
  id: z.string(),
  path: z.string(),
  format: z.enum(["vtt", "markdown", "text"]),
  text: z.string(),
  segments: z.array(MeetingSegmentSchema),
  lineCount: z.number().int().nonnegative(),
  byteLength: z.number().int().nonnegative(),
});

export const CitationSchema = z.object({
  id: z.string(),
  source: z.string(),
  locator: z.string(),
});

export const ReferenceSchema = z.object({
  project: z.string(),
  iid: z.number().int().positive(),
  reference: z.string(),
  url: z.string(),
  sourceLocators: z.array(z.string()).min(1),
});

export const PromptItemSchema = z.object({
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  body: z.string(),
});

export const TaskAnalysisSchema = z.object({
  id: z.coerce.number().int().positive(),
  status: z.string().default("unknown"),
  utility: z.string().default(
    "Unknown: the evidence does not establish this task's utility.",
  ),
  achieved: z.string().default(
    "Unknown: no reliable progress evidence was found.",
  ),
  remaining: z.string().default(
    "Unknown: the remaining work is not established.",
  ),
  relevance: z.enum(["essential", "possibly_nonessential", "unknown"]).default(
    "unknown",
  ),
  blockers: z.array(z.string()).default([]),
  evidenceIds: z.array(z.string()).default([]),
});

export const ProgressItemSchema = z.object({
  label: z.string(),
  detail: z.string(),
  evidenceIds: z.array(z.string()).default([]),
});

export const RiskSchema = z.object({
  severity: z.enum(["high", "medium", "low", "unknown"]).default("unknown"),
  risk: z.string(),
  impact: z.string().default("Unknown impact."),
  mitigation: z.string().default("No mitigation established."),
  evidenceIds: z.array(z.string()).default([]),
});

export const AnalysisOutputSchema = z.object({
  status: z.enum([
    "not_started",
    "in_progress",
    "blocked",
    "ready_for_validation",
    "solved",
    "inconsistent",
    "unknown",
    "needs_input",
  ]).default("unknown"),
  confidence: z.enum(["high", "medium", "low"]).default("low"),
  solvedWhen: z.string().default("Not identified in the available evidence."),
  summary: z.string().default(
    "The available evidence is insufficient for a reliable summary.",
  ),
  progress: z.array(ProgressItemSchema).default([]),
  openTasks: z.array(TaskAnalysisSchema).default([]),
  risks: z.array(RiskSchema).default([]),
  questions: z.array(z.string()).default([]),
  dataGaps: z.array(z.string()).default([]),
});

export const AnalysisResourceSchema = z.object({
  storyId: z.number().int().positive(),
  facts: z.record(z.string(), z.unknown()),
  citations: z.array(CitationSchema),
  analysis: AnalysisOutputSchema,
  modelId: z.string(),
  generatedAt: z.string(),
});

export type MeetingDocument = z.infer<typeof MeetingDocumentSchema>;
export type MeetingSegment = z.infer<typeof MeetingSegmentSchema>;
export type Citation = z.infer<typeof CitationSchema>;
export type Reference = z.infer<typeof ReferenceSchema>;
export type PromptItem = z.infer<typeof PromptItemSchema>;

const VTT_TIMESTAMP =
  /^(\d{2}:\d{2}:\d{2}\.\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2}\.\d{3})/;
const URL_TOKEN = /https?:\/\/[^\s<>"']+/gi;
const EXPLICIT_REFERENCE =
  /(?:^|[\s([{"'`])([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)!([0-9]+)(?=$|[\s)\]}.,;:!?])/g;

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function extension(path: string): string {
  const name = basename(path).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot);
}

function speakerLine(line: string): { speaker: string | null; text: string } {
  const match = /^([^:\n]{1,80}):\s+(.*)$/.exec(line.trim());
  return match
    ? { speaker: match[1].trim(), text: match[2].trim() }
    : { speaker: null, text: line.trim() };
}

function flushCue(
  segments: MeetingSegment[],
  cue:
    | { start: string; end: string; lineStart: number; lines: string[] }
    | null,
  sequence: number,
): void {
  if (!cue) return;
  const nonEmpty = cue.lines.filter((line) => line.trim().length > 0);
  if (nonEmpty.length === 0) return;
  const first = speakerLine(nonEmpty[0]);
  const text = nonEmpty.map((line) => speakerLine(line).text).join("\n");
  segments.push({
    id: `cue-${sequence}`,
    speaker: first.speaker,
    start: cue.start,
    end: cue.end,
    text,
    lineStart: cue.lineStart,
    lineEnd: cue.lineStart + cue.lines.length - 1,
  });
}

export function parseMeetingDocument(
  path: string,
  raw: string,
): MeetingDocument {
  const ext = extension(path);
  const format = ext === ".vtt"
    ? "vtt"
    : ext === ".md" || ext === ".markdown"
    ? "markdown"
    : "text";
  const lines = raw.split(/\r?\n/);
  const segments: MeetingSegment[] = [];

  if (format === "vtt") {
    let cue:
      | { start: string; end: string; lineStart: number; lines: string[] }
      | null = null;
    let sequence = 0;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const timestamp = VTT_TIMESTAMP.exec(line.trim());
      if (timestamp) {
        flushCue(segments, cue, ++sequence);
        cue = {
          start: timestamp[1],
          end: timestamp[2],
          lineStart: index + 1,
          lines: [],
        };
      } else if (cue && line.trim() === "") {
        flushCue(segments, cue, ++sequence);
        cue = null;
      } else if (
        cue && !/^\d+$/.test(line.trim()) && line.trim() !== "WEBVTT"
      ) {
        cue.lines.push(line);
      }
    }
    flushCue(segments, cue, ++sequence);
  } else {
    for (let index = 0; index < lines.length; index++) {
      if (lines[index].trim()) {
        const parsed = speakerLine(lines[index]);
        segments.push({
          id: `line-${index + 1}`,
          speaker: parsed.speaker,
          start: null,
          end: null,
          text: parsed.text,
          lineStart: index + 1,
          lineEnd: index + 1,
        });
      }
    }
  }

  return {
    id: basename(path),
    path,
    format,
    text: raw,
    segments,
    lineCount: lines.length,
    byteLength: new TextEncoder().encode(raw).byteLength,
  };
}

function trimPunctuation(value: string): string {
  return value.replace(/[),.;:!?\]}>'"]+$/g, "");
}

export function extractGitlabReferences(
  _source: string,
  sourceText: string,
  locator: string,
  gitlabHost: string,
  output: Map<string, Reference>,
): void {
  const add = (project: string, iid: number) => {
    const key = `${project}!${iid}`;
    const existing = output.get(key);
    const sourceLocators = existing?.sourceLocators ?? [];
    if (!sourceLocators.includes(locator)) sourceLocators.push(locator);
    output.set(key, {
      project,
      iid,
      reference: key,
      url: `https://${gitlabHost}/${project}/-/merge_requests/${iid}`,
      sourceLocators,
    });
  };

  for (const token of sourceText.match(URL_TOKEN) ?? []) {
    try {
      const url = new URL(trimPunctuation(token));
      const parts = url.pathname.split("/").filter(Boolean);
      const marker = parts.findIndex((part, index) =>
        part === "-" && parts[index + 1] === "merge_requests"
      );
      if (marker >= 1 && parts[marker + 2] && /^\d+$/.test(parts[marker + 2])) {
        add(parts.slice(0, marker).join("/"), Number(parts[marker + 2]));
      }
    } catch {
      // Ignore malformed URLs; the unresolved source remains visible to the report.
    }
  }

  for (const match of sourceText.matchAll(EXPLICIT_REFERENCE)) {
    add(match[1], Number(match[2]));
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function numberValue(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function objectField(value: unknown, field: string): Record<string, unknown> {
  return asRecord(asRecord(value)[field]);
}

const HTML_ENTITY_NAMES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

/** Convert Teams' HTML message bodies into plain text without executing markup. */
export function stripHtml(value: string): string {
  return value
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(?:p|div|li|tr|h[1-6])\s*>/gi, "\n")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(
      /&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi,
      (entity, token: string) => {
        const normalized = token.toLowerCase();
        if (normalized in HTML_ENTITY_NAMES) {
          return HTML_ENTITY_NAMES[
            normalized
          ];
        }
        if (normalized.startsWith("#x")) {
          const codePoint = Number.parseInt(normalized.slice(2), 16);
          return Number.isFinite(codePoint)
            ? String.fromCodePoint(codePoint)
            : entity;
        }
        if (normalized.startsWith("#")) {
          const codePoint = Number.parseInt(normalized.slice(1), 10);
          return Number.isFinite(codePoint)
            ? String.fromCodePoint(codePoint)
            : entity;
        }
        return entity;
      },
    )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function buildEvidence(
  storyId: number,
  story: Record<string, unknown>,
  tasks: Array<Record<string, unknown>>,
  meetings: Record<string, unknown>,
  mergeRequests: Record<string, unknown>,
  redmineWebHost: string,
  // Structurally typed rather than importing ThreadResource from
  // _lib/teams_thread.ts: that module belongs to the local-only
  // teams_read_thread extension in o11n and is deliberately not published, so a
  // published extension must not import it. The union already admitted arbitrary
  // records and the import was type-only, so runtime behaviour is unchanged.
  teamsThread: Record<string, unknown> = {},
): {
  facts: Record<string, unknown>;
  citations: Citation[];
  items: PromptItem[];
} {
  const citations: Citation[] = [];
  const items: PromptItem[] = [];
  const addItem = (item: PromptItem, source: string, locator: string) => {
    items.push(item);
    citations.push({ id: item.id, source, locator });
  };
  const addChunked = (
    baseId: string,
    kind: string,
    title: string,
    body: string,
    source: string,
    locator: string,
  ): string[] => {
    const chunkSize = 5000;
    const chunks = body.length === 0
      ? [""]
      : Array.from({ length: Math.ceil(body.length / chunkSize) }, (_, index) =>
        body.slice(index * chunkSize, (index + 1) * chunkSize));
    return chunks.map((chunk, index) => {
      const id = chunks.length === 1 ? baseId : `${baseId}-${index + 1}`;
      addItem(
        {
          id,
          kind,
          title: chunks.length === 1
            ? title
            : `${title} (part ${index + 1}/${chunks.length})`,
          body: chunk,
        },
        source,
        chunks.length === 1
          ? locator
          : `${locator}#chars=${index * chunkSize}-${
            index * chunkSize + chunk.length - 1
          }`,
      );
      return id;
    });
  };

  const storyIdValue = numberValue(story.id) ?? storyId;
  const storyDescription = stringValue(story.description);
  const storySubject = stringValue(story.subject);
  const storyEvidenceIds = addChunked(
    `redmine-story-${storyIdValue}`,
    "redmine-story",
    `Story #${storyIdValue}: ${storySubject}`,
    storyDescription,
    "redmine",
    `issue:${storyIdValue}.description`,
  );

  // A Redmine journal is two unrelated things in one array: a field-change
  // record (notes empty, details populated) or on-the-record discussion (notes
  // non-empty). Only the discussion is evidence — the field changes are already
  // reflected in the story and task facts, and emitting them would bury the
  // comments that matter. Notes are textile/markdown, not HTML, so they are not
  // run through stripHtml the way Teams message bodies are.
  const journals = Array.isArray(story.journals)
    ? story.journals.map(asRecord)
    : [];
  const discussionFacts: Record<string, unknown>[] = [];
  for (const journal of journals) {
    const journalId = numberValue(journal.id);
    if (journalId === null) continue;
    const notes = stringValue(journal.notes).trim();
    if (notes.length === 0) continue;
    const author = stringValue(objectField(journal, "user").name) ||
      "Unknown author";
    const createdOn = stringValue(journal.createdOn) || "Unknown timestamp";
    const evidenceIds = addChunked(
      `redmine-comment-${journalId}`,
      "redmine-comment",
      `Comment #${journalId} on story #${storyIdValue} — ${author} @ ${createdOn}`,
      notes,
      "redmine",
      `issue:${storyIdValue}#journal=${journalId}`,
    );
    discussionFacts.push({
      id: journalId,
      author,
      createdOn,
      evidenceId: evidenceIds[0],
      evidenceIds,
    });
  }

  const taskFacts: Record<string, unknown>[] = [];
  for (const task of tasks) {
    const id = numberValue(task.id);
    if (id === null) continue;
    const subject = stringValue(task.subject);
    const itemId = `redmine-task-${id}`;
    const evidenceIds = addChunked(
      itemId,
      "redmine-task",
      `Task #${id}: ${subject}`,
      stringValue(task.description),
      "redmine",
      `issue:${id}.description`,
    );
    const status = objectField(task, "status");
    taskFacts.push({
      id,
      subject,
      status: stringValue(status.name),
      doneRatio: numberValue(task.doneRatio),
      assignedTo: objectField(task, "assignedTo").name ?? null,
      evidenceId: evidenceIds[0],
      evidenceIds,
    });
  }

  const meetingDocuments = Array.isArray(meetings.documents)
    ? meetings.documents
    : [];
  for (const value of meetingDocuments) {
    const document = asRecord(value);
    const id = stringValue(document.id);
    const path = stringValue(document.path);
    if (!id) continue;
    const segments = Array.isArray(document.segments)
      ? document.segments.map(asRecord)
      : [];
    if (segments.length === 0) {
      addChunked(
        `meeting-${id}`,
        "meeting-minutes",
        id,
        stringValue(document.text),
        "meeting",
        path,
      );
      continue;
    }
    for (const segment of segments) {
      const segmentId = stringValue(segment.id) || "segment";
      const speaker = stringValue(segment.speaker);
      const time = [stringValue(segment.start), stringValue(segment.end)]
        .filter(Boolean).join("-");
      const label = [id, speaker, time].filter(Boolean).join(" ");
      const locator = `${path}#lines=${stringValue(segment.lineStart)}-${
        stringValue(segment.lineEnd)
      }${time ? `&time=${time}` : ""}`;
      addChunked(
        `meeting-${id}-${segmentId}`,
        "meeting-minutes",
        label,
        stringValue(segment.text),
        "meeting",
        locator,
      );
    }
  }

  const mrValues = Array.isArray(mergeRequests.mergeRequests)
    ? mergeRequests.mergeRequests
    : [];
  const mrFacts: Record<string, unknown>[] = [];
  for (const value of mrValues) {
    const mr = asRecord(value);
    const project = stringValue(mr.project);
    const iid = numberValue(mr.iid);
    if (!project || iid === null) continue;
    const reference = `${project}!${iid}`;
    const itemId = `gitlab-mr-${
      project.replace(/[^A-Za-z0-9_-]/g, "-")
    }-${iid}`;
    // No host fallback: without webUrl or an explicit gitlabHost, cite the
    // project!iid reference rather than fabricate a URL against a guessed host.
    const mrHost = stringValue(mr.gitlabHost);
    const url = stringValue(mr.webUrl) ||
      (mrHost
        ? `https://${mrHost}/${project}/-/merge_requests/${iid}`
        : reference);
    const evidenceIds = addChunked(
      itemId,
      "gitlab-mr",
      `${reference}: ${stringValue(mr.title)}`,
      [stringValue(mr.description), stringValue(mr.summary)].filter(Boolean)
        .join("\n\n"),
      "gitlab",
      url,
    );
    mrFacts.push({
      project,
      iid,
      reference,
      title: stringValue(mr.title),
      state: stringValue(mr.state).toLowerCase(),
      classification: stringValue(mr.classification),
      draft: Boolean(mr.draft),
      mergeable: mr.mergeable ?? null,
      detailedMergeStatus: mr.detailedMergeStatus ?? null,
      blockers: Array.isArray(mr.blockers) ? mr.blockers : [],
      webUrl: url,
      evidenceId: evidenceIds[0],
      evidenceIds,
      sourceLocators: Array.isArray(mr.sourceLocators) ? mr.sourceLocators : [],
    });
  }

  const teamsThreadRecord = asRecord(teamsThread);
  const teamsReplies = Array.isArray(teamsThreadRecord.replies)
    ? teamsThreadRecord.replies.map(asRecord)
    : [];
  const root = asRecord(teamsThreadRecord.root);
  const teamsMessages = Object.keys(root).length > 0
    ? [root, ...teamsReplies]
    : teamsReplies;
  const participants: string[] = [];
  for (const [index, message] of teamsMessages.entries()) {
    const messageId = stringValue(message.id) || `message-${index + 1}`;
    const from = objectField(message, "from");
    const author = stringValue(objectField(from, "user").displayName) ||
      stringValue(objectField(from, "application").displayName);
    const authorLabel = author || "Unknown author";
    if (author && !participants.includes(author)) participants.push(author);
    const timestamp = stringValue(message.createdDateTime) ||
      "Unknown timestamp";
    const text = stripHtml(stringValue(objectField(message, "body").content));
    const itemId = `teams-message-${messageId.replace(/[^A-Za-z0-9_-]/g, "-")}`;
    const locator =
      `teams:${stringValue(teamsThreadRecord.channelId)}/${
        stringValue(teamsThreadRecord.parentMessageId)
      }` +
      `#message=${messageId}`;
    addChunked(
      itemId,
      "teams-message",
      `Teams message ${messageId} — ${authorLabel} @ ${timestamp}`,
      text,
      "teams",
      locator,
    );
  }

  const teamsFacts = Object.keys(teamsThreadRecord).length > 0
    ? {
      channelName: stringValue(teamsThreadRecord.channelName) || null,
      totalReplies: numberValue(teamsThreadRecord.totalReplies) ??
        teamsReplies.length,
      truncated: teamsThreadRecord.truncated === true,
      participants,
    }
    : null;

  const storyStatus = objectField(story, "status");
  const storyTracker = objectField(story, "tracker");
  const facts: Record<string, unknown> = {
    story: {
      id: storyIdValue,
      subject: storySubject,
      status: stringValue(storyStatus.name),
      tracker: stringValue(storyTracker.name),
      doneRatio: numberValue(story.doneRatio),
      dueDate: story.dueDate ?? null,
      url: `${redmineWebHost.replace(/\/$/, "")}/issues/${storyIdValue}`,
      evidenceId: storyEvidenceIds[0],
      evidenceIds: storyEvidenceIds,
    },
    tasks: taskFacts,
    discussion: discussionFacts,
    mergeRequests: mrFacts,
    unresolvedMergeRequests: Array.isArray(mergeRequests.unresolved)
      ? mergeRequests.unresolved
      : [],
    meetingWarnings: Array.isArray(meetings.warnings) ? meetings.warnings : [],
    ...(teamsFacts ? { teams: teamsFacts } : {}),
  };

  return { facts, citations, items };
}

export function factsForPrompt(
  facts: Record<string, unknown>,
): Record<string, unknown> {
  const story = asRecord(facts.story);
  const tasks = Array.isArray(facts.tasks) ? facts.tasks : [];
  const mergeRequests = Array.isArray(facts.mergeRequests)
    ? facts.mergeRequests
    : [];
  const discussion = Array.isArray(facts.discussion) ? facts.discussion : [];
  return {
    story: {
      id: story.id,
      status: story.status,
      tracker: story.tracker,
      doneRatio: story.doneRatio,
      evidenceIds: story.evidenceIds ?? [story.evidenceId],
    },
    tasks: tasks.map((value) => {
      const task = asRecord(value);
      return {
        id: task.id,
        status: task.status,
        doneRatio: task.doneRatio,
        evidenceIds: task.evidenceIds ?? [task.evidenceId],
      };
    }),
    mergeRequests: mergeRequests.map((value) => {
      const mr = asRecord(value);
      return {
        project: mr.project,
        iid: mr.iid,
        reference: mr.reference,
        state: mr.state,
        classification: mr.classification,
        draft: mr.draft,
        mergeable: mr.mergeable,
        detailedMergeStatus: mr.detailedMergeStatus,
        blockers: mr.blockers,
        evidenceIds: mr.evidenceIds ?? [mr.evidenceId],
      };
    }),
    discussion: discussion.map((value) => {
      const comment = asRecord(value);
      return {
        id: comment.id,
        author: comment.author,
        createdOn: comment.createdOn,
        evidenceIds: comment.evidenceIds ?? [comment.evidenceId],
      };
    }),
    unresolvedMergeRequests: facts.unresolvedMergeRequests ?? [],
    meetingWarnings: facts.meetingWarnings ?? [],
    ...(facts.teams ? { teams: facts.teams } : {}),
  };
}
