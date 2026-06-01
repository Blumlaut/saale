"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface FieldDef {
  key: string;
  label: string;
  description?: string;
  type: "text" | "number" | "select" | "boolean";
  default?: unknown;
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  step?: number;
}

interface ConfigFormProps {
  fields: FieldDef[];
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}

/**
 * Render form fields dynamically from a field schema.
 */
export function ConfigForm({ fields, values, onChange }: ConfigFormProps) {
  if (fields.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-4">
      {fields.map((field) => {
        const value = values[field.key] ?? field.default;

        return (
          <div key={field.key} className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor={`config-${field.key}`}>{field.label}</Label>
              {field.type === "boolean" && (
                <Switch
                  id={`config-${field.key}`}
                  checked={!!value}
                  onCheckedChange={(checked) => onChange(field.key, checked)}
                  className="scale-75"
                />
              )}
            </div>

            {field.description && (
              <p className="text-muted-foreground -mt-1 text-xs">{field.description}</p>
            )}

            {field.type === "text" && (
              <Input
                id={`config-${field.key}`}
                type="text"
                value={(value as string) ?? ""}
                onChange={(e) => onChange(field.key, e.target.value)}
              />
            )}

            {field.type === "number" && (
              <Input
                id={`config-${field.key}`}
                type="number"
                value={(value as number)?.toString() ?? ""}
                min={field.min}
                max={field.max}
                step={field.step}
                onChange={(e) => {
                  const num = parseFloat(e.target.value);
                  onChange(field.key, Number.isNaN(num) ? "" : num);
                }}
              />
            )}

            {field.type === "select" && (
              <Select
                value={(value as string) ?? ""}
                onValueChange={(v) => onChange(field.key, v)}
              >
                <SelectTrigger id={`config-${field.key}`}>
                  <SelectValue placeholder="Select..." />
                </SelectTrigger>
                <SelectContent>
                  {(field.options ?? []).map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Display config values as labeled read-only fields.
 */
export function ConfigDisplay({
  fields,
  values,
}: {
  fields: FieldDef[];
  values: Record<string, unknown>;
}) {
  if (fields.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-3">
      {fields.map((field) => {
        const value = values[field.key];
        if (value === undefined || value === null || value === "") return null;

        let display: string;
        if (field.type === "boolean") {
          display = value ? "Yes" : "No";
        } else if (field.type === "select" && field.options) {
          const opt = field.options.find((o) => o.value === String(value));
          display = opt?.label ?? String(value);
        } else {
          display = String(value);
        }

        return (
          <div key={field.key} className="flex items-center justify-between">
            <span className="text-muted-foreground text-sm">{field.label}</span>
            <span className="text-sm font-medium">{display}</span>
          </div>
        );
      })}
    </div>
  );
}
