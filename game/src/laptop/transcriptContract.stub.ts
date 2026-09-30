/**
 * M16 (TEMPORARY, delete on merge): the shared `TranscriptItem` contract, declared into `../net/protocol` until the
 * game-shell branch that owns that file lands with the real declarations. The members are the agreed text verbatim, so
 * after the merge this augmentation is identical to them and harmless; delete this file then. If the two ever differ,
 * tsc reports the conflicting member.
 */
declare module '../net/protocol' {
  export interface ImagePart {
    image_omitted: true;
  }
  export interface TranscriptItem {
    id: string;
    seq: number;
    ts: number;
    kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'subagent' | 'compaction' | 'notice' | 'unknown';
    parts?: Array<{ text: string } | ImagePart>;
    tool?: {
      name: string;
      input_summary: string;
      input?: unknown;
      status: 'running' | 'ok' | 'error' | 'interrupted';
      output_text?: string;
      output_truncated?: boolean;
      diff?: { path: string; hunks: unknown[] };
    };
    subagent?: { agent_id: string; description: string; status: string };
    notice?: { text: string };
    raw_type?: string;
  }
}

export {};
