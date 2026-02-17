/**
 * Synthesis & Narrative Assembly — Phase 12
 *
 * Transforms a flat list of distilled chunks into topic-grouped,
 * deduplicated, contradiction-resolved narrative sections that produce
 * natural conversation turns.
 *
 * Pipeline:
 *  1. classifyChunkTopic()  — assign a topic label per chunk (keyword-based)
 *  2. groupByTopic()        — bucket chunks by topic
 *  3. deduplicateWithinGroup() — Jaccard similarity to drop near-dupes
 *  4. resolveContradictions()  — latest-timestamp wins for conflicting info
 *  5. assembleSynthesis()   — order topics narratively, merge groups
 *  6. generateConversationFromSynthesis() — emit ConversationEvent[] for JSONL
 */

import type { Chunk } from "../scoring/chunker.ts";

// ─── 12.1 Topic Taxonomy ────────────────────────────────────────────────────

/** Canonical topic labels used for classification and narrative ordering. */
export const TOPIC_TAXONOMY = [
  "overview",
  "architecture",
  "file-structure",
  "patterns",
  "decisions",
  "dependencies",
  "deployment",
  "recent-changes",
  "known-issues",
] as const;

export type TopicLabel = (typeof TOPIC_TAXONOMY)[number];

/** Human-readable display names for conversation turns. */
export const TOPIC_DISPLAY_NAMES: Record<TopicLabel, string> = {
  "overview": "project overview and goals",
  "architecture": "architecture and design",
  "file-structure": "file structure and organization",
  "patterns": "code patterns and conventions",
  "decisions": "key decisions and trade-offs",
  "dependencies": "dependencies and tooling",
  "deployment": "deployment and infrastructure",
  "recent-changes": "recent changes and work in progress",
  "known-issues": "known issues and technical debt",
};

// ─── 12.6 Narrative Ordering ────────────────────────────────────────────────

/**
 * Defines the order topics appear in the generated conversation.
 * Starts broad (overview, architecture) and narrows to specifics.
 */
export const NARRATIVE_ORDER: readonly TopicLabel[] = [
  "overview",
  "architecture",
  "file-structure",
  "patterns",
  "dependencies",
  "deployment",
  "decisions",
  "recent-changes",
  "known-issues",
] as const;

// ─── 12.2 Topic Classifier ─────────────────────────────────────────────────

/** Keyword sets for each topic. Matched against lowercased chunk content. */
const TOPIC_KEYWORDS: Record<TopicLabel, string[]> = {
  "overview": ["project", "goal", "purpose", "overview", "summary", "what we're building", "the app", "the system"],
  "architecture": ["architect", "design", "system design", "pattern", "layer", "module", "component", "service", "gateway", "adapter", "pipeline", "event-driven", "microservice", "monolith"],
  "file-structure": ["directory", "folder", "file structure", "file path", "src/", "lib/", "package.json", "tsconfig", "index.ts", "tree", "layout"],
  "patterns": ["pattern", "convention", "style", "naming", "idiom", "best practice", "approach", "technique", "factory", "singleton", "observer", "middleware", "hook"],
  "decisions": ["decision", "decided", "chose", "trade-off", "tradeoff", "why we", "instead of", "alternative", "considered", "rejected", "opted"],
  "dependencies": ["dependency", "dependencies", "package", "library", "framework", "runtime", "bun", "node", "npm", "yarn", "install", "version", "upgrade", "typescript", "react", "vue", "svelte"],
  "deployment": ["deploy", "production", "staging", "ci/cd", "docker", "railway", "vercel", "netlify", "aws", "gcp", "cloudflare", "build", "release", "pipeline", "github actions", "workflow"],
  "recent-changes": ["recent", "latest", "just", "added", "changed", "updated", "modified", "new feature", "implemented", "refactor", "yesterday", "today", "this week", "commit", "merge", "pr"],
  "known-issues": ["bug", "issue", "error", "broken", "fix", "todo", "hack", "workaround", "technical debt", "flaky", "failing", "regression", "crash", "memory leak", "performance"],
};

/**
 * 12.2: Classify a chunk into a topic using keyword matching.
 * Returns the topic with the highest keyword hit count.
 * Falls back to "overview" if no keywords match.
 */
export function classifyChunkTopic(chunk: Chunk): TopicLabel {
  const content = chunk.events.map((e) => e.content).join(" ").toLowerCase();
  const toolContent = chunk.events
    .map((e) => [e.toolName || "", e.toolOutput || ""].join(" "))
    .join(" ")
    .toLowerCase();
  const fullText = `${content} ${toolContent}`;

  let bestTopic: TopicLabel = "overview";
  let bestScore = 0;

  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS) as [TopicLabel, string[]][]) {
    let score = 0;
    for (const kw of keywords) {
      // Count occurrences for weighting
      const regex = new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      const matches = fullText.match(regex);
      if (matches) score += matches.length;
    }
    if (score > bestScore) {
      bestScore = score;
      bestTopic = topic;
    }
  }

  return bestTopic;
}

// ─── 12.3 Group By Topic ───────────────────────────────────────────────────

/**
 * 12.3: Group chunks by their classified topic.
 */
export function groupByTopic(chunks: Chunk[]): Map<TopicLabel, Chunk[]> {
  const groups = new Map<TopicLabel, Chunk[]>();

  for (const chunk of chunks) {
    const topic = classifyChunkTopic(chunk);
    const existing = groups.get(topic) || [];
    existing.push(chunk);
    groups.set(topic, existing);
  }

  return groups;
}

// ─── 12.4 Deduplication ────────────────────────────────────────────────────

/**
 * Tokenize content into a set of normalized words for Jaccard comparison.
 */
function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

/**
 * Jaccard similarity between two token sets: |A ∩ B| / |A ∪ B|.
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * 12.4: Remove near-duplicate chunks within a topic group.
 * Keeps the chunk with higher importanceAvg when Jaccard > threshold.
 */
export function deduplicateWithinGroup(chunks: Chunk[], threshold = 0.6): Chunk[] {
  if (chunks.length <= 1) return [...chunks];

  const tokenSets = chunks.map((c) => tokenize(c.events.map((e) => e.content).join(" ")));
  const keep = new Set<number>(chunks.map((_, i) => i));

  for (let i = 0; i < chunks.length; i++) {
    if (!keep.has(i)) continue;
    for (let j = i + 1; j < chunks.length; j++) {
      if (!keep.has(j)) continue;
      const sim = jaccardSimilarity(tokenSets[i], tokenSets[j]);
      if (sim >= threshold) {
        // Drop the lower-importance chunk
        if (chunks[i].importanceAvg >= chunks[j].importanceAvg) {
          keep.delete(j);
        } else {
          keep.delete(i);
          break; // i is removed, stop comparing from i
        }
      }
    }
  }

  return chunks.filter((_, i) => keep.has(i));
}

// ─── 12.5 Contradiction Resolution ─────────────────────────────────────────

/**
 * Extract the latest timestamp from a chunk's events.
 * Returns epoch 0 if no timestamps are present.
 */
function latestTimestamp(chunk: Chunk): number {
  let latest = 0;
  for (const event of chunk.events) {
    if (event.timestamp) {
      const ts = new Date(event.timestamp).getTime();
      if (ts > latest) latest = ts;
    }
  }
  return latest;
}

/**
 * 12.5: When same topic has conflicting info, keep latest by timestamp.
 * Simple approach: sort by timestamp descending, keep top N chunks
 * that fit the content within reasonable bounds.
 *
 * For v1, we don't do semantic conflict detection — we rely on
 * recency as a proxy for correctness (most recent info wins).
 * Chunks are sorted so the most recent appears last in output (chronological).
 */
export function resolveContradictions(chunks: Chunk[]): Chunk[] {
  if (chunks.length <= 1) return [...chunks];

  // Sort by latest timestamp ascending (chronological order for output)
  return [...chunks].sort((a, b) => latestTimestamp(a) - latestTimestamp(b));
}

// ─── 12.7 Assemble Synthesis ───────────────────────────────────────────────

/** A synthesized topic ready for conversation generation. */
export interface SynthesizedTopic {
  topic: TopicLabel;
  displayName: string;
  chunks: Chunk[];
  totalTokens: number;
}

/**
 * 12.7: Assemble synthesis from grouped, deduplicated, ordered chunks.
 *
 * Pipeline per topic:
 *  1. Deduplicate within group
 *  2. Resolve contradictions (sort by recency)
 *  3. Compute total tokens
 *
 * Topics are returned in NARRATIVE_ORDER.
 * Empty topics are omitted.
 */
export function assembleSynthesis(groups: Map<TopicLabel, Chunk[]>): SynthesizedTopic[] {
  const result: SynthesizedTopic[] = [];

  for (const topic of NARRATIVE_ORDER) {
    const rawChunks = groups.get(topic);
    if (!rawChunks || rawChunks.length === 0) continue;

    // Step 1: Deduplicate
    const deduped = deduplicateWithinGroup(rawChunks);

    // Step 2: Resolve contradictions (sort chronologically)
    const resolved = resolveContradictions(deduped);

    // Step 3: Compute total tokens
    const totalTokens = resolved.reduce((sum, c) => sum + c.tokenEstimate, 0);

    result.push({
      topic,
      displayName: TOPIC_DISPLAY_NAMES[topic],
      chunks: resolved,
      totalTokens,
    });
  }

  return result;
}

// ─── 12.8 Generate Conversation From Synthesis ─────────────────────────────

/** A structured turn ready for the conversation generator. */
export interface ConversationTurn {
  role: "user" | "assistant";
  topic: TopicLabel;
  content: string;
  chunks: Chunk[];
}

/**
 * 12.8: Generate conversation turns from synthesized topics.
 * Each topic produces a user question + assistant answer pair.
 *
 * The conversationGenerator.ts module handles the actual JSONL event
 * formatting — this function produces the logical turn structure.
 */
export function generateConversationFromSynthesis(topics: SynthesizedTopic[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];

  for (const synth of topics) {
    // User asks about the topic
    turns.push({
      role: "user",
      topic: synth.topic,
      content: generateTopicQuestion(synth.topic, synth.chunks.length),
      chunks: [],
    });

    // Assistant responds with chunk content
    const assistantContent = synthesizeAssistantResponse(synth.chunks);
    turns.push({
      role: "assistant",
      topic: synth.topic,
      content: assistantContent,
      chunks: synth.chunks,
    });
  }

  return turns;
}

/**
 * Generate a natural user question for a topic.
 */
function generateTopicQuestion(topic: TopicLabel, chunkCount: number): string {
  const display = TOPIC_DISPLAY_NAMES[topic];

  const questions: Record<TopicLabel, string> = {
    "overview": "Can you give me an overview of the project — what it does, its goals, and the main components?",
    "architecture": `Tell me about the ${display}. What are the main layers, modules, and how do they interact?`,
    "file-structure": "How is the project organized? Walk me through the file structure and key directories.",
    "patterns": `What ${display} are used in this project? What conventions should I follow?`,
    "decisions": `What are the ${display} that were made? Why were certain approaches chosen over alternatives?`,
    "dependencies": `What about ${display}? What's the tech stack and key libraries?`,
    "deployment": `How does ${display} work? What's the CI/CD pipeline and hosting setup?`,
    "recent-changes": `What are the ${display}? What's been implemented recently or is in progress?`,
    "known-issues": `Are there any ${display}? What technical debt or bugs should I be aware of?`,
  };

  return questions[topic] || `Tell me about the ${display} — what are the key details I should know?`;
}

/**
 * Synthesize chunk content into a coherent assistant response.
 */
function synthesizeAssistantResponse(chunks: Chunk[]): string {
  const parts: string[] = [];

  for (const chunk of chunks) {
    for (const event of chunk.events) {
      if (event.role === "assistant" && event.content.trim()) {
        parts.push(event.content.trim());
      } else if (event.role === "user" && event.content.trim() && event.content.length > 50) {
        parts.push(`Based on the discussion: ${event.content.trim().slice(0, 2000)}`);
      }
      if (event.toolName && event.toolOutput) {
        parts.push(`Tool ${event.toolName}: ${event.toolOutput.trim().slice(0, 1000)}`);
      }
    }
  }

  if (parts.length === 0) {
    return chunks.map((c) => c.events.map((e) => e.content).join("\n")).join("\n\n");
  }

  return parts.join("\n\n");
}
