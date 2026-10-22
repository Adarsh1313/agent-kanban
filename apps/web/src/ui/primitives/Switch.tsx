export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (next: boolean) => void; label: string }) {
  return <button className="switch" type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} />;
}
