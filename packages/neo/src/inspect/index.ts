import { page } from './page.ts';
import { buildRunReport, MERMAID_URL, type ReportOptions, type RunReport } from './report.ts';
import type { AgentState } from '../state.ts';
import type { PayloadResolver } from '../payload.ts';

export {
    buildRunReport,
    MAX_BLOB_BYTES,
    MERMAID_URL,
    type ReportOptions,
    type RunReport,
} from './report.ts';

/** Report → one standalone HTML document. */
export function renderReportHtml(report: RunReport, opts: ReportOptions = {}): string {
    return page(report, opts.mermaidUrl ?? MERMAID_URL);
}

/** The usual entry point: state in, HTML out. */
export async function renderRunReport(
    state: AgentState,
    payloads: PayloadResolver,
    opts: ReportOptions = {},
): Promise<string> {
    return renderReportHtml(await buildRunReport(state, payloads, opts), opts);
}
