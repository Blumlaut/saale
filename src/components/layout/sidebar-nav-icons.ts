import {
  Calendar,
  Code2,
  CheckSquare,
  FolderTree,
  Landmark,
  ListTodo,
  Mail,
  MessageSquare,
  Server,
  Settings,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { SidebarNavItemId } from "@/lib/navigation/sidebar-nav";

/** Icon per sidebar item. Exhaustive. a new id must be given an icon here. */
export const SIDEBAR_NAV_ICONS: Record<SidebarNavItemId, LucideIcon> = {
  chat: MessageSquare,
  coder: Code2,
  files: FolderTree,
  mail: Mail,
  contacts: Users,
  calendar: Calendar,
  tasks: CheckSquare,
  jobs: ListTodo,
  council: Landmark,
  infra: Server,
  settings: Settings,
};
