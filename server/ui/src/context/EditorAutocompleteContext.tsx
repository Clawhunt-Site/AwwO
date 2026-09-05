import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { buildPluginMentionHref, buildRoutineMentionHref, buildSkillMentionHref } from "@paperclipai/shared";
import { companySkillsApi } from "../api/companySkills";
import { pluginsApi } from "../api/plugins";
import { routinesApi } from "../api/routines";
import { useCompany } from "./CompanyContext";
import { queryKeys } from "../lib/queryKeys";

export interface SkillCommandOption {
  id: string;
  kind: "skill";
  skillId: string;
  key: string;
  name: string;
  slug: string;
  description: string | null;
  href: string;
  aliases: string[];
}

export interface RoutineCommandOption {
  id: string;
  kind: "routine";
  routineId: string;
  name: string;
  status: string;
  href: string;
  aliases: string[];
}

export interface PluginCommandOption {
  id: string;
  kind: "plugin";
  pluginId: string;
  name: string;
  href: string;
  aliases: string[];
}

export type SlashCommandOption = SkillCommandOption | RoutineCommandOption | PluginCommandOption;

interface EditorAutocompleteContextValue {
  slashCommands: SlashCommandOption[];
}

const EditorAutocompleteContext = createContext<EditorAutocompleteContextValue>({
  slashCommands: [],
});

export function EditorAutocompleteProvider({ children }: { children: ReactNode }) {
  const { selectedCompanyId } = useCompany();
  const { data: companySkills = [] } = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.companySkills.list(selectedCompanyId)
      : ["company-skills", "__none__"],
    queryFn: () => companySkillsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const { data: routines = [] } = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.routines.list(selectedCompanyId)
      : ["routines", "__none__", "__all-projects__"],
    queryFn: () => routinesApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  // Installed plugins offered as `plugin://` mentions — the run-scoped instant
  // opt-in for the plugin-tool bridge. Plugins are instance-wide (not
  // company-scoped), so this query does not depend on the selected company.
  const { data: plugins = [] } = useQuery({
    queryKey: queryKeys.plugins.list("ready"),
    queryFn: () => pluginsApi.list("ready"),
  });

  const value = useMemo<EditorAutocompleteContextValue>(() => ({
    slashCommands: [
      ...companySkills.map((skill) => ({
        id: `skill:${skill.id}`,
        kind: "skill" as const,
        skillId: skill.id,
        key: skill.key,
        name: skill.name,
        slug: skill.slug,
        description: skill.description ?? null,
        href: buildSkillMentionHref(skill.id, skill.slug),
        aliases: [skill.slug, skill.name, skill.key],
      })),
      ...routines
        .filter((routine) => routine.status !== "archived")
        .sort((left, right) => left.title.localeCompare(right.title))
        .map((routine) => ({
          id: `routine:${routine.id}`,
          kind: "routine" as const,
          routineId: routine.id,
          name: routine.title,
          status: routine.status,
          href: buildRoutineMentionHref(routine.id),
          aliases: [`routine:${routine.title}`, routine.title, routine.id],
        })),
      ...[...plugins]
        .sort((left, right) => left.pluginKey.localeCompare(right.pluginKey))
        .map((plugin) => ({
          id: `plugin:${plugin.id}`,
          kind: "plugin" as const,
          pluginId: plugin.id,
          name: plugin.pluginKey,
          href: buildPluginMentionHref(plugin.id),
          aliases: [`plugin:${plugin.pluginKey}`, plugin.pluginKey, plugin.packageName],
        })),
    ],
  }), [companySkills, routines, plugins]);

  return (
    <EditorAutocompleteContext.Provider value={value}>
      {children}
    </EditorAutocompleteContext.Provider>
  );
}

export function useEditorAutocomplete() {
  return useContext(EditorAutocompleteContext);
}
