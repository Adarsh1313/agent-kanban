export function Switch({ checked, onChange, label, disabled, describedBy }: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  /** Id of the text that explains the switch's state (e.g. why it cannot be turned on). */
  describedBy?: string;
}) {
  return (
    <button
      className="switch"
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}
