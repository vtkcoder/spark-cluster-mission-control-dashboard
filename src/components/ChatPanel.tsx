"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { ArcGauge } from "./ArcGauge";

// ── Types ────────────────────────────────────────────────────────────────────

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  promptTokens?: number;
  completionTokens?: number;
  tps?: number;
  ttft?: number;
  streaming?: boolean;
}

interface ChatSession {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
}

interface Attachment {
  id: string;
  type: "image" | "text" | "other";
  name: string;
  content: string; // text content or base64 data URL
  mimeType: string;
  size: number;
}

interface LiveStats {
  tps: number;
  promptTokens: number;
  completionTokens: number;
  ttft: number;
}

interface ChatPanelProps {
  vllmOnline: boolean;
  modelName: string | null;
  maxModelLen: number | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

function fmtTokens(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

function fmtMs(ms: number): string {
  if (ms >= 1000) return (ms / 1000).toFixed(1) + "s";
  return ms + "ms";
}

function speedColor(tps: number): string {
  if (tps <= 0) return "#334155";
  if (tps >= 20) return "#10b981";
  if (tps >= 8) return "#f59e0b";
  return "#ef4444";
}

function isTextFilename(name: string): boolean {
  const exts = [".txt", ".md", ".py", ".js", ".ts", ".tsx", ".jsx", ".json",
    ".yaml", ".yml", ".toml", ".css", ".html", ".xml", ".csv", ".sh", ".bash",
    ".rs", ".go", ".java", ".c", ".cpp", ".h", ".hpp", ".rb", ".php", ".sql",
    ".log", ".env", ".conf", ".ini", ".cfg", ".diff", ".patch"];
  const lower = name.toLowerCase();
  return exts.some(e => lower.endsWith(e)) || !name.includes(".");
}

function langFromFilename(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const m: Record<string, string> = {
    py: "python", js: "javascript", ts: "typescript", tsx: "tsx", jsx: "jsx",
    json: "json", yaml: "yaml", yml: "yaml", sh: "bash", bash: "bash",
    rs: "rust", go: "go", java: "java", c: "c", cpp: "cpp", rb: "ruby",
    php: "php", sql: "sql", md: "markdown", html: "html", css: "css",
    toml: "toml", xml: "xml", diff: "diff", patch: "diff",
  };
  return m[ext] ?? ext;
}

// ── Chat session storage ─────────────────────────────────────────────────────

const STORAGE_KEY = "cluster-dash:chats";

function loadSessions(): ChatSession[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as ChatSession[];
  } catch {
    return [];
  }
}

function saveSessions(sessions: ChatSession[]) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  } catch {
    /* quota/serialization — ignore */
  }
}

function deriveTitle(messages: Message[]): string {
  const firstUser = messages.find(m => m.role === "user");
  if (!firstUser) return "New chat";
  const t = firstUser.content.trim().replace(/\s+/g, " ");
  if (!t) return "New chat";
  return t.length > 40 ? t.slice(0, 40) + "…" : t;
}

function freshSession(): ChatSession {
  const now = Date.now();
  return {
    id: uid(),
    title: "New chat",
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}

// ── Inline markdown renderer ─────────────────────────────────────────────────

function renderInline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const re = /(`[^`\n]+`|\*\*[\s\S]+?\*\*|\*[^\*\n]+\*|\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0;
  let k = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      parts.push(<span key={k++}>{text.slice(last, m.index)}</span>);
    }
    const raw = m[0];
    if (raw.startsWith("`")) {
      parts.push(
        <code key={k++} style={{ background: "#1e293b", color: "#a5b4fc", padding: "1px 6px", borderRadius: 4, fontSize: "0.88em", fontFamily: "'JetBrains Mono','Fira Code',monospace" }}>
          {raw.slice(1, -1)}
        </code>
      );
    } else if (raw.startsWith("**")) {
      parts.push(<strong key={k++} style={{ color: "#e2e8f0", fontWeight: 700 }}>{raw.slice(2, -2)}</strong>);
    } else if (raw.startsWith("*")) {
      parts.push(<em key={k++} style={{ color: "#94a3b8" }}>{raw.slice(1, -1)}</em>);
    } else if (raw.startsWith("[")) {
      parts.push(
        <a key={k++} href={m[3]} target="_blank" rel="noopener noreferrer"
          style={{ color: "#60a5fa", textDecoration: "underline", textUnderlineOffset: 2 }}>
          {m[2]}
        </a>
      );
    }
    last = m.index + raw.length;
  }
  if (last < text.length) parts.push(<span key={k++}>{text.slice(last)}</span>);
  return parts;
}

// ── Code block ───────────────────────────────────────────────────────────────

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <div style={{ margin: "10px 0", borderRadius: 8, overflow: "hidden", border: "1px solid #1a2540" }}>
      <div style={{ background: "#0a1018", padding: "5px 12px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid #1a2540" }}>
        <span style={{ fontSize: 10, color: "#475569", letterSpacing: "0.1em", textTransform: "uppercase" }}>{lang || "code"}</span>
        <button onClick={copy} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 10, color: copied ? "#10b981" : "#475569", fontFamily: "inherit", padding: "1px 0" }}>
          {copied ? "✓ copied" : "⎘ copy"}
        </button>
      </div>
      <pre style={{ background: "#06090f", margin: 0, padding: "14px 16px", overflowX: "auto", fontSize: 12, lineHeight: 1.65, color: "#94a3b8", fontFamily: "'JetBrains Mono','Fira Code','Consolas',monospace", whiteSpace: "pre" }}>
        <code>{code}</code>
      </pre>
    </div>
  );
}

// ── Think block ──────────────────────────────────────────────────────────────

function ThinkBlock({ content, streaming }: { content: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ margin: "8px 0 12px", borderRadius: 8, border: "1px solid #312e81", overflow: "hidden" }}>
      <button
        onClick={() => setOpen(v => !v)}
        style={{ width: "100%", background: "#1e1b4b22", padding: "7px 12px", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 8, fontFamily: "inherit", textAlign: "left" }}
      >
        {streaming ? (
          <span style={{ fontSize: 10, color: "#818cf8", display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#6366f1", display: "inline-block", animation: "pulse-ring 1s ease-out infinite" }} />
            THINKING…
          </span>
        ) : (
          <span style={{ fontSize: 10, color: "#818cf8", letterSpacing: "0.08em" }}>🤔 THOUGHT PROCESS</span>
        )}
        <span style={{ fontSize: 9, color: "#4338ca", marginLeft: "auto" }}>{open ? "▲" : "▼"} {Math.round(content.length / 4)} tokens</span>
      </button>
      {open && (
        <div style={{ background: "#0d0b1e", padding: "12px 14px", fontSize: 11.5, color: "#6366f1", lineHeight: 1.7, whiteSpace: "pre-wrap", fontFamily: "'JetBrains Mono','Fira Code',monospace", maxHeight: 320, overflowY: "auto" }}>
          {content}
        </div>
      )}
    </div>
  );
}

// ── Markdown renderer ────────────────────────────────────────────────────────

function MsgMarkdown({ content, streaming }: { content: string; streaming?: boolean }) {
  // Extract think block
  let thinking: string | null = null;
  let body = content;
  const thinkOpen = content.indexOf("<think>");
  const thinkClose = content.indexOf("</think>");

  if (thinkOpen !== -1) {
    if (thinkClose !== -1) {
      thinking = content.slice(thinkOpen + 7, thinkClose);
      body = content.slice(thinkClose + 8).trimStart();
    } else {
      thinking = content.slice(thinkOpen + 7);
      body = "";
    }
  }

  const nodes = parseBlocks(body);

  return (
    <div style={{ lineHeight: 1.7 }}>
      {thinking !== null && <ThinkBlock content={thinking} streaming={streaming && thinkClose === -1} />}
      {nodes}
      {streaming && body.length > 0 && (
        <span style={{ display: "inline-block", width: 8, height: 14, background: "#3b82f6", borderRadius: 1, animation: "cursor-blink 1s step-end infinite", verticalAlign: "text-bottom", marginLeft: 2 }} />
      )}
    </div>
  );
}

function parseBlocks(text: string): React.ReactNode[] {
  const result: React.ReactNode[] = [];
  // Split code blocks
  const segments = text.split(/(```[^\n]*\n[\s\S]*?```|```[^\n]*\n[\s\S]*$)/g);

  segments.forEach((seg, si) => {
    const cbMatch = seg.match(/^```([^\n]*)\n([\s\S]*?)```$/) ?? seg.match(/^```([^\n]*)\n([\s\S]*)$/);
    if (cbMatch) {
      result.push(<CodeBlock key={`cb-${si}`} lang={cbMatch[1].trim()} code={cbMatch[2]} />);
      return;
    }

    const lines = seg.split("\n");
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === "") { i++; continue; }

      // Heading
      const hm = line.match(/^(#{1,6})\s+(.+)/);
      if (hm) {
        const level = hm[1].length;
        const sizes = [20, 17, 15, 13, 12, 11];
        result.push(
          <div key={`h-${si}-${i}`} style={{ fontSize: sizes[level - 1], fontWeight: 700, color: "#e2e8f0", margin: "14px 0 6px", lineHeight: 1.4 }}>
            {renderInline(hm[2])}
          </div>
        );
        i++; continue;
      }

      // Unordered list
      if (/^[-*+]\s+/.test(line)) {
        const items: string[] = [];
        while (i < lines.length && /^[-*+]\s+/.test(lines[i])) { items.push(lines[i].replace(/^[-*+]\s+/, "")); i++; }
        result.push(
          <ul key={`ul-${si}-${i}`} style={{ margin: "6px 0", paddingLeft: 20, listStyle: "disc" }}>
            {items.map((it, k) => <li key={k} style={{ color: "#94a3b8", fontSize: 13, lineHeight: 1.75 }}>{renderInline(it)}</li>)}
          </ul>
        );
        continue;
      }

      // Ordered list
      if (/^\d+\.\s+/.test(line)) {
        const items: string[] = [];
        while (i < lines.length && /^\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\d+\.\s+/, "")); i++; }
        result.push(
          <ol key={`ol-${si}-${i}`} style={{ margin: "6px 0", paddingLeft: 20 }}>
            {items.map((it, k) => <li key={k} style={{ color: "#94a3b8", fontSize: 13, lineHeight: 1.75 }}>{renderInline(it)}</li>)}
          </ol>
        );
        continue;
      }

      // Blockquote
      if (line.startsWith("> ")) {
        const bqLines: string[] = [];
        while (i < lines.length && lines[i].startsWith("> ")) { bqLines.push(lines[i].slice(2)); i++; }
        result.push(
          <div key={`bq-${si}-${i}`} style={{ margin: "8px 0", paddingLeft: 14, borderLeft: "3px solid #3b82f644", color: "#64748b", fontSize: 13, lineHeight: 1.7 }}>
            {bqLines.map((l, k) => <div key={k}>{renderInline(l)}</div>)}
          </div>
        );
        continue;
      }

      // HR
      if (/^(---+|\*\*\*+)$/.test(line.trim())) {
        result.push(<hr key={`hr-${si}-${i}`} style={{ border: "none", borderTop: "1px solid #1a2540", margin: "12px 0" }} />);
        i++; continue;
      }

      // Paragraph — collect contiguous non-empty, non-special lines
      const paraLines: string[] = [];
      while (i < lines.length && lines[i].trim() !== "" && !/^(#{1,6}\s|[-*+]\s|\d+\.\s|> |---+|\*\*\*+)/.test(lines[i])) {
        paraLines.push(lines[i]); i++;
      }
      if (paraLines.length > 0) {
        result.push(
          <p key={`p-${si}-${i}`} style={{ color: "#94a3b8", fontSize: 13.5, lineHeight: 1.75, margin: "4px 0" }}>
            {paraLines.map((l, k) => (
              <span key={k}>{renderInline(l)}{k < paraLines.length - 1 ? <br /> : null}</span>
            ))}
          </p>
        );
      }
    }
  });

  return result;
}

// ── Message bubbles ──────────────────────────────────────────────────────────

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); })}
      title="Copy message"
      style={{ background: "none", border: "none", cursor: "pointer", fontSize: 10, color: copied ? "#10b981" : "#334155", fontFamily: "inherit", padding: "2px 5px", borderRadius: 4, transition: "color 0.15s" }}
    >
      {copied ? "✓" : "⎘"}
    </button>
  );
}

function UserBubble({ msg, attPreviews }: { msg: Message; attPreviews?: React.ReactNode[] }) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 16 }}>
      <div style={{ maxWidth: "78%", minWidth: 60 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "flex-end", marginBottom: 4 }}>
          <span style={{ fontSize: 9, color: "#334155" }}>{new Date(msg.timestamp).toLocaleTimeString("en-GB", { hour12: false })}</span>
          <CopyBtn text={msg.content} />
          <span style={{ fontSize: 9, color: "#475569", letterSpacing: "0.08em" }}>YOU</span>
        </div>
        {attPreviews && attPreviews.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "flex-end", marginBottom: 6 }}>
            {attPreviews}
          </div>
        )}
        <div style={{
          background: "#1e3a8a18",
          border: "1px solid #3b82f626",
          borderRadius: "14px 14px 2px 14px",
          padding: "10px 14px",
          fontSize: 13.5,
          color: "#e2e8f0",
          lineHeight: 1.7,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}>
          {msg.content}
        </div>
      </div>
    </div>
  );
}

function AssistantBubble({ msg, onRegenerate }: { msg: Message; onRegenerate?: () => void }) {
  const showStats = !msg.streaming && (msg.completionTokens !== undefined || msg.tps !== undefined);

  return (
    <div style={{ display: "flex", justifyContent: "flex-start", marginBottom: 16 }}>
      <div style={{ maxWidth: "88%" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 9, color: "#475569", letterSpacing: "0.08em" }}>ASSISTANT</span>
          <span style={{ fontSize: 9, color: "#334155" }}>{new Date(msg.timestamp).toLocaleTimeString("en-GB", { hour12: false })}</span>
          <CopyBtn text={msg.content} />
          {onRegenerate && !msg.streaming && (
            <button onClick={onRegenerate} title="Regenerate" style={{ background: "none", border: "none", cursor: "pointer", fontSize: 10, color: "#334155", fontFamily: "inherit", padding: "2px 5px" }}>↺</button>
          )}
        </div>
        <div style={{
          background: "#0c1220",
          border: "1px solid #1a2540",
          borderRadius: "2px 14px 14px 14px",
          padding: "12px 16px",
          wordBreak: "break-word",
        }}>
          {msg.streaming && msg.content === "" ? (
            <div style={{ display: "flex", gap: 4, alignItems: "center", padding: "4px 0" }}>
              {[0, 1, 2].map(i => (
                <div key={i} style={{ width: 6, height: 6, borderRadius: "50%", background: "#3b82f6", animation: `pulse-ring 1.2s ease-in-out ${i * 0.2}s infinite` }} />
              ))}
            </div>
          ) : (
            <MsgMarkdown content={msg.content} streaming={msg.streaming} />
          )}
        </div>
        {showStats && (
          <div style={{ display: "flex", gap: 8, marginTop: 5, flexWrap: "wrap" }}>
            {msg.completionTokens !== undefined && (
              <span style={{ fontSize: 9, color: "#1e3a5f", background: "#0c1626", border: "1px solid #1a2540", borderRadius: 3, padding: "1px 6px" }}>
                {fmtTokens(msg.completionTokens)} tokens
              </span>
            )}
            {msg.tps !== undefined && msg.tps > 0 && (
              <span style={{ fontSize: 9, color: "#1e3a5f", background: "#0c1626", border: "1px solid #1a2540", borderRadius: 3, padding: "1px 6px" }}>
                {msg.tps.toFixed(1)} t/s
              </span>
            )}
            {msg.ttft !== undefined && msg.ttft > 0 && (
              <span style={{ fontSize: 9, color: "#1e3a5f", background: "#0c1626", border: "1px solid #1a2540", borderRadius: 3, padding: "1px 6px" }}>
                TTFT {fmtMs(msg.ttft)}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Stats bar ────────────────────────────────────────────────────────────────

function StatsBar({ stats, maxModelLen, isGenerating }: { stats: LiveStats; maxModelLen: number | null; isGenerating: boolean }) {
  const contextPct = maxModelLen && stats.promptTokens > 0
    ? Math.min(100, Math.round((stats.promptTokens / maxModelLen) * 100))
    : 0;
  const contextK = maxModelLen ? `${fmtTokens(stats.promptTokens)} / ${fmtTokens(maxModelLen)}` : "—";
  const speedPct = Math.min(100, Math.round((stats.tps / 40) * 100));
  const color = speedColor(stats.tps);

  return (
    <div style={{
      background: "#080c14",
      borderBottom: "1px solid #1a2540",
      padding: "10px 16px",
      display: "flex",
      alignItems: "center",
      gap: 20,
      flexWrap: "wrap",
    }}>
      <ArcGauge pct={contextPct} label="CONTEXT" sublabel={contextK} size={80} />
      <ArcGauge pct={speedPct} label="SPEED" sublabel={stats.tps > 0 ? `${stats.tps.toFixed(1)} t/s` : "idle"} size={80} colorOverride={color} />

      <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1, minWidth: 160 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <StatChip label="PROMPT" value={stats.promptTokens > 0 ? fmtTokens(stats.promptTokens) : "—"} color="#3b82f6" />
          <StatChip label="COMPLETION" value={stats.completionTokens > 0 ? fmtTokens(stats.completionTokens) : "—"} color="#8b5cf6" />
          <StatChip label="TOTAL" value={stats.promptTokens + stats.completionTokens > 0 ? fmtTokens(stats.promptTokens + stats.completionTokens) : "—"} color="#10b981" />
          {stats.ttft > 0 && <StatChip label="TTFT" value={fmtMs(stats.ttft)} color="#f59e0b" />}
        </div>
        {isGenerating && stats.tps > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{ width: 5, height: 5, borderRadius: "50%", background: "#10b981", animation: "pulse-ring 1s ease-out infinite" }} />
            <span style={{ fontSize: 10, color: "#10b981" }}>Generating at {stats.tps.toFixed(1)} t/s</span>
          </div>
        )}
      </div>
    </div>
  );
}

function StatChip({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ background: `${color}0d`, border: `1px solid ${color}22`, borderRadius: 5, padding: "3px 9px" }}>
      <span style={{ fontSize: 8, color: "#475569", letterSpacing: "0.1em", display: "block", marginBottom: 1 }}>{label}</span>
      <span style={{ fontSize: 12, color, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{value}</span>
    </div>
  );
}

// ── Attachment preview ───────────────────────────────────────────────────────

function AttachmentPill({ att, onRemove }: { att: Attachment; onRemove: () => void }) {
  const fmtSize = (b: number) => b > 1048576 ? (b / 1048576).toFixed(1) + "MB" : (b / 1024).toFixed(0) + "KB";

  if (att.type === "image") {
    return (
      <div style={{ position: "relative", display: "inline-block" }}>
        <img src={att.content} alt={att.name} style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 8, border: "1px solid #1a2540", display: "block" }} />
        <button onClick={onRemove} style={{ position: "absolute", top: -6, right: -6, width: 18, height: 18, borderRadius: "50%", background: "#ef4444", border: "none", cursor: "pointer", fontSize: 10, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1 }}>×</button>
        <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, background: "#00000088", borderRadius: "0 0 7px 7px", padding: "2px 4px", fontSize: 8, color: "#e2e8f0", textAlign: "center", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{att.name}</div>
      </div>
    );
  }

  const icon = att.type === "text" ? "📄" : "📎";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, background: "#0c1220", border: "1px solid #1a2540", borderRadius: 8, padding: "5px 10px" }}>
      <span style={{ fontSize: 14 }}>{icon}</span>
      <div>
        <div style={{ fontSize: 10, fontWeight: 600, color: "#94a3b8", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{att.name}</div>
        <div style={{ fontSize: 9, color: "#475569" }}>{fmtSize(att.size)}</div>
      </div>
      <button onClick={onRemove} style={{ background: "none", border: "none", cursor: "pointer", color: "#475569", fontSize: 14, lineHeight: 1, padding: "0 0 0 4px" }}>×</button>
    </div>
  );
}

// ── Settings panel ───────────────────────────────────────────────────────────

function SettingsPanel({
  systemPrompt, onSystemPrompt,
  temperature, onTemperature,
  maxTokens, onMaxTokens,
  topP, onTopP,
  enableThinking, onEnableThinking,
  isQwen3,
}: {
  systemPrompt: string; onSystemPrompt: (v: string) => void;
  temperature: number; onTemperature: (v: number) => void;
  maxTokens: number; onMaxTokens: (v: number) => void;
  topP: number; onTopP: (v: number) => void;
  enableThinking: boolean; onEnableThinking: (v: boolean) => void;
  isQwen3: boolean;
}) {
  return (
    <div style={{ background: "#080c14", borderTop: "1px solid #1a2540", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <label style={{ fontSize: 9, color: "#475569", letterSpacing: "0.1em", textTransform: "uppercase", display: "block", marginBottom: 5 }}>System Prompt</label>
        <textarea
          value={systemPrompt}
          onChange={e => onSystemPrompt(e.target.value)}
          rows={3}
          style={{ width: "100%", background: "#06090f", border: "1px solid #1a2540", borderRadius: 6, padding: "8px 10px", fontSize: 11, color: "#94a3b8", fontFamily: "'JetBrains Mono','Fira Code',monospace", resize: "vertical", boxSizing: "border-box", outline: "none" }}
        />
      </div>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <SliderParam label={`TEMPERATURE — ${temperature.toFixed(2)}`} min={0} max={2} step={0.01} value={temperature} onChange={onTemperature} color="#f59e0b" />
        <SliderParam label={`TOP-P — ${topP.toFixed(2)}`} min={0.01} max={1} step={0.01} value={topP} onChange={onTopP} color="#8b5cf6" />
        <SliderParam label={`MAX TOKENS — ${maxTokens.toLocaleString()}`} min={256} max={65536} step={256} value={maxTokens} onChange={onMaxTokens} color="#3b82f6" />
      </div>
      {isQwen3 && (
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <label style={{ fontSize: 9, color: "#475569", letterSpacing: "0.1em", textTransform: "uppercase" }}>🤔 QWEN3 THINKING MODE</label>
          <button
            onClick={() => onEnableThinking(!enableThinking)}
            style={{
              background: enableThinking ? "#312e8133" : "transparent",
              border: `1px solid ${enableThinking ? "#6366f1" : "#1a2540"}`,
              borderRadius: 5, padding: "4px 14px", cursor: "pointer",
              fontSize: 10, fontWeight: 700, color: enableThinking ? "#818cf8" : "#334155",
              fontFamily: "inherit", letterSpacing: "0.08em",
            }}
          >
            {enableThinking ? "ON" : "OFF"}
          </button>
          <span style={{ fontSize: 9, color: "#334155" }}>Enables &lt;think&gt; reasoning before each reply</span>
        </div>
      )}
    </div>
  );
}

function SliderParam({ label, min, max, step, value, onChange, color }: {
  label: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void; color: string;
}) {
  return (
    <div style={{ flex: 1, minWidth: 160 }}>
      <label style={{ fontSize: 9, color: "#475569", letterSpacing: "0.1em", textTransform: "uppercase", display: "block", marginBottom: 5 }}>{label}</label>
      <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(parseFloat(e.target.value))} style={{ width: "100%", accentColor: color }} />
    </div>
  );
}

// ── History sidebar ──────────────────────────────────────────────────────────

function HistorySidebar({
  sessions, activeId, isGenerating,
  onNew, onSelect, onDelete,
}: {
  sessions: ChatSession[];
  activeId: string | null;
  isGenerating: boolean;
  onNew: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <aside style={{
      width: 220,
      flexShrink: 0,
      borderRight: "1px solid #1a2540",
      background: "#080c14",
      display: "flex",
      flexDirection: "column",
      minHeight: 0,
    }}>
      <div style={{ padding: "10px 10px", borderBottom: "1px solid #1a2540" }}>
        <button
          onClick={onNew}
          disabled={isGenerating}
          title="Start a new chat"
          style={{
            width: "100%",
            background: isGenerating ? "transparent" : "#1e3a8a18",
            border: "1px solid #3b82f655",
            borderRadius: 6,
            padding: "7px 10px",
            cursor: isGenerating ? "not-allowed" : "pointer",
            fontSize: 11,
            color: "#60a5fa",
            fontFamily: "inherit",
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
            gap: 6,
            opacity: isGenerating ? 0.5 : 1,
          }}
        >
          <span style={{ fontSize: 13, lineHeight: 1 }}>＋</span>
          NEW CHAT
        </button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "4px 0" }}>
        {sessions.length === 0 && (
          <div style={{ padding: "12px", fontSize: 10, color: "#334155", textAlign: "center" }}>
            No chats yet
          </div>
        )}
        {sessions.map(s => {
          const isActive = s.id === activeId;
          const isDisabled = isGenerating && !isActive;
          return (
            <div
              key={s.id}
              style={{
                display: "flex",
                alignItems: "stretch",
                borderLeft: `2px solid ${isActive ? "#3b82f6" : "transparent"}`,
                background: isActive ? "#0c1220" : "transparent",
              }}
            >
              <button
                onClick={() => !isDisabled && onSelect(s.id)}
                disabled={isDisabled}
                style={{
                  flex: 1,
                  minWidth: 0,
                  textAlign: "left",
                  background: "transparent",
                  border: "none",
                  padding: "8px 4px 8px 10px",
                  cursor: isDisabled ? "not-allowed" : "pointer",
                  fontFamily: "inherit",
                  opacity: isDisabled ? 0.4 : 1,
                  color: isActive ? "#e2e8f0" : "#94a3b8",
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                }}
              >
                <span style={{
                  fontSize: 11.5,
                  lineHeight: 1.35,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontWeight: isActive ? 600 : 400,
                }}>
                  💬 {s.title}
                </span>
                <span style={{ fontSize: 9, color: "#475569" }}>
                  {s.messages.filter(m => m.role === "user").length} msg · {new Date(s.updatedAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })}
                </span>
              </button>
              <button
                onClick={() => onDelete(s.id)}
                disabled={isGenerating}
                title="Delete chat"
                style={{
                  background: "transparent",
                  border: "none",
                  cursor: isGenerating ? "not-allowed" : "pointer",
                  color: "#334155",
                  fontSize: 12,
                  padding: "0 8px",
                  opacity: isGenerating ? 0.3 : 0.6,
                  fontFamily: "inherit",
                }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

// ── Main ChatPanel ────────────────────────────────────────────────────────────

export function ChatPanel({ vllmOnline, modelName, maxModelLen }: ChatPanelProps) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [liveStats, setLiveStats] = useState<LiveStats>({ tps: 0, promptTokens: 0, completionTokens: 0, ttft: 0 });
  const [systemPrompt, setSystemPrompt] = useState("You are a helpful AI assistant.");
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(4096);
  const [topP, setTopP] = useState(1.0);
  const [enableThinking, setEnableThinking] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [atBottom, setAtBottom] = useState(true);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const startTimeRef = useRef(0);
  const firstTokenRef = useRef(0);
  const tokenCountRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const isQwen3 = (modelName ?? "").toLowerCase().includes("qwen3");

  const activeSession = sessions.find(s => s.id === activeId) ?? null;
  const messages = activeSession?.messages ?? [];

  // Load sessions from localStorage on mount
  useEffect(() => {
    const loaded = loadSessions();
    if (loaded.length > 0) {
      const sorted = [...loaded].sort((a, b) => b.updatedAt - a.updatedAt);
      setSessions(sorted);
      setActiveId(sorted[0].id);
    } else {
      const fresh = freshSession();
      setSessions([fresh]);
      setActiveId(fresh.id);
      saveSessions([fresh]);
    }
    // Focus input on section load
    const t = setTimeout(() => textareaRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, []);

  // Live TPS updater during generation
  useEffect(() => {
    if (!isGenerating) return;
    const id = setInterval(() => {
      if (firstTokenRef.current > 0 && tokenCountRef.current > 0) {
        const elapsed = (Date.now() - firstTokenRef.current) / 1000;
        if (elapsed > 0) {
          setLiveStats(prev => ({ ...prev, tps: tokenCountRef.current / elapsed }));
        }
      }
    }, 150);
    return () => clearInterval(id);
  }, [isGenerating]);

  // Auto-scroll
  useEffect(() => {
    if (atBottom) messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, atBottom]);

  // Refocus input when switching active chat
  useEffect(() => {
    if (activeId) {
      const t = setTimeout(() => textareaRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [activeId]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setAtBottom(nearBottom);
  }, []);

  const adjustTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 180) + "px";
  }, []);

  // ── Session helpers ──────────────────────────────────────────────────────

  // Update only state, no persistence — used during streaming
  const patchActiveMessagesEphemeral = useCallback((updater: (msgs: Message[]) => Message[]) => {
    setSessions(prev => prev.map(s =>
      s.id === activeId ? { ...s, messages: updater(s.messages) } : s
    ));
  }, [activeId]);

  // Update state + persist + retitle if needed
  const commitActive = useCallback((updater: (s: ChatSession) => ChatSession) => {
    setSessions(prev => {
      const next = prev.map(s => s.id === activeId ? updater(s) : s);
      next.sort((a, b) => b.updatedAt - a.updatedAt);
      saveSessions(next);
      return next;
    });
  }, [activeId]);

  const handleNewChat = useCallback(() => {
    if (isGenerating) return;
    const fresh = freshSession();
    setSessions(prev => {
      const next = [fresh, ...prev];
      saveSessions(next);
      return next;
    });
    setActiveId(fresh.id);
    setInput("");
    setLiveStats({ tps: 0, promptTokens: 0, completionTokens: 0, ttft: 0 });
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [isGenerating]);

  const handleSelectChat = useCallback((id: string) => {
    if (isGenerating) return;
    setActiveId(id);
    setLiveStats({ tps: 0, promptTokens: 0, completionTokens: 0, ttft: 0 });
  }, [isGenerating]);

  const handleDeleteChat = useCallback((id: string) => {
    if (isGenerating) return;
    setSessions(prev => {
      const next = prev.filter(s => s.id !== id);
      if (next.length === 0) {
        const fresh = freshSession();
        saveSessions([fresh]);
        setActiveId(fresh.id);
        return [fresh];
      }
      if (id === activeId) {
        setActiveId(next[0].id);
      }
      saveSessions(next);
      return next;
    });
  }, [activeId, isGenerating]);

  // File handling
  const processFile = useCallback((file: File) => {
    const id = uid();
    if (file.type.startsWith("image/")) {
      const reader = new FileReader();
      reader.onload = e => {
        setAttachments(prev => [...prev, { id, type: "image", name: file.name, content: e.target?.result as string, mimeType: file.type, size: file.size }]);
      };
      reader.readAsDataURL(file);
    } else if (isTextFilename(file.name)) {
      const reader = new FileReader();
      reader.onload = e => {
        setAttachments(prev => [...prev, { id, type: "text", name: file.name, content: e.target?.result as string, mimeType: file.type || "text/plain", size: file.size }]);
      };
      reader.readAsText(file);
    } else {
      setAttachments(prev => [...prev, { id, type: "other", name: file.name, content: `[Binary file: ${file.name}]`, mimeType: file.type || "application/octet-stream", size: file.size }]);
    }
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length > 0) {
      e.preventDefault();
      files.forEach(processFile);
    }
    // Let text paste proceed normally
  }, [processFile]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    Array.from(e.dataTransfer.files).forEach(processFile);
  }, [processFile]);

  // Build message content including attachments
  const buildUserContent = useCallback((text: string, atts: Attachment[]) => {
    const textAtts = atts.filter(a => a.type === "text");
    const imgAtts = atts.filter(a => a.type === "image");
    const otherAtts = atts.filter(a => a.type === "other");

    let fullText = text;
    for (const att of otherAtts) fullText = `[Attached: ${att.name}]\n\n${fullText}`;
    for (const att of textAtts) {
      const lang = langFromFilename(att.name);
      fullText = `**File: ${att.name}**\n\`\`\`${lang}\n${att.content}\n\`\`\`\n\n${fullText}`;
    }

    if (imgAtts.length === 0) return fullText;

    return [
      { type: "text", text: fullText },
      ...imgAtts.map(img => ({ type: "image_url", image_url: { url: img.content } })),
    ];
  }, []);

  const sendMessage = useCallback(async () => {
    if ((!input.trim() && attachments.length === 0) || isGenerating || !vllmOnline || !modelName || !activeSession) return;

    const userContent = buildUserContent(input.trim(), attachments);
    const userMsg: Message = { id: uid(), role: "user", content: typeof userContent === "string" ? userContent : input.trim(), timestamp: Date.now() };
    const assistantId = uid();
    const assistantMsg: Message = { id: assistantId, role: "assistant", content: "", timestamp: Date.now(), streaming: true };

    const baseMessages = activeSession.messages;
    const newMessages = [...baseMessages, userMsg, assistantMsg];

    // Persist user message + placeholder + retitle if first
    commitActive(s => ({
      ...s,
      messages: newMessages,
      title: s.title === "New chat" ? deriveTitle([...baseMessages, userMsg]) : s.title,
      updatedAt: Date.now(),
    }));

    setInput("");
    setAttachments([]);
    setIsGenerating(true);
    if (textareaRef.current) { textareaRef.current.style.height = "auto"; }
    // Keep cursor focused on the input after submit
    setTimeout(() => textareaRef.current?.focus(), 0);

    startTimeRef.current = Date.now();
    firstTokenRef.current = 0;
    tokenCountRef.current = 0;

    const systemMessages = systemPrompt.trim()
      ? [{ role: "system", content: systemPrompt }]
      : [];

    const historyMessages = [...baseMessages, userMsg].map(m => ({
      role: m.role,
      content: m.role === "user" && m.id === userMsg.id ? userContent : m.content,
    }));

    const extraBody: Record<string, unknown> = {};
    if (isQwen3 && enableThinking) {
      extraBody.chat_template_kwargs = { enable_thinking: true };
    } else if (isQwen3 && !enableThinking) {
      extraBody.chat_template_kwargs = { enable_thinking: false };
    }

    try {
      abortRef.current = new AbortController();
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: modelName,
          messages: [...systemMessages, ...historyMessages],
          temperature,
          max_tokens: maxTokens,
          top_p: topP,
          extra_body: Object.keys(extraBody).length > 0 ? extraBody : undefined,
        }),
        signal: abortRef.current.signal,
      });

      if (!res.ok || !res.body) {
        const err = await res.text();
        commitActive(s => ({
          ...s,
          messages: s.messages.map(m => m.id === assistantId ? { ...m, content: `Error: ${err}`, streaming: false } : m),
          updatedAt: Date.now(),
        }));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let accumulated = "";
      let done = false;
      let finalUsage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null = null;

      while (!done) {
        const { done: d, value } = await reader.read();
        if (d) break;

        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);

          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") { done = true; break; }

          try {
            const chunk = JSON.parse(data) as {
              choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
              usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
            };

            const delta = chunk.choices?.[0]?.delta?.content ?? "";
            const usage = chunk.usage;

            if (delta) {
              if (!firstTokenRef.current) firstTokenRef.current = Date.now();
              tokenCountRef.current++;
              accumulated += delta;
              const snap = accumulated;
              patchActiveMessagesEphemeral(msgs =>
                msgs.map(m => m.id === assistantId ? { ...m, content: snap, streaming: true } : m)
              );
            }

            if (usage) {
              finalUsage = usage;
              const elapsed = firstTokenRef.current ? (Date.now() - firstTokenRef.current) / 1000 : 0;
              const finalTps = elapsed > 0 ? usage.completion_tokens / elapsed : 0;
              const ttft = firstTokenRef.current ? firstTokenRef.current - startTimeRef.current : 0;
              setLiveStats({ tps: finalTps, promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, ttft });
            }
          } catch { /* ignore parse errors */ }
        }
      }

      // Final commit with stats
      const elapsed = firstTokenRef.current ? (Date.now() - firstTokenRef.current) / 1000 : 0;
      const finalTps = elapsed > 0
        ? (finalUsage ? finalUsage.completion_tokens / elapsed : tokenCountRef.current / elapsed)
        : 0;
      const ttft = firstTokenRef.current ? firstTokenRef.current - startTimeRef.current : 0;

      commitActive(s => ({
        ...s,
        messages: s.messages.map(m =>
          m.id === assistantId
            ? {
                ...m,
                content: accumulated,
                streaming: false,
                ...(finalUsage ? { promptTokens: finalUsage.prompt_tokens, completionTokens: finalUsage.completion_tokens } : {}),
                tps: finalTps,
                ttft,
              }
            : m
        ),
        updatedAt: Date.now(),
      }));
    } catch (err: unknown) {
      if ((err as Error).name !== "AbortError") {
        commitActive(s => ({
          ...s,
          messages: s.messages.map(m =>
            m.id === assistantId ? { ...m, content: `Error: ${(err as Error).message}`, streaming: false } : m
          ),
          updatedAt: Date.now(),
        }));
      } else {
        commitActive(s => ({
          ...s,
          messages: s.messages.map(m =>
            m.id === assistantId ? { ...m, streaming: false } : m
          ),
          updatedAt: Date.now(),
        }));
      }
    } finally {
      setIsGenerating(false);
      abortRef.current = null;
      // Refocus once more after generation completes
      setTimeout(() => textareaRef.current?.focus(), 0);
    }
  }, [input, attachments, isGenerating, vllmOnline, modelName, activeSession, systemPrompt, temperature, maxTokens, topP, enableThinking, isQwen3, buildUserContent, commitActive, patchActiveMessagesEphemeral]);

  const stopGeneration = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const regenerate = useCallback(() => {
    if (!activeSession || isGenerating) return;
    const msgs = activeSession.messages;
    const lastUser = [...msgs].reverse().find(m => m.role === "user");
    if (!lastUser) return;
    // Trim everything from the last user message onward, restore its text to input
    const cutoff = msgs.findIndex(m => m.id === lastUser.id);
    commitActive(s => ({
      ...s,
      messages: msgs.slice(0, cutoff),
      updatedAt: Date.now(),
    }));
    setInput(lastUser.content);
  }, [activeSession, isGenerating, commitActive]);

  const clearChat = useCallback(() => {
    if (isGenerating) return;
    commitActive(s => ({
      ...s,
      messages: [],
      title: "New chat",
      updatedAt: Date.now(),
    }));
    setLiveStats({ tps: 0, promptTokens: 0, completionTokens: 0, ttft: 0 });
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [commitActive, isGenerating]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "row", height: "calc(100vh - 200px)", minHeight: 600, background: "#06090f", border: "1px solid #1a2540", borderRadius: 12, overflow: "hidden", position: "relative" }}>

      {/* ── History sidebar ── */}
      <HistorySidebar
        sessions={sessions}
        activeId={activeId}
        isGenerating={isGenerating}
        onNew={handleNewChat}
        onSelect={handleSelectChat}
        onDelete={handleDeleteChat}
      />

      {/* ── Main chat column ── */}
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>

        {/* ── Header ── */}
        <div style={{ background: "#0a1018", borderBottom: "1px solid #1a2540", padding: "10px 16px", display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
          <span style={{ fontSize: 10, letterSpacing: "0.12em", color: "#475569", textTransform: "uppercase" }}>▸ CHAT</span>
          {modelName ? (
            <div style={{ display: "flex", alignItems: "center", gap: 6, background: "#10b98112", border: "1px solid #10b98133", borderRadius: 5, padding: "2px 10px" }}>
              <div style={{ width: 5, height: 5, borderRadius: "50%", background: "#10b981" }} />
              <span style={{ fontSize: 10, color: "#10b981", fontWeight: 600 }}>{modelName.split("/").pop()?.split("-").slice(0, 3).join("-")}</span>
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 6, background: "#ef444412", border: "1px solid #ef444433", borderRadius: 5, padding: "2px 10px" }}>
              <span style={{ fontSize: 10, color: "#ef4444" }}>vLLM offline — start cluster first</span>
            </div>
          )}
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            {messages.length > 0 && (
              <span style={{ fontSize: 9, color: "#334155", alignSelf: "center" }}>{messages.length} messages</span>
            )}
            <button onClick={() => setShowSettings(v => !v)} style={{ background: showSettings ? "#1e3a8a22" : "transparent", border: `1px solid ${showSettings ? "#3b82f6" : "#1a2540"}`, borderRadius: 5, padding: "4px 12px", cursor: "pointer", fontSize: 10, color: showSettings ? "#60a5fa" : "#475569", fontFamily: "inherit" }}>
              ⚙ SETTINGS
            </button>
            <button onClick={clearChat} disabled={messages.length === 0 || isGenerating} style={{ background: "transparent", border: "1px solid #1a2540", borderRadius: 5, padding: "4px 12px", cursor: (messages.length === 0 || isGenerating) ? "not-allowed" : "pointer", fontSize: 10, color: "#475569", fontFamily: "inherit", opacity: (messages.length === 0 || isGenerating) ? 0.4 : 1 }}>
              CLEAR
            </button>
          </div>
        </div>

        {/* ── Stats bar ── */}
        <StatsBar stats={liveStats} maxModelLen={maxModelLen} isGenerating={isGenerating} />

        {/* ── Settings panel ── */}
        {showSettings && (
          <SettingsPanel
            systemPrompt={systemPrompt} onSystemPrompt={setSystemPrompt}
            temperature={temperature} onTemperature={setTemperature}
            maxTokens={maxTokens} onMaxTokens={setMaxTokens}
            topP={topP} onTopP={setTopP}
            enableThinking={enableThinking} onEnableThinking={setEnableThinking}
            isQwen3={isQwen3}
          />
        )}

        {/* ── Messages ── */}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          style={{ flex: 1, overflowY: "auto", padding: "20px 20px 8px", display: "flex", flexDirection: "column" }}
        >
          {messages.length === 0 && (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, color: "#1e293b" }}>
              <div style={{ fontSize: 40 }}>⚡</div>
              <div style={{ fontSize: 14, color: "#334155", textAlign: "center", lineHeight: 1.6 }}>
                {vllmOnline ? "Start a conversation" : "Launch the cluster from the CONTROL tab first"}
              </div>
              {vllmOnline && (
                <div style={{ fontSize: 11, color: "#1e3a5f", textAlign: "center" }}>
                  Paste files or images · Shift+Enter for newline · Enter to send
                </div>
              )}
            </div>
          )}

          {messages.map((msg, idx) =>
            msg.role === "user" ? (
              <UserBubble key={msg.id} msg={msg} />
            ) : (
              <AssistantBubble
                key={msg.id}
                msg={msg}
                onRegenerate={idx === messages.length - 1 ? regenerate : undefined}
              />
            )
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* ── Scroll to bottom button ── */}
        {!atBottom && (
          <div style={{ position: "absolute", bottom: 160, right: 28, zIndex: 10 }}>
            <button
              onClick={() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); setAtBottom(true); }}
              style={{ background: "#0c1220", border: "1px solid #3b82f644", borderRadius: "50%", width: 34, height: 34, cursor: "pointer", fontSize: 14, color: "#3b82f6", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 2px 8px #00000088" }}
            >
              ↓
            </button>
          </div>
        )}

        {/* ── Input area ── */}
        <div
          style={{ borderTop: "1px solid #1a2540", background: "#0a1018", flexShrink: 0 }}
          onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
        >
          {isDragging && (
            <div style={{ position: "absolute", inset: 0, background: "#3b82f608", border: "2px dashed #3b82f644", borderRadius: 12, zIndex: 20, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
              <span style={{ fontSize: 13, color: "#3b82f6" }}>Drop files here</span>
            </div>
          )}

          {/* Attachment previews */}
          {attachments.length > 0 && (
            <div style={{ padding: "10px 14px 0", display: "flex", gap: 8, flexWrap: "wrap" }}>
              {attachments.map(att => (
                <AttachmentPill key={att.id} att={att} onRemove={() => setAttachments(prev => prev.filter(a => a.id !== att.id))} />
              ))}
            </div>
          )}

          <div style={{ padding: "10px 14px", display: "flex", gap: 10, alignItems: "flex-end" }}>
            {/* File attach button */}
            <label title="Attach file" style={{ cursor: "pointer", color: "#334155", fontSize: 16, paddingBottom: 10, flexShrink: 0 }}>
              📎
              <input
                type="file"
                multiple
                style={{ display: "none" }}
                onChange={e => Array.from(e.target.files ?? []).forEach(processFile)}
              />
            </label>

            <textarea
              ref={textareaRef}
              value={input}
              onChange={e => { setInput(e.target.value); adjustTextarea(); }}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={vllmOnline ? (isGenerating ? "Generating reply… (type to queue next message)" : "Message… (Enter to send, Shift+Enter for newline, paste files/images)") : "vLLM offline"}
              disabled={!vllmOnline}
              rows={1}
              style={{
                flex: 1,
                background: "#06090f",
                border: `1px solid ${isDragging ? "#3b82f6" : "#1a2540"}`,
                borderRadius: 10,
                padding: "10px 14px",
                fontSize: 13.5,
                color: "#e2e8f0",
                fontFamily: "inherit",
                resize: "none",
                outline: "none",
                lineHeight: 1.6,
                minHeight: 42,
                maxHeight: 180,
                boxSizing: "border-box",
                transition: "border-color 0.15s",
                overflowY: "auto",
              }}
            />

            {isGenerating ? (
              <button
                onClick={stopGeneration}
                title="Stop generation"
                style={{ background: "#ef444418", border: "1px solid #ef444455", borderRadius: 10, padding: "10px 14px", cursor: "pointer", fontSize: 12, color: "#ef4444", fontFamily: "inherit", fontWeight: 700, flexShrink: 0 }}
              >
                ■ STOP
              </button>
            ) : (
              <button
                onClick={sendMessage}
                disabled={!vllmOnline || (!input.trim() && attachments.length === 0)}
                title="Send (Enter)"
                style={{
                  background: vllmOnline && (input.trim() || attachments.length > 0) ? "#3b82f618" : "#111827",
                  border: `1px solid ${vllmOnline && (input.trim() || attachments.length > 0) ? "#3b82f655" : "#1a2540"}`,
                  borderRadius: 10, padding: "10px 16px", cursor: vllmOnline && (input.trim() || attachments.length > 0) ? "pointer" : "not-allowed",
                  fontSize: 14, color: vllmOnline && (input.trim() || attachments.length > 0) ? "#3b82f6" : "#334155",
                  fontFamily: "inherit", fontWeight: 700, flexShrink: 0, transition: "all 0.15s",
                  opacity: (!vllmOnline || (!input.trim() && attachments.length === 0)) ? 0.5 : 1,
                }}
              >
                ➤
              </button>
            )}
          </div>

          <div style={{ padding: "0 14px 8px", display: "flex", gap: 12, alignItems: "center" }}>
            <span style={{ fontSize: 9, color: "#1e293b" }}>Temp {temperature.toFixed(2)}</span>
            <span style={{ fontSize: 9, color: "#1e293b" }}>Top-P {topP.toFixed(2)}</span>
            <span style={{ fontSize: 9, color: "#1e293b" }}>Max {maxTokens.toLocaleString()} tokens</span>
            {isQwen3 && (
              <span style={{ fontSize: 9, color: enableThinking ? "#6366f1" : "#1e293b" }}>
                {enableThinking ? "🤔 thinking on" : "thinking off"}
              </span>
            )}
            <span style={{ fontSize: 9, color: "#1e293b", marginLeft: "auto" }}>⇧↵ newline · ↵ send</span>
          </div>
        </div>
      </div>
    </div>
  );
}
