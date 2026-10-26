"use client";

import { User } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useCurrentUserImage } from "@/hooks/use-current-user-image";
import { cn } from "@/lib/utils";

/**
 * The signed-in user's picture, in the circle the caller sizes and styles. The
 * outline icon stands in while they have no picture.
 */
export function UserAvatar({
  className,
  iconClassName = "h-4 w-4",
}: {
  className?: string;
  iconClassName?: string;
}) {
  const image = useCurrentUserImage();

  return (
    <Avatar className={cn(className)}>
      {image ? <AvatarImage src={image} alt="" /> : null}
      <AvatarFallback className="bg-transparent">
        <User className={iconClassName} aria-hidden />
      </AvatarFallback>
    </Avatar>
  );
}
