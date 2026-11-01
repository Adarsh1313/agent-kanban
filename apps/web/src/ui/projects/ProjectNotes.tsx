import { useId, useState } from 'react';
import { folderKey, type Project } from '@agent-kanban/shared';
import { api } from '../../api/client.ts';
import { applySettings } from '../../state/reducer.ts';
import { useStore, useStoreInstance } from '../../state/store.ts';
import { Dialog } from '../primitives/Dialog.tsx';
import { Switch, toast } from '../primitives/index.ts';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Project notes (#40): off by default, since turning them on writes into the user's folder. */
export function ProjectNotes({ project }: { project: Project }) {
  const store = useStoreInstance();
  const on = useStore((s) => (s.settings?.notesProjects ?? []).some((k) => folderKey(k) === folderKey(project.path)));
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const noteId = useId();

  const toggle = async (next: boolean) => {
    try {
      const settings = await api.setNotes(project.path, next); store.setState((s) => applySettings(s, settings));
    } catch (e) { toast(errText(e)); }
  };
  const openNotes = async () => {
    setOpen(true);
    setText(null);
    try { setText((await api.notes(project.path)).text); } catch (e) { toast(errText(e)); setOpen(false); }
  };
  const save = async () => {
    if (text === null) return;
    setSaving(true);
    try { await api.saveNotes(project.path, text); setOpen(false); } catch (e) { toast(errText(e)); } finally { setSaving(false); }
  };

  return (
    <div className="project-notes">
      <h3 className="section-title">Project notes</h3>
      <div className="toggle-row">
        <span>Project notes<small id={noteId}>Adds .agent-kanban/notes.md to this folder. Every agent reads and updates it at the end of each task.</small></span>
        <Switch checked={on} label="Project notes" describedBy={noteId} onChange={(v) => void toggle(v)} />
      </div>
      {on && <button className="btn" type="button" onClick={() => void openNotes()}>Open notes</button>}
      <Dialog open={open} onClose={() => setOpen(false)} title="Project notes"
        footer={<><button className="btn ghost" type="button" onClick={() => setOpen(false)}>Cancel</button><button className="btn primary" type="button" disabled={text === null || saving} onClick={() => void save()}>Save</button></>}>
        <textarea className="notes-edit" aria-label="Notes" value={text ?? ''} disabled={text === null} onChange={(e) => setText(e.target.value)} />
      </Dialog>
    </div>
  );
}
