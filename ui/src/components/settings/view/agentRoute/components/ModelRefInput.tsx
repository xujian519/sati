import { Select } from "../../../shared/components/Inputs";
import type { ModelOption } from "../../../../../shared/modelOptions";

type ModelRefInputProps = {
  value: string | undefined;
  onChange: (next: string) => void;
  options: ModelOption[];
  placeholder?: string;
};

export default function ModelRefInput({ value, onChange, options, placeholder }: ModelRefInputProps) {
  const selected = value ?? "";
  const hasSelected = !selected || options.some(opt => opt.value === selected);
  const selectOptions = [
    { value: "", label: placeholder ?? "Select a configured model" },
    ...options.map(opt => ({
      value: opt.value,
      label: opt.supportsImage ? `🖼 ${opt.label}` : opt.label,
    })),
    ...(!hasSelected ? [{ value: selected, label: `Missing: ${selected}` }] : []),
  ];
  return <Select value={selected} onChange={onChange} options={selectOptions} />;
}
