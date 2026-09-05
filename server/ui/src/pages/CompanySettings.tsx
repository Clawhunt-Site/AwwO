import { ChangeEvent, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DEFAULT_COMPANY_ATTACHMENT_MAX_BYTES,
  MAX_COMPANY_ATTACHMENT_MAX_BYTES,
} from "@paperclipai/shared";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { companiesApi } from "../api/companies";
import { assetsApi } from "../api/assets";
import { instanceSettingsApi } from "../api/instanceSettings";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Settings, CloudUpload, Download, Upload } from "lucide-react";
import { CompanyPatternIcon } from "../components/CompanyPatternIcon";
import { useLocalizedText } from "../i18n/localized";
import {
  Field,
  ToggleField,
} from "../components/agent-config-primitives";

const BYTES_PER_MIB = 1024 * 1024;
const DEFAULT_COMPANY_ATTACHMENT_MAX_MIB = DEFAULT_COMPANY_ATTACHMENT_MAX_BYTES / BYTES_PER_MIB;
const MAX_COMPANY_ATTACHMENT_MAX_MIB = MAX_COMPANY_ATTACHMENT_MAX_BYTES / BYTES_PER_MIB;
export function CompanySettings() {
  const {
    companies,
    selectedCompany,
    selectedCompanyId,
    setSelectedCompanyId
  } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const localize = useLocalizedText();
  const queryClient = useQueryClient();
  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  // General settings local state
  const [companyName, setCompanyName] = useState("");
  const [description, setDescription] = useState("");
  const [brandColor, setBrandColor] = useState("");
  const [attachmentMaxMiB, setAttachmentMaxMiB] = useState(String(DEFAULT_COMPANY_ATTACHMENT_MAX_MIB));
  const [logoUrl, setLogoUrl] = useState("");
  const [logoUploadError, setLogoUploadError] = useState<string | null>(null);

  // Sync local state from selected company
  useEffect(() => {
    if (!selectedCompany) return;
    setCompanyName(selectedCompany.name);
    setDescription(selectedCompany.description ?? "");
    setBrandColor(selectedCompany.brandColor ?? "");
    setAttachmentMaxMiB(String(Math.round((selectedCompany.attachmentMaxBytes ?? DEFAULT_COMPANY_ATTACHMENT_MAX_BYTES) / BYTES_PER_MIB)));
    setLogoUrl(selectedCompany.logoUrl ?? "");
  }, [selectedCompany]);

  const attachmentMaxBytes = Number.parseInt(attachmentMaxMiB, 10) * BYTES_PER_MIB;
  const attachmentMaxValid =
    Number.isInteger(attachmentMaxBytes)
    && attachmentMaxBytes >= BYTES_PER_MIB
    && attachmentMaxBytes <= MAX_COMPANY_ATTACHMENT_MAX_BYTES;
  const cloudSyncEnabled = experimentalSettings?.enableCloudSync === true;

  const generalDirty =
    !!selectedCompany &&
    (companyName !== selectedCompany.name ||
      description !== (selectedCompany.description ?? "") ||
      brandColor !== (selectedCompany.brandColor ?? "") ||
      attachmentMaxBytes !== (selectedCompany.attachmentMaxBytes ?? DEFAULT_COMPANY_ATTACHMENT_MAX_BYTES));

  const generalMutation = useMutation({
    mutationFn: (data: {
      name: string;
      description: string | null;
      brandColor: string | null;
      attachmentMaxBytes: number;
    }) => companiesApi.update(selectedCompanyId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    }
  });

  const settingsMutation = useMutation({
    mutationFn: (requireApproval: boolean) =>
      companiesApi.update(selectedCompanyId!, {
        requireBoardApprovalForNewAgents: requireApproval
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    }
  });

  const syncLogoState = (nextLogoUrl: string | null) => {
    setLogoUrl(nextLogoUrl ?? "");
    void queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
  };

  const logoUploadMutation = useMutation({
    mutationFn: (file: File) =>
      assetsApi
        .uploadCompanyLogo(selectedCompanyId!, file)
        .then((asset) => companiesApi.update(selectedCompanyId!, { logoAssetId: asset.assetId })),
    onSuccess: (company) => {
      syncLogoState(company.logoUrl);
      setLogoUploadError(null);
    }
  });

  const clearLogoMutation = useMutation({
    mutationFn: () => companiesApi.update(selectedCompanyId!, { logoAssetId: null }),
    onSuccess: (company) => {
      setLogoUploadError(null);
      syncLogoState(company.logoUrl);
    }
  });

  function handleLogoFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    event.currentTarget.value = "";
    if (!file) return;
    setLogoUploadError(null);
    logoUploadMutation.mutate(file);
  }

  function handleClearLogo() {
    clearLogoMutation.mutate();
  }

  const archiveMutation = useMutation({
    mutationFn: ({
      companyId,
      nextCompanyId
    }: {
      companyId: string;
      nextCompanyId: string | null;
    }) => companiesApi.archive(companyId).then(() => ({ nextCompanyId })),
    onSuccess: async ({ nextCompanyId }) => {
      if (nextCompanyId) {
        setSelectedCompanyId(nextCompanyId);
      }
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companies.all
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companies.stats
      });
    }
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? localize({ en: "Company", zh: "公司" }), href: "/dashboard" },
      { label: localize({ en: "Settings", zh: "设置" }) }
    ]);
  }, [localize, setBreadcrumbs, selectedCompany?.name]);

  if (!selectedCompany) {
    return (
      <div className="text-sm text-muted-foreground">
        {localize({
          en: "No company selected. Select a company from the switcher above.",
          zh: "尚未选择公司。请从上方切换器选择一个公司。",
        })}
      </div>
    );
  }

  function handleSaveGeneral() {
    generalMutation.mutate({
      name: companyName.trim(),
      description: description.trim() || null,
      brandColor: brandColor || null,
      attachmentMaxBytes
    });
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center gap-2">
        <Settings className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">{localize({ en: "Company Settings", zh: "公司设置" })}</h1>
      </div>

      {/* General */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {localize({ en: "General", zh: "通用" })}
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <Field
            label={localize({ en: "Company name", zh: "公司名称" })}
            hint={localize({ en: "The display name for your company.", zh: "公司的显示名称。" })}
          >
            <input
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              type="text"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
            />
          </Field>
          <Field
            label={localize({ en: "Description", zh: "描述" })}
            hint={localize({ en: "Optional description shown in the company profile.", zh: "显示在公司资料中的可选描述。" })}
          >
            <input
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              type="text"
              value={description}
              placeholder={localize({ en: "Optional company description", zh: "可选公司描述" })}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
        </div>
      </div>

      {/* Appearance */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {localize({ en: "Appearance", zh: "外观" })}
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <div className="flex items-start gap-4">
            <div className="shrink-0">
              <CompanyPatternIcon
                companyName={companyName || selectedCompany.name}
                logoUrl={logoUrl || null}
                brandColor={brandColor || null}
                className="rounded-[14px]"
              />
            </div>
            <div className="flex-1 space-y-3">
              <Field
                label={localize({ en: "Logo", zh: "Logo" })}
                hint={localize({ en: "Upload a PNG, JPEG, WEBP, GIF, or SVG logo image.", zh: "上传 PNG、JPEG、WEBP、GIF 或 SVG Logo 图片。" })}
              >
                <div className="space-y-2">
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                    onChange={handleLogoFileChange}
                    className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none file:mr-4 file:rounded-md file:border-0 file:bg-muted file:px-2.5 file:py-1 file:text-xs"
                  />
                  {logoUrl && (
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={handleClearLogo}
                        disabled={clearLogoMutation.isPending}
                      >
                        {clearLogoMutation.isPending
                          ? localize({ en: "Removing...", zh: "正在移除..." })
                          : localize({ en: "Remove logo", zh: "移除 Logo" })}
                      </Button>
                    </div>
                  )}
                  {(logoUploadMutation.isError || logoUploadError) && (
                    <span className="text-xs text-destructive">
                      {logoUploadError ??
                        (logoUploadMutation.error instanceof Error
                          ? logoUploadMutation.error.message
                          : localize({ en: "Logo upload failed", zh: "Logo 上传失败" }))}
                    </span>
                  )}
                  {clearLogoMutation.isError && (
                    <span className="text-xs text-destructive">
                      {clearLogoMutation.error.message}
                    </span>
                  )}
                  {logoUploadMutation.isPending && (
                    <span className="text-xs text-muted-foreground">{localize({ en: "Uploading logo...", zh: "正在上传 Logo..." })}</span>
                  )}
                </div>
              </Field>
              <Field
                label={localize({ en: "Brand color", zh: "品牌颜色" })}
                hint={localize({ en: "Sets the hue for the company icon. Leave empty for auto-generated color.", zh: "设置公司图标色调。留空则自动生成颜色。" })}
              >
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={brandColor || "#6366f1"}
                    onChange={(e) => setBrandColor(e.target.value)}
                    className="h-8 w-8 cursor-pointer rounded border border-border bg-transparent p-0"
                  />
                  <input
                    type="text"
                    value={brandColor}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === "" || /^#[0-9a-fA-F]{0,6}$/.test(v)) {
                        setBrandColor(v);
                      }
                    }}
                    placeholder={localize({ en: "Auto", zh: "自动" })}
                    className="w-28 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm font-mono outline-none"
                  />
                  {brandColor && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setBrandColor("")}
                      className="text-xs text-muted-foreground"
                    >
                      {localize({ en: "Clear", zh: "清除" })}
                    </Button>
                  )}
                </div>
              </Field>
              <Field
                label={localize({ en: "Attachment size limit", zh: "附件大小上限" })}
                hint={localize({
                  en: `Accepted range: 1-${MAX_COMPANY_ATTACHMENT_MAX_MIB} MiB.`,
                  zh: `可接受范围：1-${MAX_COMPANY_ATTACHMENT_MAX_MIB} MiB。`,
                })}
              >
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={1}
                      max={MAX_COMPANY_ATTACHMENT_MAX_MIB}
                      step={1}
                      value={attachmentMaxMiB}
                      onChange={(e) => setAttachmentMaxMiB(e.target.value)}
                      className="w-28 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                    />
                    <span className="text-xs text-muted-foreground">MiB</span>
                  </div>
                  {!attachmentMaxValid && (
                    <span className="text-xs text-destructive">
                      {localize({
                        en: `Enter a whole number from 1 to ${MAX_COMPANY_ATTACHMENT_MAX_MIB}.`,
                        zh: `请输入 1 到 ${MAX_COMPANY_ATTACHMENT_MAX_MIB} 之间的整数。`,
                      })}
                    </span>
                  )}
                </div>
              </Field>
            </div>
          </div>
        </div>
      </div>

      {/* Save button for General + Appearance */}
      {generalDirty && (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={handleSaveGeneral}
            disabled={generalMutation.isPending || !companyName.trim() || !attachmentMaxValid}
          >
            {generalMutation.isPending
              ? localize({ en: "Saving...", zh: "正在保存..." })
              : localize({ en: "Save changes", zh: "保存更改" })}
          </Button>
          {generalMutation.isSuccess && (
            <span className="text-xs text-muted-foreground">{localize({ en: "Saved", zh: "已保存" })}</span>
          )}
          {generalMutation.isError && (
            <span className="text-xs text-destructive">
              {generalMutation.error instanceof Error
                  ? generalMutation.error.message
                  : localize({ en: "Failed to save", zh: "保存失败" })}
            </span>
          )}
        </div>
      )}

      {/* Hiring */}
      <div className="space-y-4" data-testid="company-settings-team-section">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {localize({ en: "Hiring", zh: "招聘" })}
        </div>
        <div className="rounded-md border border-border px-4 py-3">
          <ToggleField
            label={localize({ en: "Require board approval for new hires", zh: "新 Agent 入职需要董事会批准" })}
            hint={localize({ en: "New agent hires stay pending until approved by board.", zh: "新招聘的 Agent 会保持待处理，直到董事会批准。" })}
            checked={!!selectedCompany.requireBoardApprovalForNewAgents}
            onChange={(v) => settingsMutation.mutate(v)}
            toggleTestId="company-settings-team-approval-toggle"
          />
        </div>
      </div>

      {/* Import / Export */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {localize({ en: "Company Packages", zh: "公司包" })}
        </div>
        <div className="rounded-md border border-border px-4 py-4">
          <p className="text-sm text-muted-foreground">
            {localize({
              en: "Import and export have moved to dedicated pages accessible from the ",
              zh: "导入和导出已移到专门页面，可从",
            })}
            <a href="/org" className="underline hover:text-foreground">
              {localize({ en: "Org Chart", zh: "组织图" })}
            </a>
            {localize({ en: " header.", zh: "页头进入。" })}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {cloudSyncEnabled ? (
              <Button size="sm" asChild>
                <a href="/company/settings/cloud-upstream">
                  <CloudUpload className="mr-1.5 h-3.5 w-3.5" />
                  {localize({ en: "Send to cloud", zh: "发送到云端" })}
                </a>
              </Button>
            ) : null}
            <Button size="sm" variant="outline" asChild>
              <a href="/company/export">
                <Download className="mr-1.5 h-3.5 w-3.5" />
                {localize({ en: "Export", zh: "导出" })}
              </a>
            </Button>
            <Button size="sm" variant="outline" asChild>
              <a href="/company/import">
                <Upload className="mr-1.5 h-3.5 w-3.5" />
                {localize({ en: "Import", zh: "导入" })}
              </a>
            </Button>
          </div>
        </div>
      </div>

      {/* Danger Zone */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-destructive uppercase tracking-wide">
          {localize({ en: "Danger Zone", zh: "危险区" })}
        </div>
        <div className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-4">
          <p className="text-sm text-muted-foreground">
            {localize({
              en: "Archive this company to hide it from the sidebar. This persists in the database.",
              zh: "归档此公司会将其从侧边栏隐藏，并会持久写入数据库。",
            })}
          </p>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="destructive"
              disabled={
                archiveMutation.isPending ||
                selectedCompany.status === "archived"
              }
              onClick={() => {
                if (!selectedCompanyId) return;
                const confirmed = window.confirm(
                  localize({
                    en: `Archive company "${selectedCompany.name}"? It will be hidden from the sidebar.`,
                    zh: `归档公司“${selectedCompany.name}”？它会从侧边栏隐藏。`,
                  })
                );
                if (!confirmed) return;
                const nextCompanyId =
                  companies.find(
                    (company) =>
                      company.id !== selectedCompanyId &&
                      company.status !== "archived"
                  )?.id ?? null;
                archiveMutation.mutate({
                  companyId: selectedCompanyId,
                  nextCompanyId
                });
              }}
            >
              {archiveMutation.isPending
                ? localize({ en: "Archiving...", zh: "正在归档..." })
                : selectedCompany.status === "archived"
                ? localize({ en: "Already archived", zh: "已归档" })
                : localize({ en: "Archive company", zh: "归档公司" })}
            </Button>
            {archiveMutation.isError && (
              <span className="text-xs text-destructive">
                {archiveMutation.error instanceof Error
                  ? archiveMutation.error.message
                  : localize({ en: "Failed to archive company", zh: "归档公司失败" })}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
