/** The record and exact file a person chose to discuss; no paper text is copied here. */
export interface PaperSubject {
  title: string;
  paperId?: number;
  file?: { id: string; name: string; vault?: string; version?: string };
}

export function paperTitle(subject: PaperSubject): string {
  return `${subject.title}${subject.file && subject.file.name !== subject.title ? ` · ${subject.file.name}` : ''}`;
}

export function paperQuestion(subject: PaperSubject): string {
  const record = subject.paperId ? ` (paper ${subject.paperId})` : '';
  if (!subject.file) {
    return `What are the main findings and limitations of “${subject.title}”${record}? Use your available tools to read its record first, and say what you could and could not read.`;
  }
  return `What are the main findings and limitations of “${subject.title}”${record}? Its file “${subject.file.name}” is attached to this conversation: read it first, and say which pages you read and what you could not.`;
}

/** The file a paper question attaches to its new conversation: the only Library file Ask can read in it. */
export function paperFiles(subject: PaperSubject | null): { file_id: string; version_id?: string }[] | undefined {
  if (!subject?.file) return undefined;
  return [{ file_id: subject.file.id, ...(subject.file.version ? { version_id: subject.file.version } : {}) }];
}

/** A history entry is untyped; accept only the small handoff this screen writes. */
export function readPaperSubject(state: unknown): PaperSubject | null {
  if (!state || typeof state !== 'object' || !('paper' in state)) return null;
  const p = state.paper;
  if (!p || typeof p !== 'object' || !('title' in p) || typeof p.title !== 'string') return null;
  const subject: PaperSubject = { title: p.title };
  if ('paperId' in p && typeof p.paperId === 'number' && Number.isInteger(p.paperId) && p.paperId > 0) subject.paperId = p.paperId;
  if ('file' in p && p.file && typeof p.file === 'object' && 'id' in p.file && typeof p.file.id === 'string'
    && 'name' in p.file && typeof p.file.name === 'string') {
    subject.file = { id: p.file.id, name: p.file.name,
      ...('version' in p.file && typeof p.file.version === 'string' ? { version: p.file.version } : {}) };
  }
  return subject;
}
