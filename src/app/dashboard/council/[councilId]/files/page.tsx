"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { Page } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { FileBrowser } from "@/components/files/file-browser";

/**
 * A council's shared workspace.
 *
 * The same browser a user's own files will use. only the target token differs,
 * so the workspace's identity, label and capabilities all come from the API
 * rather than from this page.
 */
export default function CouncilFilesPage() {
  const params = useParams<{ councilId: string }>();
  const councilId = params?.councilId ?? "";

  if (!councilId) return null;

  return (
    <Page className="gap-0">
      <div className="min-h-0 flex-1">
        <FileBrowser
          target={`council:${councilId}`}
          leading={
            <Button asChild variant="ghost" size="icon-sm" className="shrink-0">
              <Link href={`/dashboard/council/${councilId}`} aria-label="Back to the room">
                <ChevronLeft className="h-4 w-4" />
              </Link>
            </Button>
          }
          emptyHint="Members write here as they work. Upload reference material before convening a run if you want them to have it."
        />
      </div>
    </Page>
  );
}
