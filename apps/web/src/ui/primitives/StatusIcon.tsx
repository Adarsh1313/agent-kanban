export type StatusState = 'running' | 'needs' | 'needs_you' | 'review' | 'done';

/** Linear-style column state icons (14px), ported from design/components.js statusIcon(). */
export function StatusIcon({ state }: { state: StatusState }) {
  switch (state) {
    case 'running':
      return (
        <svg className="status running" viewBox="0 0 14 14" aria-hidden="true">
          <circle className="track" cx="7" cy="7" r="5.5" fill="none" strokeWidth="1.6" />
          <circle className="arc" cx="7" cy="7" r="5.5" fill="none" strokeWidth="1.6" strokeLinecap="round" strokeDasharray="9 26" />
        </svg>
      );
    case 'needs':
    case 'needs_you':
      return (
        <svg className="status" viewBox="0 0 14 14" aria-hidden="true">
          <circle cx="7" cy="7" r="6" fill="var(--color-needs)" />
          <path d="M7 3.8v3.6" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="7" cy="9.9" r=".95" fill="#fff" />
        </svg>
      );
    case 'review':
      return (
        <svg className="status" viewBox="0 0 14 14" aria-hidden="true">
          <circle cx="7" cy="7" r="5.5" fill="none" stroke="var(--color-review)" strokeWidth="1.6" />
          <path d="M7 3.5A3.5 3.5 0 1 1 3.5 7H7z" fill="var(--color-review)" />
        </svg>
      );
    case 'done':
      return (
        <svg className="status" viewBox="0 0 14 14" aria-hidden="true">
          <circle cx="7" cy="7" r="6" fill="var(--color-done)" />
          <path d="M4.4 7.2l1.8 1.8 3.4-3.6" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
  }
}
