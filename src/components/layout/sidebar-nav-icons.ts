import {
  Calendar,
  CheckSquare,
  ListTodo,
  Mail,
  MessageSquare,
  Server,
  Settings,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { SidebarNavItemId } from "@/lib/navigation/sidebar-nav";

/** Icon per sidebar item. Exhaustive — a new id must be given an icon here. */
export const SIDEBAR_NAV_ICONS: Record<SidebarNavItemId, LucideIcon> = {
  chat: MessageSquare,
  mail: Mail,
  contacts: Users,
  calendar: Calendar,
  tasks: CheckSquare,
  jobs: ListTodo,
  infra: Server,
  settings: Settings,
};
