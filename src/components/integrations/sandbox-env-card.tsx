"use client";

import { useId, useState } from "react";
import { KeyRound, Loader2, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { useSandboxEnv } from "@/hooks/use-sandbox-env";
import { SAALE_SESSION_ENV } from "@/lib/sandbox/env-vars";
import { ROW_ACTION } from "@/lib/utils";

/**
 * The environment variables handed to an agent's commands.
 *
 * Values go in and never come back: the API answers with names, so the panel
 * lists what is set and leaves the value to the user who set it. That is also
 * why there is no edit dialog. a new value for a name is the same form again.
 */
export function SandboxEnvCard() {
  const { names, loading, saving, error, setVariable, removeVariable } = useSandboxEnv();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  // A tab panel can be rendered more than once; a fixed id would duplicate.
  const nameId = useId();
  const valueId = useId();

  const submit = async () => {
    if (!name.trim() || !value.trim()) return;
    const saved = await setVariable(name, value);
    if (saved) {
      setName("");
      setValue("");
    }
  };

  const remove = async (variable: string) => {
    setRemoving(variable);
    try {
      await removeVariable(variable);
    } finally {
      setRemoving(null);
    }
  };

  return (
    <div className="liquid-glass-inner flex min-w-0 flex-col rounded-2xl border-0 p-5">
      <div className="flex items-start gap-3">
        <div className="bg-muted shrink-0 rounded-xl p-2.5">
          <KeyRound className="h-5 w-5 text-amber-500" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-medium">Environment variables</h4>
            <Badge variant={names.length > 0 ? "secondary" : "outline"} className="rounded-full">
              {names.length > 0 ? `${names.length} set` : "None set"}
            </Badge>
          </div>
          <p className="text-muted-foreground mt-1 text-xs">
            Available to every command an agent runs in your workspace. A value is stored encrypted
            and never shown again.
          </p>
        </div>
      </div>

      <div className="mt-4 flex-1 space-y-3">
        {loading ? (
          <div className="flex items-center gap-2 py-2">
            <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
            <span className="text-muted-foreground text-xs">Loading…</span>
          </div>
        ) : (
          <>
            {names.length > 0 && (
              <ul className="space-y-1">
                {names.map((variable, index) => (
                  <li key={variable}>
                    {index > 0 && <Separator className="my-1" />}
                    <div className="group flex min-h-10 items-center gap-2">
                      <code className="min-w-0 flex-1 truncate text-xs font-medium">
                        {variable}
                      </code>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove ${variable}`}
                        disabled={saving}
                        onClick={() => void remove(variable)}
                        className={`${ROW_ACTION} h-8 w-8 shrink-0`}
                      >
                        {removing === variable ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="min-w-0 flex-1">
                <Label htmlFor={nameId} className="sr-only">
                  Variable name
                </Label>
                <Input
                  id={nameId}
                  value={name}
                  onChange={(event) => setName(event.target.value.toUpperCase())}
                  placeholder="GH_TOKEN"
                  autoComplete="off"
                  spellCheck={false}
                  className="h-9 font-mono text-xs"
                />
              </div>
              <div className="min-w-0 flex-1">
                <Label htmlFor={valueId} className="sr-only">
                  Value
                </Label>
                <Input
                  id={valueId}
                  type="password"
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  placeholder="value"
                  autoComplete="new-password"
                  className="h-9 text-xs"
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void submit();
                  }}
                />
              </div>
              <Button
                type="button"
                size="sm"
                className="h-9 shrink-0"
                disabled={saving || !name.trim() || !value.trim()}
                onClick={() => void submit()}
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
              </Button>
            </div>

            {error && <p className="text-destructive text-xs break-words">{error}</p>}
          </>
        )}
      </div>

      <div className="border-border/60 mt-4 border-t pt-3">
        <p className="text-muted-foreground text-xs">
          Saale sets these itself. A variable you set with the same name wins.
        </p>
        <ul className="mt-2 space-y-1">
          {SAALE_SESSION_ENV.map((variable) => (
            <li key={variable.name} className="flex flex-wrap items-baseline gap-x-2 text-xs">
              <code className="font-medium">{variable.name}</code>
              <span className="text-muted-foreground min-w-0 break-words">{variable.what}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
