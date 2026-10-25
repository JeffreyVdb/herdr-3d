import type { HireFailure, MCPDiagnostic } from '../net/protocol';

/** Keep recovery metadata narrow even when talking to an older bridge. */
export function hireFailure(v: unknown): HireFailure | undefined {
  if (!v || typeof v !== 'object') return;
  const d = v as Partial<HireFailure>;
  if (typeof d.operation !== 'string' || !['not_sent', 'accepted', 'unknown'].includes(d.delivery ?? '') || typeof d.retryable !== 'boolean') return;
  return { operation: d.operation, delivery: d.delivery!, retryable: d.retryable && d.delivery === 'not_sent', startup: diagnostics(d.startup), ...(typeof d.cwd === 'string' ? { cwd: d.cwd } : {}), ...(typeof d.codex_profile === 'string' ? { codex_profile: d.codex_profile } : {}) };
}

export function diagnostics(v: unknown): MCPDiagnostic[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 32).flatMap((d: Partial<MCPDiagnostic> | null) => {
    if (!d || typeof d.name !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,99}$/.test(d.name) || !['starting', 'ready', 'failed', 'cancelled'].includes(d.stage ?? '')) return [];
    return [{ name: d.name, stage: d.stage!, source: d.source === 'terminal' ? 'terminal' : d.source === 'notification' ? 'notification' : 'thread_status', category: ['auth', 'closed', 'timeout', 'not_found', 'refused', 'startup'].includes(d.category ?? '') ? d.category! : 'startup' }];
  });
}

export function mcpSummary(rows: MCPDiagnostic[] | undefined): string {
  return diagnostics(rows).filter((d) => d.stage !== 'ready').map((d) => {
    if (d.stage === 'starting') return `${d.name} is still connecting`;
    if (d.stage === 'cancelled') return `${d.name} startup was cancelled`;
    const reason: Record<string, string> = { auth: 'needs authentication', closed: 'closed its connection', timeout: 'timed out', not_found: 'could not find its command', refused: 'refused the connection' };
    return `${d.name} ${reason[d.category ?? ''] ?? 'failed to start'}`;
  }).join('; ');
}

export function recoveryText(message: string, data?: HireFailure): string {
  if (data?.delivery === 'accepted') return 'The worker accepted your prompt. Check its conversation before sending again. Your task is kept here.';
  if (data?.delivery === 'unknown') return 'Prompt delivery is uncertain. Check the existing worker’s conversation before sending again. Your task is kept here.';
  const cause = mcpSummary(data?.startup);
  const lead = cause ? `Codex could not become ready: ${cause}.` : message;
  return `${lead} Your prompt has not been sent and is kept here.${cause ? ' Fix the MCP connection or disable it in the active Codex configuration, then retry.' : ''}${data && !data.retryable ? ' Cleanup is incomplete: check the desk before hiring again.' : ''}`;
}
