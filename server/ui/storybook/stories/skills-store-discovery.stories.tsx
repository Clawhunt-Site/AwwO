import { useMemo, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { DiscoveryGrid, type DiscoveryCard, type DiscoveryCategory } from "@/pages/CompanySkills";

type DiscoveryTab = "all" | "installed";
type DiscoverySort = "agents" | "stars" | "forks" | "recent" | "alphabetical";

// Local-only store fixtures: every card is a company-authored or user-imported
// skill that survives the production isUpstreamCatalogSkill filter (no reserved
// `paperclipai/paperclip/` keys, no catalog refs, no `required`/bundled cards) — so
// the story mirrors what the real grid actually shows.
const MOCK_CARDS: DiscoveryCard[] = [
  {
    key: "acme/agent-browser",
    skillId: "s-browser",
    catalogRef: null,
    name: "agent-browser",
    slug: "agent-browser",
    author: "here.now",
    version: "v0.8.2",
    tagline: "Drive browsers from an agent loop.",
    description: "Browser automation CLI for AI agents.",
    categories: ["research", "browsers"],
    iconUrl: null,
    color: null,
    starCount: 81,
    agentCount: 9,
    forkCount: 11,
    installed: true,
    required: false,
    forkedFrom: false,
    updatedAt: Date.now() - 5 * 86_400_000,
    sourceBadge: "skills_sh",
  },
  {
    key: "acme/verify",
    skillId: "s-verify",
    catalogRef: null,
    name: "verify",
    slug: "verify",
    author: "acme",
    version: "v1.0.3",
    tagline: "Prove the change works in a real app run.",
    description: "Verify a code change works by running the app.",
    categories: ["testing"],
    iconUrl: null,
    color: null,
    starCount: 22,
    agentCount: 7,
    forkCount: 1,
    installed: true,
    required: false,
    forkedFrom: false,
    updatedAt: Date.now() - 9 * 86_400_000,
    sourceBadge: "local",
  },
  {
    key: "acme/hue-prosumer",
    skillId: "s-hue",
    catalogRef: null,
    name: "hue-prosumer",
    slug: "hue-prosumer",
    author: "you",
    version: "v0.1.0",
    tagline: "Remix a design-language skill for production use.",
    description: "Generate design language skills, prosumer remix.",
    categories: ["design"],
    iconUrl: null,
    color: null,
    starCount: 4,
    agentCount: 2,
    forkCount: 0,
    installed: true,
    required: false,
    forkedFrom: true,
    updatedAt: Date.now() - 1 * 86_400_000,
    sourceBadge: "paperclip",
  },
  {
    key: "acme/security-review",
    skillId: "s-sec",
    catalogRef: null,
    name: "security-review",
    slug: "security-review",
    author: "acme",
    version: "v1.1.0",
    tagline: "Review a branch for concrete security risks.",
    description: "Security review of pending changes on a branch.",
    categories: ["security"],
    iconUrl: null,
    color: null,
    starCount: 29,
    agentCount: 5,
    forkCount: 2,
    installed: true,
    required: false,
    forkedFrom: false,
    updatedAt: Date.now() - 3 * 86_400_000,
    sourceBadge: "github",
  },
  {
    key: "astra/deep-research",
    skillId: "s-research",
    catalogRef: null,
    name: "deep-research",
    slug: "deep-research",
    author: "Astra",
    version: "v2.0.0",
    tagline: "Synthesize multiple sources with citations.",
    description: "Multi-source research with citation-grade synthesis.",
    categories: ["research"],
    iconUrl: null,
    color: null,
    starCount: 211,
    agentCount: 31,
    forkCount: 17,
    installed: true,
    required: false,
    forkedFrom: false,
    updatedAt: Date.now() - 4 * 86_400_000,
    sourceBadge: "local",
  },
];

const DISCOVERY_TABS: DiscoveryTab[] = ["all", "installed"];

function cardsForTab(cards: DiscoveryCard[], tab: DiscoveryTab): DiscoveryCard[] {
  if (tab === "installed") return cards.filter((c) => c.installed);
  return cards;
}

function DiscoveryGridHarness({
  initialTab = "all",
  cards = MOCK_CARDS,
}: {
  initialTab?: DiscoveryTab;
  cards?: DiscoveryCard[];
}) {
  const [tab, setTab] = useState<DiscoveryTab>(initialTab);
  const [sort, setSort] = useState<DiscoverySort>("agents");
  const [category, setCategory] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const tabCards = useMemo(() => cardsForTab(cards, tab), [cards, tab]);
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = tabCards.filter((card) => {
      if (category && !card.categories.includes(category)) return false;
      if (!q) return true;
      return `${card.name} ${card.author} ${card.categories.join(" ")}`.toLowerCase().includes(q);
    });
    const demote = true;
    return [...filtered].sort((a, b) => {
      if (demote && a.required !== b.required) return a.required ? 1 : -1;
      if (sort === "stars") return b.starCount - a.starCount;
      if (sort === "forks") return b.forkCount - a.forkCount;
      if (sort === "recent") return b.updatedAt - a.updatedAt;
      if (sort === "alphabetical") return a.name.localeCompare(b.name);
      return b.agentCount - a.agentCount;
    });
  }, [tabCards, category, search, sort, tab]);

  const tabCounts = useMemo(
    () => ({
      all: cards.length,
      installed: cards.filter((c) => c.installed).length,
    }),
    [cards],
  ) as Record<DiscoveryTab, number>;

  return (
    <DiscoveryGrid
      tab={tab}
      tabCounts={tabCounts}
      onTabChange={(next) => {
        setTab(next);
        setCategory(null);
      }}
      activeCategory={category}
      onCategoryChange={setCategory}
      search={search}
      onSearchChange={setSearch}
      sort={sort}
      onSortChange={setSort}
      cards={visible}
      onOpenCard={() => {}}
      loading={false}
      error={null}
      totalCount={cards.length}
      onCreate={() => {}}
      onImport={() => {}}
      onScan={() => {}}
      scanPending={false}
      scanStatus={null}
    />
  );
}

const meta: Meta<typeof DiscoveryGridHarness> = {
  title: "Skills Store/Discovery grid",
  component: DiscoveryGridHarness,
  parameters: { layout: "fullscreen" },
};

export default meta;

type Story = StoryObj<typeof DiscoveryGridHarness>;

export const AllSkills: Story = { args: { initialTab: "all" } };
export const InstalledTab: Story = { args: { initialTab: "installed" } };
export const EmptyLibrary: Story = { args: { initialTab: "all", cards: [] } };
