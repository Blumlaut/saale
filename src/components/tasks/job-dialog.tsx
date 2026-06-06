"use client";

import { useState, useEffect, useCallback } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ConfigForm } from "@/components/tasks/config-form";
import { fetchJson, postJson, patchJson } from "@/lib/http";
import {
  RefreshCw,
  FileText,
  Tags,
  Shield,
  Loader2,
  Brain,
  Check,
  ChevronDown,
} from "lucide-react";
import { cn } from "@/lib/utils";

import type { JobSchema } from "@/types/shared";

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
  /** Job to edit (edit mode). If absent, dialog is in create mode. */
  job?: {
    id: string;
    type: string;
    enabled: boolean;
    modelId: string | null;
    config: Record<string, unknown>;
  } | null;
}

export function JobDialog({ open, onOpenChange, onSuccess, job }: JobDialogProps) {
  const [schemas, setSchemas] = useState<JobSchema[]>([]);
  const [loadingSchemas, setLoadingSchemas] = useState(true);
  const [selectedType, setSelectedType] = useState("");
  const [cronExpression, setCronExpression] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [configValues, setConfigValues] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const isEditMode = !!job;

  // Fetch schemas from API
  useEffect(() => {
    if (!open) return;
    setLoadingSchemas(true);
    fetchJson<{ schemas: JobSchema[] }>("/api/jobs/schemas")
      .then((data) => setSchemas(data.schemas ?? []))
      .catch((err) => {
        console.error("Failed to load job schemas:", err);
      })
      .finally(() => setLoadingSchemas(false));
  }, [open]);

  // Pre-populate form when editing
  useEffect(() => {
    if (!open || !job) return;
    setSelectedType(job.type);
    setCronExpression((job.config?.cronExpression as string) ?? "");
    setEnabled(job.enabled);

    const defaults: Record<string, unknown> = {};
    const schema = schemas.find((s) => s.type === job.type);
    if (schema) {
      for (const field of schema.fields) {
        if (job.config?.[field.key] !== undefined) {
          defaults[field.key] = job.config[field.key];
        } else if (field.default !== undefined) {
          defaults[field.key] = field.default;
        }
      }
    }
    setConfigValues(defaults);
    setError("");
  }, [open, job, schemas]);

  const selectedSchema = schemas.find((s) => s.type === selectedType);

  const resetForm = useCallback(() => {
    setSelectedType("");
    setCronExpression("");
    setEnabled(true);
    setConfigValues({});
    setError("");
  }, []);

  const handleReset = useCallback(() => {
    if (job) {
      // Re-populate from the original job data
      setSelectedType(job.type);
      setCronExpression((job.config?.cronExpression as string) ?? "");
      setEnabled(job.enabled);
      const defaults: Record<string, unknown> = {};
      const schema = schemas.find((s) => s.type === job.type);
      if (schema) {
        for (const field of schema.fields) {
          if (job.config?.[field.key] !== undefined) {
            defaults[field.key] = job.config[field.key];
          } else if (field.default !== undefined) {
            defaults[field.key] = field.default;
          }
        }
      }
      setConfigValues(defaults);
    } else {
      resetForm();
    }
    setError("");
  }, [job, schemas, resetForm]);

  const handleTypeChange = useCallback(
    (type: string | null) => {
      if (!type) return;
      setSelectedType(type);
      const schema = schemas.find((s) => s.type === type);
      if (schema) {
        setCronExpression(schema.defaultCron ?? "");
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

  const handleSubmit = async () => {
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

      // Extract modelId for top-level field
      const modelId = config.modelId || undefined;
      delete config.modelId;

      if (isEditMode && job) {
        await patchJson(`/api/jobs/${job.id}`, {
          type: selectedType,
          enabled,
          config,
          modelId,
        });
      } else {
        await postJson("/api/jobs", {
          type: selectedType,
          enabled,
          config,
          modelId,
        });
      }

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
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{isEditMode ? "Edit Job" : "Create Job"}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/* Template selection */}
          {loadingSchemas ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
            </div>
          ) : (
            <div className="space-y-2">
              <Label>Task Type</Label>
              <Popover>
                <PopoverTrigger>
                  <button
                    type="button"
                    className={cn(
                      "border-input bg-background flex h-9 w-full items-center gap-2 rounded-md border px-3 text-sm transition-colors hover:bg-white/5",
                      !selectedType && "text-muted-foreground",
                    )}
                  >
                    {selectedType ? (
                      <>
                        {(() => {
                          const schema = schemas.find((s) => s.type === selectedType);
                          const Icon = schema?.icon
                            ? (iconMap[schema.icon] ?? RefreshCw)
                            : RefreshCw;
                          return <Icon className="text-muted-foreground h-4 w-4 shrink-0" />;
                        })()}
                        <span className="flex-1 text-left">
                          {schemas.find((s) => s.type === selectedType)?.label}
                        </span>
                        <ChevronDown className="text-muted-foreground h-4 w-4 shrink-0" />
                      </>
                    ) : (
                      <>
                        <RefreshCw className="text-muted-foreground h-4 w-4 shrink-0" />
                        <span className="flex-1 text-left">Select a task type</span>
                        <ChevronDown className="text-muted-foreground h-4 w-4 shrink-0" />
                      </>
                    )}
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-[300px] gap-0 p-1" align="start">
                  {schemas.map((schema) => {
                    const Icon = schema.icon ? (iconMap[schema.icon] ?? RefreshCw) : RefreshCw;
                    const isSelected = schema.type === selectedType;

                    return (
                      <button
                        key={schema.type}
                        type="button"
                        className={cn(
                          "flex w-full items-start gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors",
                          "hover:bg-white/10 dark:hover:bg-white/5",
                          isSelected && "bg-primary/10",
                        )}
                        onClick={() => {
                          handleTypeChange(schema.type);
                        }}
                      >
                        {/* Check indicator */}
                        <div className="flex h-4 w-4 shrink-0 items-center justify-center pt-0.5">
                          {isSelected && <Check className="text-primary h-3.5 w-3.5" />}
                        </div>

                        {/* Icon */}
                        <Icon className="text-muted-foreground h-4 w-4 shrink-0 pt-0.5" />

                        {/* Label + description */}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1">
                            <span className={cn("text-sm", isSelected ? "font-medium" : "")}>
                              {schema.label}
                            </span>
                            {schema.usesAi && (
                              <Brain className="text-muted-foreground h-3 w-3 shrink-0" />
                            )}
                          </div>
                          <span className="text-muted-foreground text-xs">
                            {schema.description}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </PopoverContent>
              </Popover>
            </div>
          )}

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
              Examples: <code>* * * * *</code> (every minute), <code>*/30 * * * *</code> (every 30
              min), <code>0 9 * * *</code> (daily at 9am)
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
            <Button variant="secondary" onClick={handleReset}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={loading || !selectedType}>
              {loading
                ? isEditMode
                  ? "Saving..."
                  : "Creating..."
                : isEditMode
                  ? "Save Changes"
                  : "Create Job"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
