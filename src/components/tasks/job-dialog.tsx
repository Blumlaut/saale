"use client";

import { useState, useEffect, useCallback } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { ConfigForm } from "@/components/tasks/config-form";
import { RefreshCw, FileText, Tags, Shield, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

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

interface JobSchema {
  type: string;
  label: string;
  description: string;
  icon: string;
  defaultCron: string;
  fields: FieldDef[];
}

// Icon map (keeps the import bundle small)
const iconMap: Record<string, React.ElementType> = {
  RefreshCw: RefreshCw,
  FileText: FileText,
  Tags: Tags,
  Shield: Shield,
};

interface JobDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

export function JobDialog({ open, onOpenChange, onSuccess }: JobDialogProps) {
  const [schemas, setSchemas] = useState<JobSchema[]>([]);
  const [loadingSchemas, setLoadingSchemas] = useState(true);
  const [selectedType, setSelectedType] = useState("");
  const [cronExpression, setCronExpression] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [configValues, setConfigValues] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Fetch schemas from API
  useEffect(() => {
    if (!open) return;
    setLoadingSchemas(true);
    fetch("/api/jobs/schemas")
      .then((r) => r.json())
      .then((data) => setSchemas(data.schemas ?? []))
      .catch(() => {})
      .finally(() => setLoadingSchemas(false));
  }, [open]);

  const selectedSchema = schemas.find((s) => s.type === selectedType);

  const resetForm = useCallback(() => {
    setSelectedType("");
    setCronExpression("");
    setEnabled(true);
    setConfigValues({});
    setError("");
  }, []);

  const handleTypeChange = useCallback(
    (type: string) => {
      setSelectedType(type);
      const schema = schemas.find((s) => s.type === type);
      if (schema) {
        setCronExpression(schema.defaultCron);
        // Set default config values from schema
        const defaults: Record<string, unknown> = {};
        for (const field of schema.fields) {
          if (field.default !== undefined) {
            defaults[field.key] = field.default;
          }
        }
        setConfigValues(defaults);
      }
    },
    [schemas],
  );

  const handleConfigChange = useCallback((key: string, value: unknown) => {
    setConfigValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleCreate = async () => {
    if (!selectedType) return;

    setLoading(true);
    setError("");

    try {
      // Build config: merge schema defaults + user values + cron
      const schema = schemas.find((s) => s.type === selectedType);
      const defaults: Record<string, unknown> = schema
        ? Object.fromEntries(schema.fields.map((f) => [f.key, f.default]))
        : {};

      const config: Record<string, unknown> = {
        cronExpression,
        ...defaults,
        ...configValues,
      };

      // Remove empty string values for optional fields
      for (const key of Object.keys(config)) {
        if (config[key] === "") {
          delete config[key];
        }
      }

      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: selectedType,
          enabled,
          config,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to create job");
      }

      resetForm();
      onOpenChange(false);
      onSuccess?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) resetForm();
        onOpenChange(isOpen);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Job</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/* Template selection */}
          <div className="grid gap-2 sm:grid-cols-2">
            {loadingSchemas ? (
              <div className="col-span-2 flex items-center justify-center py-6">
                <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
              </div>
            ) : (
              schemas.map((schema) => {
                const Icon = iconMap[schema.icon] ?? RefreshCw;
                return (
                  <button
                    key={schema.type}
                    onClick={() => handleTypeChange(schema.type)}
                    className={cn(
                      "flex flex-col items-start gap-1 rounded-xl border p-3 text-left transition-colors hover:bg-white/20 dark:hover:bg-white/5",
                      selectedType === schema.type &&
                        "border-primary bg-white/20 dark:bg-white/5",
                    )}
                  >
                    <Icon className="h-4 w-4" />
                    <span className="text-sm font-medium">{schema.label}</span>
                    <span className="text-muted-foreground text-xs">
                      {schema.description}
                    </span>
                  </button>
                );
              })
            )}
          </div>

          <Separator />

          {/* Schedule */}
          <div className="space-y-2">
            <Label>Cron Schedule</Label>
            <Input
              value={cronExpression}
              onChange={(e) => setCronExpression(e.target.value)}
              placeholder="*/30 * * * *"
              disabled={!selectedType}
            />
            <p className="text-muted-foreground text-xs">
              Examples: <code>* * * * *</code> (every minute),{" "}
              <code>*/30 * * * *</code> (every 30 min), <code>0 9 * * *</code> (daily at 9am)
            </p>
          </div>

          {/* Dynamic config fields */}
          {selectedSchema && (
            <ConfigForm
              fields={selectedSchema.fields}
              values={configValues}
              onChange={handleConfigChange}
            />
          )}

          {/* Enabled */}
          <div className="flex items-center gap-2">
            <Switch checked={enabled} onCheckedChange={setEnabled} id="job-enabled" />
            <Label htmlFor="job-enabled">Enabled</Label>
          </div>

          {/* Error */}
          {error && (
            <div className="text-destructive bg-destructive/10 rounded-lg px-3 py-2 text-sm">
              {error}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={loading || !selectedType}>
              {loading ? "Creating..." : "Create Job"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
